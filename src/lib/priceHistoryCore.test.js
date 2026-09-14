import { describe, it, expect } from 'vitest'
import {
  CURRENCIES,
  HISTORY_DAYS,
  NO_PRICE,
  SERIES_COLUMNS,
  STAGING_SPAN,
  daysBetween,
  fillSlots,
  foldEntryInto,
  globallyMissingSlots,
  mergeAccumulators,
  newSeries,
  rowFromAccumulator,
  stagingBase,
  toCents,
  windowStart,
  wireRow,
} from '../../scripts/lib/price-history-core.mjs'

// The ingest folds MTGJSON's sparse date->price maps into index-aligned arrays
// of integer cents, one pair of columns per marketplace. These run without the
// 143 MB bulk file.
//
// Fixtures are shaped exactly like the real export, verified against MTGJSON on
// 2026-09-13/14: paper.<provider>.retail.{normal,foil}["YYYY-MM-DD"] = price.

const entry = {
  paper: {
    cardmarket: {
      currency: 'EUR',
      buylist: {},
      retail: { normal: { '2026-09-01': 4.0, '2026-09-02': 4.5 }, foil: { '2026-09-02': 9.0 } },
    },
    tcgplayer: {
      currency: 'USD',
      retail: { normal: { '2026-09-01': 5.0 }, foil: { '2026-09-02': 11.0 }, etched: { '2026-09-02': 40 } },
    },
    cardkingdom: { retail: { normal: { '2026-09-01': 99 } } },
  },
}

const BASE = '2026-09-01'
const SPAN = 8

/** Fold an entry into a fresh accumulator anchored at BASE. */
const fold = (e, stats) => foldEntryInto(null, e, BASE, SPAN, stats)

/** A row's column as plain numbers and nulls, the way it reaches Postgres. */
const wire = (acc, days = 3, start = BASE) => wireRow(rowFromAccumulator('sid', acc, BASE, start, days))

describe('daysBetween', () => {
  it('counts whole days', () => {
    expect(daysBetween('2026-09-01', '2026-09-01')).toBe(0)
    expect(daysBetween('2026-09-01', '2026-09-10')).toBe(9)
    expect(daysBetween('2026-09-10', '2026-09-01')).toBe(-9)
  })

  it('does not repeat or skip a day across a DST boundary', () => {
    // Europe/Sofia falls back on 2026-10-25. Local-date arithmetic double-counts
    // that day, which is the bug the traffic charts hit — hence UTC.
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2)
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2)
  })
})

describe('windowStart', () => {
  it('anchors the window so the newest day is the last slot', () => {
    expect(daysBetween(windowStart('2026-09-13', 60), '2026-09-13')).toBe(59)
  })
})

describe('toCents', () => {
  it('rounds to whole cents', () => {
    expect(toCents(1.23456)).toBe(123)
    expect(toCents(4.02)).toBe(402)
  })

  it('rejects non-prices and zero', () => {
    for (const bad of [0, -1, null, undefined, 'x', NaN, Infinity]) {
      expect(toCents(bad)).toBe(NO_PRICE)
    }
  })
})

// ── Staging window ──────────────────────────────────────────────────────────
// Folding on arrival needs a day zero before the newest published date is
// known, so the arrays are anchored on MTGJSON's own build date with slack
// either side. The slack is what makes the anchor safe; the script asserts the
// real window landed inside it.

describe('stagingBase', () => {
  it('leaves room for a window ending on the build date', () => {
    const base = stagingBase('2026-09-13')
    expect(daysBetween(base, windowStart('2026-09-13', HISTORY_DAYS))).toBeGreaterThanOrEqual(0)
    expect(daysBetween(base, '2026-09-13')).toBeLessThan(STAGING_SPAN)
  })

  it('still holds the window when the feed is weeks stale', () => {
    // A build that shipped without fresh prices must not silently lose days off
    // the start of the window.
    const base = stagingBase('2026-09-13')
    const latest = '2026-07-20'                     // 55 days behind the build
    expect(daysBetween(base, windowStart(latest, HISTORY_DAYS))).toBeGreaterThanOrEqual(0)
  })

  it('leaves room for prices dated after the build', () => {
    expect(daysBetween(stagingBase('2026-09-13'), '2026-09-20')).toBeLessThan(STAGING_SPAN)
  })
})

// ── Marketplaces ────────────────────────────────────────────────────────────
// PRICE_SOURCES offers Cardmarket (EUR) and TCGplayer (USD); the chart follows
// whichever the user selected. MTGJSON also carries cardkingdom, manapool, a
// buylist per provider, and a TCGplayer `etched` finish — none stored, because
// no PRICE_SOURCES entry can display them and each series costs ~24 MB.

describe('foldEntryInto', () => {
  it('places each price at its offset from the staging base', () => {
    const acc = fold({ paper: { cardmarket: { retail: { normal: { '2026-09-01': 1.5, '2026-09-03': 2.5 } } } } })
    expect([...acc.prices_eur.slice(0, 4)]).toEqual([150, NO_PRICE, 250, NO_PRICE])
  })

  it('keeps exactly the two marketplaces the app can price in', () => {
    expect(Object.keys(fold(entry)).sort()).toEqual([...SERIES_COLUMNS].sort())
  })

  it('never reads a provider or finish nothing can display', () => {
    // ~1,200 printings carry the TCGplayer etched finish, and PRICE_SOURCES has
    // no etched entry, so there is no surface that could show it.
    const acc = fold(entry)
    expect(JSON.stringify(wire(acc))).not.toContain('99')      // cardkingdom
    expect(JSON.stringify(wire(acc))).not.toContain('40')      // etched
    expect(Object.keys(acc)).not.toContain('prices_usd_etched')
  })

  it('allocates nothing for an entry with no storable provider', () => {
    expect(fold({ paper: { cardkingdom: { retail: { normal: { '2026-09-01': 1 } } } } })).toBe(null)
    expect(fold({})).toBe(null)
  })

  it('allocates only the marketplace that priced the card', () => {
    // ~4,600 printings have Cardmarket but no TCGplayer, and vice versa. An
    // unpriced marketplace must not cost an array.
    const acc = fold({ paper: { tcgplayer: { retail: { normal: { '2026-09-01': 3 } } } } })
    expect(Object.keys(acc)).toEqual(['prices_usd'])
  })

  it('skips non-prices and zero without allocating', () => {
    expect(fold({ paper: { cardmarket: { retail: { normal: { '2026-09-01': 0, '2026-09-02': null } } } } })).toBe(null)
  })

  it('reports the newest date anywhere, in range or not', () => {
    // The window is derived from this, so a date the staging span cannot hold
    // still has to be seen — that is how a wrong anchor is detected.
    const stats = { latest: null, outOfRange: 0 }
    fold({ paper: { cardmarket: { retail: { normal: { '2026-09-02': 1 }, foil: { '2027-01-01': 2 } } } } }, stats)
    expect(stats.latest).toBe('2027-01-01')
    expect(stats.outOfRange).toBe(1)
  })

  it('drops dates outside the staging window instead of misplacing them', () => {
    const stats = { latest: null, outOfRange: 0 }
    const acc = fold({ paper: { cardmarket: { retail: { normal: { '2026-08-01': 99, '2026-09-02': 3 } } } } }, stats)
    expect([...acc.prices_eur.slice(0, 3)]).toEqual([NO_PRICE, 300, NO_PRICE])
    expect(stats.outOfRange).toBe(1)
  })
})

describe('rowFromAccumulator', () => {
  const acc = fold(entry)

  it('fills a column pair per marketplace, in its own currency', () => {
    const row = wire(acc)
    expect(row.prices_eur).toEqual([4.0, 4.5, null])
    expect(row.prices_foil_eur).toEqual([null, 9.0, null])
    expect(row.prices_usd).toEqual([5.0, null, null])
    expect(row.prices_usd_foil).toEqual([null, 11.0, null])
  })

  it('leaves a missing day null rather than carrying the last price forward', () => {
    // A gap is real information: nobody listed the card. Filling it invents a
    // flat line that reads as market data and would feed a spike alert a number
    // nobody ever quoted.
    const sparse = fold({ paper: { cardmarket: { retail: { normal: { '2026-09-01': 10, '2026-09-05': 12 } } } } })
    expect(wire(sparse, 5).prices_eur).toEqual([10, null, null, null, 12])
  })

  it('keeps a card priced by only one marketplace', () => {
    const usdOnly = fold({ paper: { tcgplayer: { retail: { normal: { '2026-09-01': 3 } } } } })
    const row = wire(usdOnly, 2)
    expect(row.prices_eur).toBe(null)
    expect(row.prices_usd).toEqual([3, null])
  })

  it('returns null when no marketplace prices the card', () => {
    expect(rowFromAccumulator('sid-3', null, BASE, BASE, 2)).toBe(null)
    expect(rowFromAccumulator('sid-4', {}, BASE, BASE, 2)).toBe(null)
  })

  it('returns null when the card has no price inside the shared window', () => {
    // The staged array is 8 days wide but the window may end before the card's
    // only price — that row is nothing but nulls and should not be written.
    const late = fold({ paper: { cardmarket: { retail: { normal: { '2026-09-06': 7 } } } } })
    expect(rowFromAccumulator('sid', late, BASE, BASE, 3)).toBe(null)
  })

  it('cuts the window out at its offset from the staging base', () => {
    const row = wire(acc, 2, '2026-09-02')
    expect(row.start_date).toBe('2026-09-02')
    expect(row.prices_eur).toEqual([4.5, null])
  })

  it('copies rather than views the staging buffer', () => {
    // A subarray view would keep the whole ~128-day staging array alive behind
    // every row, which is the allocation this rewrite exists to remove.
    const row = rowFromAccumulator('sid', acc, BASE, BASE, 3)
    expect(row.prices_eur.buffer.byteLength).toBe(3 * 4)
  })

  it('anchors every row to the shared start date', () => {
    const row = rowFromAccumulator('sid-5', fold(entry, null), BASE, BASE, HISTORY_DAYS)
    expect(row.start_date).toBe(BASE)
    expect(row.prices_eur).toHaveLength(HISTORY_DAYS)
    expect(row.prices_usd).toHaveLength(HISTORY_DAYS)
  })

  it('covers every column CURRENCIES declares', () => {
    const row = rowFromAccumulator('sid-6', acc, BASE, BASE, 2)
    for (const c of CURRENCIES) {
      expect(row).toHaveProperty(c.column)
      expect(row).toHaveProperty(c.foilColumn)
    }
  })
})

describe('wireRow', () => {
  it('turns cents back into a currency amount', () => {
    const acc = fold({ paper: { cardmarket: { retail: { normal: { '2026-09-01': 1.23456, '2026-09-02': 1234.5 } } } } })
    expect(wire(acc, 2).prices_eur).toEqual([1.23, 1234.5])
  })

  it('writes a gap as null, not as the sentinel', () => {
    const acc = fold({ paper: { cardmarket: { retail: { normal: { '2026-09-02': 5 } } } } })
    const row = wire(acc, 2)
    expect(row.prices_eur).toEqual([null, 5])
    expect(row.prices_usd).toBe(null)
  })
})

// ── Variant merging ─────────────────────────────────────────────────────────
// The uuid -> Scryfall id mapping is MANY-TO-ONE: etched and foil variants get
// their own uuids where Scryfall keeps a single id. Unmerged, a batch carries
// the same scryfall_id twice and Postgres rejects the whole statement with
// "ON CONFLICT DO UPDATE command cannot affect row a second time" — which is
// how this was found, on a real 101,401-row run.

describe('mergeAccumulators', () => {
  const normalVariant = () => fold({ paper: { cardmarket: { retail: { normal: { '2026-09-01': 4 } } } } })
  const foilVariant = () => fold({ paper: { cardmarket: { retail: { foil: { '2026-09-01': 12 } } } } })

  it('combines two variants of one printing instead of one overwriting the other', () => {
    // The usual real case: one uuid carries the normal series, the other the
    // foil. Last-one-wins would silently drop half the card's history.
    const acc = mergeAccumulators(normalVariant(), foilVariant())
    const row = wire(acc, 2)
    expect(row.prices_eur).toEqual([4, null])
    expect(row.prices_foil_eur).toEqual([12, null])
  })

  it('merges across marketplaces too', () => {
    const acc = mergeAccumulators(
      normalVariant(),
      fold({ paper: { tcgplayer: { retail: { normal: { '2026-09-01': 6 } } } } }),
    )
    const row = wire(acc, 1)
    expect(row.prices_eur).toEqual([4])
    expect(row.prices_usd).toEqual([6])
  })

  it('fills a day one variant is missing from the other', () => {
    const acc = mergeAccumulators(
      normalVariant(),
      fold({ paper: { cardmarket: { retail: { normal: { '2026-09-02': 7 } } } } }),
    )
    expect(wire(acc, 2).prices_eur).toEqual([4, 7])
  })

  it('keeps the first value when both variants price the same day', () => {
    const acc = mergeAccumulators(
      normalVariant(),
      fold({ paper: { cardmarket: { retail: { normal: { '2026-09-01': 99 } } } } }),
    )
    expect(wire(acc, 1).prices_eur).toEqual([4])
  })

  it('adopts the other side when either is absent', () => {
    expect(mergeAccumulators(null, null)).toBe(null)
    const only = normalVariant()
    expect(mergeAccumulators(null, only)).toBe(only)
    expect(mergeAccumulators(only, null)).toBe(only)
  })
})

// ── Source outages vs card-specific absence ─────────────────────────────────
// Measured 2026-09-13: five days in the 60-day window had a Cardmarket price
// for ZERO of 20,000 sampled cards — 2026-08-06, 08-29, and the run 08-31 /
// 09-01 / 09-02. No weekend pattern (Thu, Sat, Mon, Tue, Wed), so they are
// failed MTGJSON builds. A day THIS card lacks is a real gap; a day NOBODY has
// is our plumbing. Computed per column, since a Cardmarket outage is not
// necessarily a TCGplayer one.

/** A series literal, `null` standing in for a day with no price. */
const series = values => Int32Array.from(values.map(v => (v == null ? NO_PRICE : v)))

describe('globallyMissingSlots', () => {
  it('finds only the slots no card prices', () => {
    expect([...globallyMissingSlots([series([1, null, null, 4]), series([2, 3, null, 5])], 4)]).toEqual([2])
  })

  it('ignores an absent series entirely', () => {
    expect([...globallyMissingSlots([null, series([1, null])], 2)]).toEqual([1])
  })

  it('is empty when every slot is covered somewhere', () => {
    expect(globallyMissingSlots([series([1, null]), series([null, 2])], 2).size).toBe(0)
  })
})

describe('fillSlots', () => {
  it('interpolates across a three-day source outage', () => {
    const s = series([1000, null, null, null, 1400])
    fillSlots(s, new Set([1, 2, 3]))
    expect([...s]).toEqual([1000, 1100, 1200, 1300, 1400])
  })

  it('leaves a card-specific gap alone even when adjacent to an outage', () => {
    const s = series([1000, null, null, 1300])
    fillSlots(s, new Set([1]))
    expect(s[2]).toBe(NO_PRICE)
  })

  it('does not invent a leading or trailing value', () => {
    const leading = series([null, null, 500])
    fillSlots(leading, new Set([0, 1]))
    expect([...leading.slice(0, 2)]).toEqual([NO_PRICE, NO_PRICE])

    const trailing = series([500, null])
    fillSlots(trailing, new Set([1]))
    expect(trailing[1]).toBe(NO_PRICE)
  })

  it('interpolates in whole cents', () => {
    const s = series([100, null, 101])
    fillSlots(s, new Set([1]))
    expect(Number.isInteger(s[1])).toBe(true)
  })

  it('is a no-op with nothing missing', () => {
    const s = series([1, 2, 3])
    expect([...fillSlots(s, new Set())]).toEqual([1, 2, 3])
    expect(fillSlots(null, new Set([0]))).toBe(null)
  })
})

describe('newSeries', () => {
  it('starts every day empty', () => {
    expect([...newSeries(3)]).toEqual([NO_PRICE, NO_PRICE, NO_PRICE])
  })

  it('costs four bytes a day', () => {
    // The whole point of the rewrite: ~101k printings × up to four series.
    expect(newSeries(STAGING_SPAN).buffer.byteLength).toBe(STAGING_SPAN * 4)
  })
})

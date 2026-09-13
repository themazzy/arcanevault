import { describe, it, expect } from 'vitest'
import {
  CURRENCIES,
  HISTORY_DAYS,
  daysBetween,
  fillSlots,
  globallyMissingSlots,
  hasStorableRetail,
  latestDateInAccumulator,
  mergeRetailBlockInto,
  retailBlocks,
  rowFromAccumulator,
  seriesFromDateMap,
  windowStart,
} from '../../scripts/lib/price-history-core.mjs'

// The ingest turns MTGJSON's sparse date->price maps into index-aligned arrays,
// one pair of columns per marketplace. These run without the 143 MB bulk file.
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

describe('seriesFromDateMap', () => {
  const start = '2026-09-01'

  it('places each price at its date offset', () => {
    expect(seriesFromDateMap({ '2026-09-01': 1.5, '2026-09-03': 2.5 }, start, 5))
      .toEqual([1.5, null, 2.5, null, null])
  })

  it('leaves a missing day null rather than carrying the last price forward', () => {
    // A gap is real information: nobody listed the card. Filling it invents a
    // flat line that reads as market data and would feed a spike alert a number
    // nobody ever quoted.
    const s = seriesFromDateMap({ '2026-09-01': 10, '2026-09-05': 12 }, start, 5)
    expect(s.slice(1, 4)).toEqual([null, null, null])
  })

  it('drops dates outside the window instead of misplacing them', () => {
    expect(seriesFromDateMap({ '2026-08-01': 99, '2026-09-02': 3, '2027-01-01': 99 }, start, 5))
      .toEqual([null, 3, null, null, null])
  })

  it('ignores non-prices and zero', () => {
    expect(seriesFromDateMap({ '2026-09-01': 0, '2026-09-02': null, '2026-09-03': 'x', '2026-09-04': 4 }, start, 5))
      .toEqual([null, null, null, 4, null])
  })

  it('returns null when nothing lands in the window, so the column is omitted', () => {
    expect(seriesFromDateMap({ '2020-01-01': 5 }, start, 5)).toBe(null)
    expect(seriesFromDateMap({}, start, 5)).toBe(null)
    expect(seriesFromDateMap(null, start, 5)).toBe(null)
  })

  it('rounds to cents', () => {
    expect(seriesFromDateMap({ '2026-09-01': 1.23456 }, start, 2)[0]).toBe(1.23)
  })
})

// ── Marketplaces ────────────────────────────────────────────────────────────
// PRICE_SOURCES offers Cardmarket (EUR) and TCGplayer (USD); the chart follows
// whichever the user selected. MTGJSON also carries cardkingdom, manapool, a
// buylist per provider, and a TCGplayer `etched` finish — none stored, because
// no PRICE_SOURCES entry can display them and each series costs ~24 MB.

describe('retailBlocks', () => {
  it('keeps exactly the two marketplaces the app can price in', () => {
    expect(Object.keys(retailBlocks(entry)).sort()).toEqual(['eur', 'usd'])
  })

  it('drops providers nothing can display', () => {
    const kept = retailBlocks(entry)
    expect(JSON.stringify(kept)).not.toContain('99')     // cardkingdom
  })

  it('is empty for an entry with no storable provider', () => {
    expect(retailBlocks({ paper: { cardkingdom: { retail: { normal: { '2026-09-01': 1 } } } } })).toEqual({})
  })
})

describe('hasStorableRetail', () => {
  it('accepts a card priced by either marketplace', () => {
    expect(hasStorableRetail(entry)).toBe(true)
    expect(hasStorableRetail({ paper: { tcgplayer: { retail: { normal: { '2026-09-01': 1 } } } } })).toBe(true)
  })

  it('rejects one priced only by a provider we do not store', () => {
    expect(hasStorableRetail({ paper: { cardkingdom: { retail: { normal: { '2026-09-01': 1 } } } } })).toBe(false)
    expect(hasStorableRetail({})).toBe(false)
  })
})

describe('rowFromAccumulator', () => {
  const acc = mergeRetailBlockInto(null, retailBlocks(entry))

  it('fills a column pair per marketplace, in its own currency', () => {
    const row = rowFromAccumulator('sid-1', acc, '2026-09-01', 3)
    expect(row.prices_eur).toEqual([4.0, 4.5, null])
    expect(row.prices_foil_eur).toEqual([null, 9.0, null])
    expect(row.prices_usd).toEqual([5.0, null, null])
    expect(row.prices_usd_foil).toEqual([null, 11.0, null])
  })

  it('does not store the TCGplayer etched finish', () => {
    // ~1,200 printings carry it, and PRICE_SOURCES has no etched entry, so
    // there is no surface that could show it.
    const row = rowFromAccumulator('sid-1', acc, '2026-09-01', 3)
    expect(Object.keys(row)).not.toContain('prices_usd_etched')
    expect(JSON.stringify(row)).not.toContain('40')
  })

  it('keeps a card priced by only one marketplace', () => {
    // ~4,600 printings have Cardmarket but no TCGplayer, and vice versa.
    const usdOnly = mergeRetailBlockInto(null, retailBlocks({
      paper: { tcgplayer: { retail: { normal: { '2026-09-01': 3 } } } },
    }))
    const row = rowFromAccumulator('sid-2', usdOnly, '2026-09-01', 2)
    expect(row.prices_eur).toBe(null)
    expect(row.prices_usd).toEqual([3, null])
  })

  it('returns null when no marketplace prices the card', () => {
    expect(rowFromAccumulator('sid-3', null, '2026-09-01', 2)).toBe(null)
    expect(rowFromAccumulator('sid-4', {}, '2026-09-01', 2)).toBe(null)
  })

  it('anchors every row to the shared start date', () => {
    const row = rowFromAccumulator('sid-5', acc, '2026-09-01', HISTORY_DAYS)
    expect(row.start_date).toBe('2026-09-01')
    expect(row.prices_eur).toHaveLength(HISTORY_DAYS)
    expect(row.prices_usd).toHaveLength(HISTORY_DAYS)
  })

  it('covers every column CURRENCIES declares', () => {
    const row = rowFromAccumulator('sid-6', acc, '2026-09-01', 2)
    for (const c of CURRENCIES) {
      expect(row).toHaveProperty(c.column)
      expect(row).toHaveProperty(c.foilColumn)
    }
  })
})

// ── Variant merging ─────────────────────────────────────────────────────────
// The uuid -> Scryfall id mapping is MANY-TO-ONE: etched and foil variants get
// their own uuids where Scryfall keeps a single id. Unmerged, a batch carries
// the same scryfall_id twice and Postgres rejects the whole statement with
// "ON CONFLICT DO UPDATE command cannot affect row a second time" — which is
// how this was found, on a real 101,401-row run.

describe('mergeRetailBlockInto', () => {
  const normalVariant = retailBlocks({ paper: { cardmarket: { retail: { normal: { '2026-09-01': 4 } } } } })
  const foilVariant = retailBlocks({ paper: { cardmarket: { retail: { foil: { '2026-09-01': 12 } } } } })

  it('combines two variants of one printing instead of one overwriting the other', () => {
    // The usual real case: one uuid carries the normal series, the other the
    // foil. Last-one-wins would silently drop half the card's history.
    let acc = mergeRetailBlockInto(null, normalVariant)
    acc = mergeRetailBlockInto(acc, foilVariant)
    const row = rowFromAccumulator('sid', acc, '2026-09-01', 2)
    expect(row.prices_eur).toEqual([4, null])
    expect(row.prices_foil_eur).toEqual([12, null])
  })

  it('merges across marketplaces too', () => {
    let acc = mergeRetailBlockInto(null, normalVariant)
    acc = mergeRetailBlockInto(acc, retailBlocks({
      paper: { tcgplayer: { retail: { normal: { '2026-09-01': 6 } } } },
    }))
    const row = rowFromAccumulator('sid', acc, '2026-09-01', 1)
    expect(row.prices_eur).toEqual([4])
    expect(row.prices_usd).toEqual([6])
  })

  it('keeps the first value when both variants price the same day', () => {
    let acc = mergeRetailBlockInto(null, normalVariant)
    acc = mergeRetailBlockInto(acc, retailBlocks({
      paper: { cardmarket: { retail: { normal: { '2026-09-01': 99 } } } },
    }))
    expect(rowFromAccumulator('sid', acc, '2026-09-01', 1).prices_eur).toEqual([4])
  })

  it('ignores an entry with no storable block', () => {
    expect(mergeRetailBlockInto(null, {})).toBe(null)
  })
})

describe('latestDateInAccumulator', () => {
  it('takes the newest date across both finishes and both marketplaces', () => {
    let acc = mergeRetailBlockInto(null, retailBlocks({
      paper: { cardmarket: { retail: { normal: { '2026-09-01': 1 } } } },
    }))
    acc = mergeRetailBlockInto(acc, retailBlocks({
      paper: { tcgplayer: { retail: { foil: { '2026-09-11': 2 } } } },
    }))
    expect(latestDateInAccumulator(acc)).toBe('2026-09-11')
  })

  it('is null for an empty accumulator', () => {
    expect(latestDateInAccumulator(null)).toBe(null)
  })
})

// ── Source outages vs card-specific absence ─────────────────────────────────
// Measured 2026-09-13: five days in the 60-day window had a Cardmarket price
// for ZERO of 20,000 sampled cards — 2026-08-06, 08-29, and the run 08-31 /
// 09-01 / 09-02. No weekend pattern (Thu, Sat, Mon, Tue, Wed), so they are
// failed MTGJSON builds. A day THIS card lacks is a real gap; a day NOBODY has
// is our plumbing. Computed per column, since a Cardmarket outage is not
// necessarily a TCGplayer one.

describe('globallyMissingSlots', () => {
  it('finds only the slots no card prices', () => {
    expect([...globallyMissingSlots([[1, null, null, 4], [2, 3, null, 5]], 4)]).toEqual([2])
  })

  it('ignores a null series entirely', () => {
    expect([...globallyMissingSlots([null, [1, null]], 2)]).toEqual([1])
  })

  it('is empty when every slot is covered somewhere', () => {
    expect(globallyMissingSlots([[1, null], [null, 2]], 2).size).toBe(0)
  })
})

describe('fillSlots', () => {
  it('interpolates across a three-day source outage', () => {
    const series = [10, null, null, null, 14]
    fillSlots(series, new Set([1, 2, 3]))
    expect(series).toEqual([10, 11, 12, 13, 14])
  })

  it('leaves a card-specific gap alone even when adjacent to an outage', () => {
    const series = [10, null, null, 13]
    fillSlots(series, new Set([1]))
    expect(series[2]).toBe(null)
  })

  it('does not invent a leading or trailing value', () => {
    const leading = [null, null, 5]
    fillSlots(leading, new Set([0, 1]))
    expect(leading.slice(0, 2)).toEqual([null, null])

    const trailing = [5, null]
    fillSlots(trailing, new Set([1]))
    expect(trailing[1]).toBe(null)
  })

  it('is a no-op with nothing missing', () => {
    expect(fillSlots([1, 2, 3], new Set())).toEqual([1, 2, 3])
    expect(fillSlots(null, new Set([0]))).toBe(null)
  })
})

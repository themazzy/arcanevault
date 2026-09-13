import { describe, it, expect } from 'vitest'
import {
  HISTORY_DAYS,
  daysBetween,
  latestDateIn,
  priceHistoryRow,
  seriesFromDateMap,
  windowStart,
} from '../../scripts/lib/price-history-core.mjs'

// The ingest turns MTGJSON's sparse date->price maps into index-aligned arrays.
// Everything that decides what the chart draws lives here, so it is tested
// without the 143 MB bulk file.

describe('daysBetween', () => {
  it('counts whole days', () => {
    expect(daysBetween('2026-09-01', '2026-09-01')).toBe(0)
    expect(daysBetween('2026-09-01', '2026-09-10')).toBe(9)
    expect(daysBetween('2026-09-10', '2026-09-01')).toBe(-9)
  })

  it('does not repeat or skip a day across a DST boundary', () => {
    // Europe/Sofia falls back on 2026-10-25. Local-date arithmetic double-counts
    // that day, which is exactly the bug the traffic charts hit — hence UTC.
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2)
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2)
  })
})

describe('windowStart', () => {
  it('anchors the window so the newest day is the last slot', () => {
    const start = windowStart('2026-09-13', 90)
    expect(daysBetween(start, '2026-09-13')).toBe(89)
  })
})

describe('seriesFromDateMap', () => {
  const start = '2026-09-01'

  it('places each price at its date offset', () => {
    const s = seriesFromDateMap({ '2026-09-01': 1.5, '2026-09-03': 2.5 }, start, 5)
    expect(s).toEqual([1.5, null, 2.5, null, null])
  })

  it('leaves a missing day null rather than carrying the last price forward', () => {
    // A gap is real information: Cardmarket had no listing. Filling it invents
    // a flat line that reads as market data and would feed a spike alert a
    // number nobody ever quoted.
    const s = seriesFromDateMap({ '2026-09-01': 10, '2026-09-05': 12 }, start, 5)
    expect(s[1]).toBe(null)
    expect(s[2]).toBe(null)
    expect(s[3]).toBe(null)
  })

  it('drops dates outside the window instead of misplacing them', () => {
    const s = seriesFromDateMap({ '2026-08-01': 99, '2026-09-02': 3, '2027-01-01': 99 }, start, 5)
    expect(s).toEqual([null, 3, null, null, null])
  })

  it('ignores non-prices and zero', () => {
    const s = seriesFromDateMap({ '2026-09-01': 0, '2026-09-02': null, '2026-09-03': 'x', '2026-09-04': 4 }, start, 5)
    expect(s).toEqual([null, null, null, 4, null])
  })

  it('returns null when nothing lands in the window, so the column is omitted', () => {
    expect(seriesFromDateMap({ '2020-01-01': 5 }, start, 5)).toBe(null)
    expect(seriesFromDateMap({}, start, 5)).toBe(null)
    expect(seriesFromDateMap(null, start, 5)).toBe(null)
  })

  it('rounds to cents', () => {
    const s = seriesFromDateMap({ '2026-09-01': 1.23456 }, start, 2)
    expect(s[0]).toBe(1.23)
  })
})

describe('priceHistoryRow', () => {
  // Shaped exactly like the real file, verified against MTGJSON on 2026-09-13.
  const entry = {
    paper: {
      cardmarket: {
        currency: 'EUR',
        buylist: {},
        retail: {
          normal: { '2026-09-01': 4.0, '2026-09-02': 4.5 },
          foil: { '2026-09-02': 9.0 },
        },
      },
      tcgplayer: { currency: 'USD', retail: { normal: { '2026-09-02': 5.5 } } },
    },
  }

  it('reads Cardmarket EUR and ignores the USD providers', () => {
    // card_prices and every P&L surface are hardcoded to EUR/Cardmarket; mixing
    // a USD provider in would make the chart disagree with the collection value.
    const row = priceHistoryRow('sid-1', entry, '2026-09-01', 3)
    expect(row.prices_eur).toEqual([4.0, 4.5, null])
    expect(row.prices_foil_eur).toEqual([null, 9.0, null])
  })

  it('keeps a foil-only card', () => {
    const foilOnly = { paper: { cardmarket: { retail: { foil: { '2026-09-01': 3 } } } } }
    const row = priceHistoryRow('sid-2', foilOnly, '2026-09-01', 2)
    expect(row.prices_eur).toBe(null)
    expect(row.prices_foil_eur).toEqual([3, null])
  })

  it('returns null for a card with no Cardmarket price at all', () => {
    // ~12% of the file. These must be absent rather than stored as empty rows,
    // so the UI can say "no price history" instead of drawing a flat zero.
    expect(priceHistoryRow('sid-3', { paper: { tcgplayer: {} } }, '2026-09-01', 2)).toBe(null)
    expect(priceHistoryRow('sid-4', {}, '2026-09-01', 2)).toBe(null)
  })

  it('anchors every row to the shared start date', () => {
    const row = priceHistoryRow('sid-5', entry, '2026-09-01', HISTORY_DAYS)
    expect(row.start_date).toBe('2026-09-01')
    expect(row.prices_eur).toHaveLength(HISTORY_DAYS)
  })
})

describe('latestDateIn', () => {
  it('takes the newest date across both finishes', () => {
    const entry = { paper: { cardmarket: { retail: {
      normal: { '2026-09-01': 1 }, foil: { '2026-09-09': 2 },
    } } } }
    expect(latestDateIn(entry)).toBe('2026-09-09')
  })

  it('is null when there is no cardmarket block', () => {
    expect(latestDateIn({ paper: {} })).toBe(null)
  })
})

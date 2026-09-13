import { describe, it, expect } from 'vitest'
import { bridgeShortGaps, expandSeries, niceTicks, priceBounds, summarize, toSegments } from './priceHistory'

// The stored row is an index-aligned array with a shared origin, so a point's
// date is derived, never stored. These pin the derivation and — more
// importantly — that a missing day survives as a gap all the way to the chart.

const row = {
  start_date: '2026-09-01',
  prices_eur: [1.0, null, 1.5, 2.0],
  prices_foil_eur: [5.0, 5.5, null, null],
}

describe('expandSeries', () => {
  it('derives a date per slot from the shared origin', () => {
    expect(expandSeries(row).map(p => p.date))
      .toEqual(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'])
  })

  it('keeps a missing day as a null point instead of dropping it', () => {
    // Dropping it would slide later points left and silently redraw the shape
    // of the line — the same failure the traffic charts hit with a categorical
    // axis closing ranks over absent days.
    const pts = expandSeries(row)
    expect(pts).toHaveLength(4)
    expect(pts[1].price).toBe(null)
    expect(pts[2].price).toBe(1.5)
  })

  it('reads the foil series when asked', () => {
    expect(expandSeries(row, true).map(p => p.price)).toEqual([5.0, 5.5, null, null])
  })

  it('is empty when the finish has no stored series', () => {
    expect(expandSeries({ start_date: '2026-09-01', prices_eur: null }, false)).toEqual([])
    expect(expandSeries(null)).toEqual([])
  })

  it('does not drift a day across a DST boundary', () => {
    const dst = { start_date: '2026-10-24', prices_eur: [1, 1, 1, 1] }
    expect(expandSeries(dst).map(p => p.date))
      .toEqual(['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'])
  })
})

describe('toSegments', () => {
  it('breaks the line into runs of priced days', () => {
    // One path per run is what actually renders a gap; a single path through
    // every point would bridge the missing days with a straight line that reads
    // as real, slowly-moving market data.
    const segs = toSegments(expandSeries(row))
    expect(segs).toHaveLength(2)
    expect(segs[0].map(p => p.price)).toEqual([1.0])
    expect(segs[1].map(p => p.price)).toEqual([1.5, 2.0])
  })

  it('returns one segment when nothing is missing', () => {
    const segs = toSegments(expandSeries({ start_date: '2026-09-01', prices_eur: [1, 2, 3] }))
    expect(segs).toHaveLength(1)
    expect(segs[0]).toHaveLength(3)
  })

  it('returns nothing when every day is missing', () => {
    expect(toSegments([{ date: 'x', price: null }])).toEqual([])
  })
})

describe('summarize', () => {
  it('compares the newest priced day with the oldest priced day', () => {
    // Not slot 0, which may be a gap — anchoring there would report a change
    // against a day that had no price.
    const s = summarize(expandSeries({ start_date: '2026-09-01', prices_eur: [null, 2, 4] }))
    expect(s.first.price).toBe(2)
    expect(s.last.price).toBe(4)
    expect(s.change).toBe(2)
    expect(s.changePct).toBe(100)
    expect(s.count).toBe(2)
  })

  it('reports the window low and high', () => {
    const s = summarize(expandSeries({ start_date: '2026-09-01', prices_eur: [3, 1, 9, 4] }))
    expect(s.min).toBe(1)
    expect(s.max).toBe(9)
  })

  it('is null when nothing is priced, so the caller can say so', () => {
    expect(summarize([])).toBe(null)
    expect(summarize([{ date: 'x', price: null }])).toBe(null)
  })
})

describe('priceBounds', () => {
  it('does not force a zero baseline', () => {
    // Card prices sit far from zero; a zero floor flattens every real move.
    const b = priceBounds(20, 24)
    expect(b.lo).toBeGreaterThan(0)
    expect(b.lo).toBeLessThan(20)
    expect(b.hi).toBeGreaterThan(24)
  })

  it('never goes negative on a cheap card', () => {
    expect(priceBounds(0.05, 0.09).lo).toBeGreaterThanOrEqual(0)
  })

  it('gives a flat series a band instead of a zero-height scale', () => {
    const b = priceBounds(4, 4)
    expect(b.hi).toBeGreaterThan(b.lo)
  })

  it('is null when there is nothing to scale', () => {
    expect(priceBounds(NaN, 1)).toBe(null)
  })
})

// ── Gap bridging ────────────────────────────────────────────────────────────
// Breaking the line on every missing day shattered sparse series — foil above
// all — into confetti that read as a broken chart rather than as missing data.
// A one- or two-day hole is Cardmarket not reporting; a week without a listing
// is real information and still breaks.

describe('bridgeShortGaps', () => {
  const series = prices => expandSeries({ start_date: '2026-09-01', prices_eur: prices })

  it('fills a one-day hole by interpolation', () => {
    const out = bridgeShortGaps(series([10, null, 12]))
    expect(out[1].price).toBe(11)
    expect(out[1].estimated).toBe(true)
  })

  it('fills a two-day hole evenly', () => {
    const out = bridgeShortGaps(series([10, null, null, 13]))
    expect(out.map(p => p.price)).toEqual([10, 11, 12, 13])
  })

  it('leaves a longer gap as a real break', () => {
    const out = bridgeShortGaps(series([10, null, null, null, 14]))
    expect(out.slice(1, 4).every(p => p.price == null)).toBe(true)
    expect(toSegments(out)).toHaveLength(2)
  })

  it('marks filled points so they are never mistaken for quoted prices', () => {
    // The chart may draw through them; a spike alert must not fire on a number
    // nobody published.
    const out = bridgeShortGaps(series([10, null, 12]))
    expect(out[0].estimated).toBeUndefined()
    expect(out[2].estimated).toBeUndefined()
  })

  it('does not invent a leading value with nothing to anchor to', () => {
    const out = bridgeShortGaps(series([null, null, 12]))
    expect(out[0].price).toBe(null)
    expect(out[1].price).toBe(null)
  })

  it('leaves a trailing gap open', () => {
    const out = bridgeShortGaps(series([10, null, null]))
    expect(out[1].price).toBe(null)
    expect(out[2].price).toBe(null)
  })
})

// ── Axis ticks ──────────────────────────────────────────────────────────────
// The first version printed the padded bounds directly and produced an axis
// labelled 56.06 / 64.44 / 72.81.

describe('niceTicks', () => {
  it('chooses round values a person would pick', () => {
    for (const t of niceTicks(56.06, 72.81, 3)) {
      expect(Math.round(t * 100) / 100).toBe(t)
      expect(t % 2.5 === 0 || t % 5 === 0 || t % 10 === 0).toBe(true)
    }
  })

  it('stays inside the given bounds', () => {
    const ticks = niceTicks(56.06, 72.81, 3)
    expect(Math.min(...ticks)).toBeGreaterThanOrEqual(56.06)
    expect(Math.max(...ticks)).toBeLessThanOrEqual(72.81)
  })

  it('works on cheap cards without collapsing to one value', () => {
    expect(niceTicks(0.12, 0.48, 3).length).toBeGreaterThan(1)
  })

  it('returns nothing for a degenerate range', () => {
    expect(niceTicks(5, 5)).toEqual([])
    expect(niceTicks(NaN, 3)).toEqual([])
  })
})

import { describe, it, expect } from 'vitest'
import { hypergeomPMF, hypergeomAtLeast, expectedCount, openingHandLands } from './deckProbability'

describe('hypergeomPMF', () => {
  it('matches known values', () => {
    // 17 lands in a 40-card deck, draw 7, exactly 3
    expect(hypergeomPMF(40, 17, 7, 3)).toBeCloseTo(0.3230, 3)
    // 1 copy in 60, draw 7, exactly 1 = 7/60
    expect(hypergeomPMF(60, 1, 7, 1)).toBeCloseTo(7 / 60, 6)
  })
  it('is a valid distribution (sums to 1 over k)', () => {
    let sum = 0
    for (let k = 0; k <= 7; k++) sum += hypergeomPMF(40, 17, 7, k)
    expect(sum).toBeCloseTo(1, 6)
  })
  it('returns 0 for impossible draws', () => {
    expect(hypergeomPMF(40, 17, 7, 8)).toBe(0)   // can't draw 8 in 7
    expect(hypergeomPMF(40, 4, 7, 5)).toBe(0)    // only 4 successes exist
    expect(hypergeomPMF(0, 0, 7, 0)).toBe(0)     // empty deck guard
  })
})

describe('hypergeomAtLeast', () => {
  it('P(>=1) = 1 - P(0)', () => {
    const atLeast1 = hypergeomAtLeast(99, 10, 7, 1)
    const exact0 = hypergeomPMF(99, 10, 7, 0)
    expect(atLeast1).toBeCloseTo(1 - exact0, 9)
  })
  it('4 copies in 60, see 7 → ~39.9% to draw at least one', () => {
    expect(hypergeomAtLeast(60, 4, 7, 1)).toBeCloseTo(0.399, 2)
  })
  it('k<=0 is certain when a draw is possible', () => {
    expect(hypergeomAtLeast(60, 4, 7, 0)).toBe(1)
  })
})

describe('expectedCount', () => {
  it('is n*K/N', () => {
    expect(expectedCount(40, 17, 7)).toBeCloseTo(2.975, 3)
    expect(expectedCount(0, 1, 7)).toBe(0)
  })
})

describe('openingHandLands', () => {
  it('reports average and the keepable 2-4 range', () => {
    const r = openingHandLands(40, 17)
    expect(r.avg).toBeCloseTo(2.975, 2)
    expect(r.idealPct).toBeCloseTo(0.7945, 3) // P(2–4 lands in opening 7)
  })
  it('guards an empty deck', () => {
    expect(openingHandLands(0, 0)).toEqual({ avg: 0, idealPct: 0 })
  })
})

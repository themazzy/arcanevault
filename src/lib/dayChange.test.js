import { describe, it, expect } from 'vitest'
import { cardDayChange } from './dayChange'

describe('cardDayChange', () => {
  it('multiplies the price delta by qty', () => {
    expect(cardDayChange({ price: 5, prevPrice: 4, qty: 3, hasManualPrice: false })).toBe(3)
    expect(cardDayChange({ price: 2, prevPrice: 5, qty: 2, hasManualPrice: false })).toBe(-6)
  })

  it('returns 0 when the card has a manual price (any current override opts it out)', () => {
    expect(cardDayChange({ price: 5, prevPrice: 4, qty: 3, hasManualPrice: true })).toBe(0)
    // Even a huge delta is suppressed when the override is set.
    expect(cardDayChange({ price: 100, prevPrice: 1, qty: 10, hasManualPrice: true })).toBe(0)
  })

  it('returns 0 when either side of the delta is missing', () => {
    expect(cardDayChange({ price: null, prevPrice: 4,    qty: 3, hasManualPrice: false })).toBe(0)
    expect(cardDayChange({ price: 5,    prevPrice: null, qty: 3, hasManualPrice: false })).toBe(0)
    expect(cardDayChange({ price: null, prevPrice: null, qty: 3, hasManualPrice: false })).toBe(0)
  })

  it('treats missing qty as 0 (no contribution)', () => {
    expect(cardDayChange({ price: 5, prevPrice: 4, qty: undefined, hasManualPrice: false })).toBe(0)
    expect(cardDayChange({ price: 5, prevPrice: 4, qty: null,      hasManualPrice: false })).toBe(0)
  })

  it('handles a zero delta cleanly (no NaN, no -0 noise)', () => {
    expect(cardDayChange({ price: 5, prevPrice: 5, qty: 4, hasManualPrice: false })).toBe(0)
  })
})

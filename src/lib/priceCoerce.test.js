import { describe, it, expect } from 'vitest'
import { coercePriceWithFallback } from './priceCoerce'

describe('coercePriceWithFallback', () => {
  it('prefers the strict price when defined', () => {
    expect(coercePriceWithFallback(1.23, '99')).toBe(1.23)
    expect(coercePriceWithFallback(0.01, undefined)).toBe(0.01)
  })

  it('falls back to purchase_price when strict is null/undefined', () => {
    expect(coercePriceWithFallback(null, '4.5')).toBe(4.5)
    expect(coercePriceWithFallback(undefined, 7)).toBe(7)
  })

  it('returns the fallbackEmpty (null by default) when purchase_price is empty', () => {
    expect(coercePriceWithFallback(null, '')).toBe(null)
    expect(coercePriceWithFallback(null, undefined)).toBe(null)
    expect(coercePriceWithFallback(null, null)).toBe(null)
  })

  it('does NOT leak NaN — the bug this helper exists to prevent', () => {
    expect(coercePriceWithFallback(null, '')).not.toBeNaN()
    expect(coercePriceWithFallback(null, 'not-a-number')).not.toBeNaN()
    expect(coercePriceWithFallback(null, undefined)).not.toBeNaN()
  })

  it('honors a custom fallbackEmpty (e.g. 0 for sort keys)', () => {
    expect(coercePriceWithFallback(null, '', 0)).toBe(0)
    expect(coercePriceWithFallback(null, undefined, 0)).toBe(0)
    // strict still wins
    expect(coercePriceWithFallback(2.5, '', 0)).toBe(2.5)
  })

  it('strict=0 is treated as a real price, not a missing value', () => {
    // 0 is a legitimate "free" price — null-check uses != null, not falsy
    expect(coercePriceWithFallback(0, '99')).toBe(0)
  })
})

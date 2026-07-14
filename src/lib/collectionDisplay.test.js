import { describe, expect, it } from 'vitest'
import { getCacheTtlMs, getSelectedDisplayQuantity } from './collectionDisplay'

describe('collection display calculations', () => {
  it('converts cache hours to milliseconds', () => {
    expect(getCacheTtlMs(6)).toBe(21600000)
    expect(getCacheTtlMs(0.5)).toBe(1800000)
  })

  it('counts selected display copies including split quantities', () => {
    const cards = [
      { id: 'card-1', _displayKey: 'card-1:binder:a' },
      { id: 'card-2' },
    ]
    const selected = new Set(['card-1:binder:a', 'card-2', 'missing'])
    const splitState = new Map([['card-1:binder:a', 3]])

    expect(getSelectedDisplayQuantity(cards, selected, splitState)).toBe(4)
  })
})

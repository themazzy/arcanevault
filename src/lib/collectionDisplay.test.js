import { describe, expect, it } from 'vitest'
import { getSelectedDisplayQuantity } from './collectionDisplay'

describe('collection display calculations', () => {
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

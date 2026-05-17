import { describe, it, expect } from 'vitest'
import { cardsContentHash } from './cardsHash'

describe('cardsContentHash', () => {
  it('returns a stable string for empty/null input', () => {
    expect(cardsContentHash([])).toBe('0')
    expect(cardsContentHash(null)).toBe('0')
    expect(cardsContentHash(undefined)).toBe('0')
  })

  it('is order-independent', () => {
    const a = [{ id: '1', qty: 2, foil: false }, { id: '2', qty: 1, foil: true }]
    const b = [{ id: '2', qty: 1, foil: true }, { id: '1', qty: 2, foil: false }]
    expect(cardsContentHash(a)).toBe(cardsContentHash(b))
  })

  it('detects qty changes', () => {
    const before = [{ id: '1', qty: 2, foil: false }]
    const after  = [{ id: '1', qty: 3, foil: false }]
    expect(cardsContentHash(before)).not.toBe(cardsContentHash(after))
  })

  it('detects foil ↔ non-foil swap at same total qty (regression for Home stale sync)', () => {
    // Old length+totalQty check missed this — the bug this hash exists to fix.
    const before = [{ id: '1', qty: 1, foil: false }]
    const after  = [{ id: '1', qty: 1, foil: true }]
    expect(cardsContentHash(before)).not.toBe(cardsContentHash(after))
  })

  it('detects card replacement at same length + same total qty', () => {
    // Same array length, same summed qty — pure length+totalQty check passes,
    // but the cards are different rows.
    const before = [{ id: 'A', qty: 2, foil: false }]
    const after  = [{ id: 'B', qty: 2, foil: false }]
    expect(cardsContentHash(before)).not.toBe(cardsContentHash(after))
  })

  it('treats missing qty as 1', () => {
    const a = [{ id: '1', foil: false }]
    const b = [{ id: '1', qty: 1, foil: false }]
    expect(cardsContentHash(a)).toBe(cardsContentHash(b))
  })

  it('treats falsy foil values equivalently', () => {
    const a = [{ id: '1', qty: 1, foil: false }]
    const b = [{ id: '1', qty: 1, foil: null }]
    const c = [{ id: '1', qty: 1 }]
    expect(cardsContentHash(a)).toBe(cardsContentHash(b))
    expect(cardsContentHash(a)).toBe(cardsContentHash(c))
  })
})

// Detecting cards the metadata query never asked about.
//
// The ['sfMap', userId] query has no card dependency and a 24h staleTime, and
// invalidateOwnedCollectionQueries only fires for mutations made on THIS
// device. So cards added on another device arrived through the cards sync and
// then rendered with no art and no price until the next full page load.

import { describe, it, expect } from 'vitest'
import { hasUnrequestedCards } from './collectionFetchers'

const card = (set, num) => ({ set_code: set, collector_number: num })
const keysOf = (...cards) => new Set(cards.map(c => `${c.set_code}-${c.collector_number}`))

describe('hasUnrequestedCards', () => {
  it('spots a card added on another device', () => {
    const known = card('lea', '1')
    const fromOtherDevice = card('neo', '42')

    expect(hasUnrequestedCards([known, fromOtherDevice], keysOf(known))).toBe(true)
  })

  it('is quiet when every card was already requested', () => {
    const a = card('lea', '1')
    const b = card('neo', '42')

    expect(hasUnrequestedCards([a, b], keysOf(a, b))).toBe(false)
  })

  it('stays quiet for a card that HAS no metadata available', () => {
    // The loop guard. ~0.3% of owned prints resolve to no metadata at all.
    // Keying off the response rather than the request would leave them
    // permanently "missing" and refetch forever.
    const unpriced = card('sld', '1337')
    const requested = keysOf(unpriced)   // asked for, nothing came back

    expect(hasUnrequestedCards([unpriced], requested)).toBe(false)
  })

  it('ignores cards with no resolvable key', () => {
    // A malformed row must not trigger an endless refetch it can never satisfy.
    expect(hasUnrequestedCards([{ set_code: null, collector_number: null }], new Set())).toBe(false)
  })

  it('handles the empty and missing cases without throwing', () => {
    expect(hasUnrequestedCards([], new Set())).toBe(false)
    expect(hasUnrequestedCards(null, new Set())).toBe(false)
    expect(hasUnrequestedCards([card('lea', '1')], null)).toBe(false)
  })

  it('detects a removal-then-addition, not just growth', () => {
    // Same count, different contents — a length check would miss this.
    const before = card('lea', '1')
    const after = card('neo', '42')

    expect(hasUnrequestedCards([after], keysOf(before))).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { getDeckCopyLimit } from './deckLegality'

describe('getDeckCopyLimit', () => {
  it('reads "any number" as unlimited', () => {
    expect(getDeckCopyLimit(
      'Relentless Rats gets +1/+1 for each other creature on the battlefield named Relentless Rats. ' +
      'A deck can have any number of cards named Relentless Rats.'
    )).toBe(Infinity)
    expect(getDeckCopyLimit('A deck can have any number of cards named Dragon’s Approach.')).toBe(Infinity)
  })

  it('reads a spelled-out "up to N" limit', () => {
    expect(getDeckCopyLimit('A deck can have up to nine cards named Nazgûl.')).toBe(9)
    expect(getDeckCopyLimit('A deck can have up to seven cards named Seven Dwarves.')).toBe(7)
  })

  it('reads a numeric "up to N" limit', () => {
    expect(getDeckCopyLimit('A deck can have up to 9 cards named Whatever.')).toBe(9)
  })

  // Nine is the largest printed limit today; unprinted word forms are covered
  // so a future card works without a code change.
  it('covers number words past the largest printed limit', () => {
    expect(getDeckCopyLimit('A deck can have up to twelve cards named Future Card.')).toBe(12)
    expect(getDeckCopyLimit('A deck can have up to twenty cards named Future Card.')).toBe(20)
  })

  it('reads "only one card named" as a hard singleton', () => {
    expect(getDeckCopyLimit('A deck can have only one card named Once More with Feeling.')).toBe(1)
  })

  it('ignores tutor text that merely mentions cards with the same name', () => {
    expect(getDeckCopyLimit(
      'When this creature enters, you may search your library for any number of cards named ' +
      'Legion Conquistador, reveal them, put them into your hand, then shuffle.'
    )).toBe(null)
  })

  it('returns null for ordinary cards and empty input', () => {
    expect(getDeckCopyLimit('Add {C}{C}.')).toBe(null)
    expect(getDeckCopyLimit('')).toBe(null)
    expect(getDeckCopyLimit(null)).toBe(null)
    expect(getDeckCopyLimit(undefined)).toBe(null)
  })

  it('accepts a card object and looks at its faces', () => {
    expect(getDeckCopyLimit({ oracle_text: 'A deck can have any number of cards named Rat Colony.' })).toBe(Infinity)
    expect(getDeckCopyLimit({
      oracle_text: null,
      card_faces: [
        { oracle_text: 'Flying' },
        { oracle_text: 'A deck can have up to three cards named Split Thing.' },
      ],
    })).toBe(3)
    expect(getDeckCopyLimit({ oracle_text: 'Flying', card_faces: [] })).toBe(null)
  })
})

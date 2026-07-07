import { describe, expect, it } from 'vitest'
import { extractTokenExtras, extractTokenNames, getDeckTokenItems } from './deckTokens'

describe('deck token detection', () => {
  it('detects utility, creature, and role tokens without duplicates', () => {
    const oracle = [
      'Create two 1/1 white Soldier creature tokens.',
      'Create a Treasure token and a Treasure token.',
      'Create a Cursed Role token attached to target creature.',
    ].join('\n')

    expect(extractTokenNames(oracle)).toEqual(['Treasure', 'Soldier', 'Cursed Role'])
  })

  it('detects non-token game pieces used by the deck', () => {
    const oracle = 'You take the initiative. The Ring tempts you. Venture into the dungeon. You get an emblem.'
    expect(extractTokenExtras(oracle)).toEqual(['The Initiative', 'The Ring', 'Dungeon', 'Emblem'])
  })

  it('returns tokens and extras with their kinds', () => {
    expect(getDeckTokenItems([
      { oracle_text: 'Create a Food token.' },
      { oracle_text: 'You become the monarch.' },
    ])).toEqual([
      { name: 'Food', kind: 'token' },
      { name: 'Monarch', kind: 'extra' },
    ])
  })
})

import { describe, expect, it } from 'vitest'
import {
  getFirstWarningTargetId,
  getWarningTargetIds,
  groupDeckWarnings,
} from './deckWarningNavigation'

describe('deck warning navigation', () => {
  it('normalizes and de-duplicates card targets', () => {
    expect(getWarningTargetIds({ targetCardIds: ['card-1', 'card-1', 2] }))
      .toEqual(['card-1', '2'])
  })

  it('finds the first target that still exists in the deck', () => {
    const warnings = [
      { key: 'size-under' },
      { key: 'color:gone', targetCardId: 'gone' },
      { key: 'legality:card-2', targetCardId: 'card-2' },
    ]
    expect(getFirstWarningTargetId(warnings, new Set(['card-2']))).toBe('card-2')
  })

  it('groups issues into concise user-facing categories', () => {
    const groups = groupDeckWarnings([
      { key: 'color:a' },
      { key: 'legality:b' },
      { key: 'duplicate:c' },
      { key: 'no-commander' },
    ])
    expect(groups.map(group => group.label)).toEqual([
      'Deck requirements',
      'Color identity',
      'Format legality',
      'Copy limits',
    ])
  })
})

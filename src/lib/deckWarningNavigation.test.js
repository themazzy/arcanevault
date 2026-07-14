import { describe, expect, it, vi } from 'vitest'
import {
  getDeckWarningRevealPlan,
  getFirstWarningTargetId,
  getWarningTargetIds,
  groupDeckWarnings,
  scrollAndFocusDeckWarningTarget,
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

  it.each(['list', 'compact', 'grid'])('plans filtered-card navigation in %s view', deckView => {
    const card = { id: 7, board: 'side', category: 'Removal' }
    const plan = getDeckWarningRevealPlan({
      targetId: '7',
      deckCards: [card],
      visibleDeckCards: [],
      groupBy: 'category',
      deckView,
      getCardGroup: row => row.category,
      normalizeBoard: board => board || 'main',
    })

    expect(plan).toEqual({
      card,
      targetId: '7',
      clearFilters: true,
      collapsedKey: 'side:Removal',
    })
  })

  it('plans the stack-specific collapsed group key', () => {
    const plan = getDeckWarningRevealPlan({
      targetId: 'card-1',
      deckCards: [{ id: 'card-1', board: 'main', type: 'Creature' }],
      visibleDeckCards: [{ id: 'card-1' }],
      groupBy: 'type',
      deckView: 'stacks',
      getCardGroup: row => row.type,
      normalizeBoard: board => board,
    })

    expect(plan.clearFilters).toBe(false)
    expect(plan.collapsedKey).toBe('main:stack:Creature')
  })

  it('does not expand a group when grouping is disabled', () => {
    const plan = getDeckWarningRevealPlan({
      targetId: 'card-1',
      deckCards: [{ id: 'card-1', board: 'main' }],
      visibleDeckCards: [{ id: 'card-1' }],
      groupBy: 'none',
      deckView: 'list',
      getCardGroup: () => 'Unused',
      normalizeBoard: board => board,
    })

    expect(plan.collapsedKey).toBe(null)
  })

  it('ignores a warning target that no longer exists', () => {
    expect(getDeckWarningRevealPlan({
      targetId: 'gone',
      deckCards: [],
      visibleDeckCards: [],
      groupBy: 'none',
      deckView: 'list',
      getCardGroup: () => 'Unused',
      normalizeBoard: board => board,
    })).toBe(null)
  })

  it.each([
    [false, 'smooth'],
    [true, 'auto'],
  ])('scrolls, focuses, and respects reduced motion=%s', (reduceMotion, behavior) => {
    const target = {
      dataset: { deckCardId: 'card-2' },
      scrollIntoView: vi.fn(),
      focus: vi.fn(),
    }
    const other = {
      dataset: { deckCardId: 'card-1' },
      scrollIntoView: vi.fn(),
      focus: vi.fn(),
    }
    const container = { querySelectorAll: vi.fn(() => [other, target]) }

    expect(scrollAndFocusDeckWarningTarget(container, 'card-2', { reduceMotion })).toBe(target)
    expect(target.scrollIntoView).toHaveBeenCalledWith({
      behavior,
      block: 'center',
      inline: 'nearest',
    })
    expect(target.focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(other.scrollIntoView).not.toHaveBeenCalled()
  })

  it('returns safely when the card is not mounted yet', () => {
    const container = { querySelectorAll: vi.fn(() => []) }
    expect(scrollAndFocusDeckWarningTarget(container, 'card-1')).toBe(null)
  })
})

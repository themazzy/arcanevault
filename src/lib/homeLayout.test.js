import { describe, it, expect } from 'vitest'
import { getHomeMode, selectUpcomingSets } from './homeLayout'

describe('getHomeMode', () => {
  it('shows onboarding when the user has no cards and no Builder decks', () => {
    expect(getHomeMode({ loading: false, cardCount: 0, builderDeckCount: 0 })).toBe('onboarding')
  })

  it('shows dashboard once the user owns any card', () => {
    expect(getHomeMode({ loading: false, cardCount: 1, builderDeckCount: 0 })).toBe('dashboard')
  })

  it('shows dashboard once the user creates a Builder deck, even with no collection cards', () => {
    expect(getHomeMode({ loading: false, cardCount: 0, builderDeckCount: 1 })).toBe('dashboard')
  })

  it('does not treat unrelated empty folders as returning-user activity', () => {
    expect(getHomeMode({
      loading: false,
      cardCount: 0,
      builderDeckCount: 0,
      folderCount: 3,
    })).toBe('onboarding')
  })

  it('does not guess a Home layout while account data is loading', () => {
    expect(getHomeMode({ loading: true, cardCount: 0, builderDeckCount: 0 })).toBe('loading')
  })
})

describe('selectUpcomingSets', () => {
  it('keeps every relevant future set and sorts them chronologically', () => {
    const sets = Array.from({ length: 10 }, (_, index) => ({
      code: `set-${index}`,
      released_at: `2027-${String(12 - index).padStart(2, '0')}-01`,
      set_type: 'expansion',
    }))
    sets.push({ code: 'past', released_at: '2026-01-01', set_type: 'expansion' })
    sets.push({ code: 'promo', released_at: '2027-01-01', set_type: 'promo' })

    const result = selectUpcomingSets(sets, '2026-07-19')

    expect(result).toHaveLength(10)
    expect(result.map(set => set.code)).toEqual([
      'set-9', 'set-8', 'set-7', 'set-6', 'set-5',
      'set-4', 'set-3', 'set-2', 'set-1', 'set-0',
    ])
  })
})

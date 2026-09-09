import { describe, it, expect } from 'vitest'
import { getHomeMode } from './homeLayout'

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

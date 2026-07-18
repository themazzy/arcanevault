import { describe, it, expect } from 'vitest'
import { getHomeMode } from './homeLayout'

describe('getHomeMode', () => {
  it('shows onboarding for a brand-new user (no cards, no folders)', () => {
    expect(getHomeMode({ loading: false, cardCount: 0, folderCount: 0 })).toBe('onboarding')
  })

  it('shows dashboard once the user owns any card', () => {
    expect(getHomeMode({ loading: false, cardCount: 1, folderCount: 0 })).toBe('dashboard')
  })

  it('shows dashboard if the user created folders, even with zero cards', () => {
    expect(getHomeMode({ loading: false, cardCount: 0, folderCount: 2 })).toBe('dashboard')
  })

  it('defaults to dashboard while collection data is loading', () => {
    expect(getHomeMode({ loading: true, cardCount: 0, folderCount: 0 })).toBe('dashboard')
  })
})

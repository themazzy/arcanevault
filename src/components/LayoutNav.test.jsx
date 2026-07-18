// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Layout from './Layout'

vi.mock('../lib/supabase', () => ({ sb: { auth: { signOut: vi.fn() } } }))
vi.mock('./Auth', () => ({ useAuth: () => ({ user: { id: 'u1', email: 'tester@example.com' } }) }))
vi.mock('./SettingsContext', () => ({
  useSettings: () => ({ keep_screen_awake: false, premium: false, nickname: 'Tester' }),
  maskEmailAddress: () => 'masked',
}))
vi.mock('./FeedbackModal', () => ({ default: () => null }))
vi.mock('./FeedbackNudge', () => ({ default: () => null }))
vi.mock('./community/NotificationBell', () => ({ default: () => null }))
vi.mock('./ActivityStatusBadge', () => ({ default: () => null }))
vi.mock('./PageTips', () => ({ default: () => null }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }))
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) } }))

function renderLayout(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Layout><div /></Layout>
    </MemoryRouter>
  )
}

afterEach(() => cleanup())

describe('Layout navbar grouping', () => {
  it('renders Wishlists and Life Tracker only inside dropdown menus, not as standalone tabs', () => {
    renderLayout('/')
    for (const name of [/wishlists/i, /life tracker/i]) {
      expect(screen.queryByRole('link', { name })).toBeNull()
      const items = screen.getAllByRole('menuitem', { name })
      expect(items.length).toBeGreaterThan(0)
      for (const item of items) {
        expect(item.closest('[role="menu"]')).not.toBeNull()
      }
    }
  })

  it('puts Wishlists in the My Collection menu and Life Tracker in the Stats menu', () => {
    renderLayout('/')
    const collectionGroup = screen.getByRole('link', { name: /^my collection$/i }).parentElement
    expect(collectionGroup.querySelector('[role="menu"]').textContent).toMatch(/Wishlists/)
    const statsGroup = screen.getByRole('link', { name: /^stats$/i }).parentElement
    expect(statsGroup.querySelector('[role="menu"]').textContent).toMatch(/Life Tracker/)
  })

  it('opens the My Collection mobile group on /lists and the Stats mobile group on /life', () => {
    renderLayout('/lists')
    expect(screen.getByRole('button', { name: /my collection/i }).getAttribute('aria-expanded')).toBe('true')
    cleanup()
    renderLayout('/life')
    expect(screen.getByRole('button', { name: /^stats$/i }).getAttribute('aria-expanded')).toBe('true')
  })
})

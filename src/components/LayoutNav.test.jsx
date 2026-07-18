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

describe('Layout navbar without a Home menu', () => {
  it('has no Home tab in the desktop nav; the logo is the home link', () => {
    renderLayout('/collection')
    const nav = document.querySelector('nav')
    expect(nav.textContent).not.toMatch(/Home/)
    const logo = screen.getByRole('link', { name: /deckloom home/i })
    expect(logo.getAttribute('href')).toBe('/')
  })

  it('renders Trading as a plain tab with no dropdown menu', () => {
    renderLayout('/')
    const nav = document.querySelector('nav')
    const trading = screen.getAllByRole('link', { name: /^trading$/i }).find(l => nav.contains(l))
    expect(trading).toBeTruthy()
    expect(trading.getAttribute('href')).toBe('/trading')
    expect(trading.parentElement.tagName).toBe('NAV')
    expect(screen.queryByRole('menuitem', { name: /trade log/i })).toBeNull()
  })

  it('renders Stats as a plain tab with no dropdown menu', () => {
    renderLayout('/')
    const nav = document.querySelector('nav')
    const stats = screen.getAllByRole('link', { name: /^stats$/i }).find(l => nav.contains(l))
    expect(stats).toBeTruthy()
    expect(stats.getAttribute('href')).toBe('/stats')
    expect(stats.parentElement.tagName).toBe('NAV')
    expect(screen.queryByRole('menuitem', { name: /deck win rates/i })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /game history/i })).toBeNull()
  })

  it('offers Rulebook as a menu item in the account dropdown', () => {
    renderLayout('/')
    const rulebook = screen.getByRole('menuitem', { name: /rulebook/i })
    expect(rulebook.getAttribute('href')).toBe('/rules')
    const menu = rulebook.closest('[role="menu"]')
    expect(menu.textContent).toMatch(/Profile/)
    expect(menu.textContent).toMatch(/Settings/)
  })
})

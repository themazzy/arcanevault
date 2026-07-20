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
    const logos = screen.getAllByRole('link', { name: /deckloom home/i })
    expect(logos.length).toBeGreaterThan(0)
    logos.forEach(l => expect(l.getAttribute('href')).toBe('/'))
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

  it('offers Stats in the account dropdown instead of the top tab row', () => {
    renderLayout('/')
    const nav = document.querySelector('nav')
    const topTab = screen.queryAllByRole('link', { name: /^stats$/i }).find(l => nav.contains(l))
    expect(topTab).toBeUndefined()
    const stats = screen.getByRole('menuitem', { name: /^stats$/i })
    expect(stats.getAttribute('href')).toBe('/stats')
    const menu = stats.closest('[role="menu"]')
    expect(menu.textContent).toMatch(/Profile/)
    expect(menu.textContent).toMatch(/Settings/)
  })

  it('offers Wishlists inside the My Collection dropdown, not as a top-level tab', () => {
    renderLayout('/')
    const nav = document.querySelector('nav')
    const wishlists = screen.getByRole('menuitem', { name: /wishlists/i })
    expect(wishlists.getAttribute('href')).toBe('/lists')
    const menu = wishlists.closest('[role="menu"]')
    expect(menu.textContent).toMatch(/My Binders/)
    const topTab = screen.queryAllByRole('link', { name: /^wishlists$/i })
      .find(l => nav.contains(l) && !l.closest('[role="menu"]'))
    expect(topTab).toBeUndefined()
  })

  it('renders Deck Builder and Deck Browser as separate top-level tabs, no Decks dropdown', () => {
    renderLayout('/builder?tab=browser')
    const nav = document.querySelector('nav')
    const builder = screen.getAllByRole('link', { name: /^deck builder$/i }).find(l => nav.contains(l))
    const browser = screen.getAllByRole('link', { name: /^deck browser$/i }).find(l => nav.contains(l))
    expect(builder.getAttribute('href')).toBe('/builder')
    expect(browser.getAttribute('href')).toBe('/builder?tab=browser')
    expect(builder.parentElement.tagName).toBe('NAV')
    expect(browser.parentElement.tagName).toBe('NAV')
    expect(screen.queryByRole('link', { name: /^decks$/i })).toBeNull()
    expect(browser.className).toMatch(/active/)
    expect(builder.className).not.toMatch(/active/)
  })

  it('mobile menu mirrors the desktop nav: logo is the home link, no Home group, account items in the footer', () => {
    renderLayout('/')
    const homeLinks = screen.getAllByRole('link', { name: /deckloom home/i })
    expect(homeLinks).toHaveLength(2)
    homeLinks.forEach(l => expect(l.getAttribute('href')).toBe('/'))
    expect(screen.queryByRole('button', { name: /^home$/i })).toBeNull()
    for (const name of [/^profile$/i, /^stats$/i, /^rulebook$/i, /^settings$/i]) {
      const mobileLink = screen.getAllByRole('link', { name })
        .filter(l => !l.closest('[role="menu"]'))
      expect(mobileLink).toHaveLength(1)
    }
  })

  it('offers Rulebook as a menu item in the account dropdown', () => {
    renderLayout('/')
    const rulebook = screen.getByRole('menuitem', { name: /rulebook/i })
    expect(rulebook.getAttribute('href')).toBe('/rules')
    const menu = rulebook.closest('[role="menu"]')
    expect(menu.textContent).toMatch(/Profile/)
    expect(menu.textContent).toMatch(/Settings/)
  })

  it('keeps Scanner in the mobile menu without promoting it in the desktop navbar', () => {
    renderLayout('/')
    const nav = document.querySelector('nav')
    expect([...nav.querySelectorAll('a')].some(link => link.getAttribute('href') === '/scanner')).toBe(false)

    const scannerLinks = screen.getAllByRole('link', { name: /^scanner$/i })
    expect(scannerLinks).toHaveLength(1)
    expect(scannerLinks[0].getAttribute('href')).toBe('/scanner')
  })
})

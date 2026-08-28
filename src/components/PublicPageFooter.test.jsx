// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import PublicPageFooter from './PublicPageFooter'

afterEach(() => cleanup())

describe('PublicPageFooter', () => {
  it('links to the privacy policy, terms and legal hub', () => {
    render(<MemoryRouter><PublicPageFooter /></MemoryRouter>)
    const href = name => screen.getByRole('link', { name }).getAttribute('href')

    expect(href(/^privacy$/i)).toBe('/privacy')
    expect(href(/^terms$/i)).toBe('/terms')
    expect(href(/cookies & storage/i)).toBe('/storage')
    expect(href(/^legal$/i)).toBe('/legal')
  })

  it('is labelled so the links are findable as a group', () => {
    render(<MemoryRouter><PublicPageFooter /></MemoryRouter>)
    expect(screen.getByRole('navigation', { name: /legal/i })).toBeTruthy()
  })

  it('carries the unofficial-fan-content disclaimer', () => {
    render(<MemoryRouter><PublicPageFooter /></MemoryRouter>)
    expect(document.body.textContent).toMatch(/not affiliated with Wizards of the Coast/i)
  })
})

// These routes render outside Layout, so they have no nav, and their visitors
// are typically signed out with no Settings page to look in. A public page with
// no route to the privacy policy is the gap this component exists to close —
// losing it from one page is silent, which is why this is asserted rather than
// left to review. A new public route belongs on this list.
const PUBLIC_PAGES = [
  'DeckView',
  'Profile',
  'Trade',
  'Share',
  'JoinGame',
  'JoinTournament',
]

describe('public routes carry the footer', () => {
  it.each(PUBLIC_PAGES)('%s renders PublicPageFooter', (page) => {
    // Resolved from the project root, not import.meta.url: under jsdom that is
    // a browser-style URL, and resolving against it yields a bogus path.
    const source = readFileSync(resolve(process.cwd(), 'src/pages', `${page}.jsx`), 'utf8')
    expect(source).toMatch(/import PublicPageFooter from '\.\.\/components\/PublicPageFooter'/)
    expect(source).toMatch(/<PublicPageFooter\s*\/>/)
  })
})

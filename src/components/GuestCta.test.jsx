// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import GuestCta from './GuestCta'

afterEach(() => cleanup())

const renderCta = (props = {}) =>
  render(<MemoryRouter><GuestCta {...props} /></MemoryRouter>)

describe('GuestCta', () => {
  it('pitches uncapped scanning, not the feature the host page happens to show', () => {
    // The claim is the reason to switch: every competing tracker meters scans.
    // If this copy drifts to a generic "try DeckLoom", the CTA stops doing the
    // job it was added for.
    renderCta()
    expect(document.body.textContent).toMatch(/no scan cap/i)
  })

  it('sends the visitor to the sign-up route', () => {
    renderCta()
    expect(screen.getByRole('link', { name: /create a free account/i }).getAttribute('href'))
      .toBe('/login')
  })

  it('renders nothing for a signed-in viewer', () => {
    // Not merely hidden: a signed-in user must not have page content pushed
    // down by a sign-up pitch they have already acted on.
    const { container } = renderCta({ show: false })
    expect(container.innerHTML).toBe('')
  })
})

// The public routes that double as landing surfaces for someone who has never
// seen DeckLoom. Losing the CTA from one of them is silent — the page still
// renders fine, it just stops asking — which is why it is asserted rather than
// left to review. Join/share lobbies are deliberately not on this list.
const CTA_PAGES = [
  'DeckView',
  'Profile',
  'Trade',
  'SetSpoiler',
  'UpcomingSets',
]

describe('public landing pages carry the CTA', () => {
  it.each(CTA_PAGES)('%s renders GuestCta', (page) => {
    // Resolved from the project root, not import.meta.url: under jsdom that is
    // a browser-style URL, and resolving against it yields a bogus path.
    const source = readFileSync(resolve(process.cwd(), 'src/pages', `${page}.jsx`), 'utf8')
    expect(source).toMatch(/import GuestCta from '\.\.\/components\/GuestCta'/)
    expect(source).toMatch(/<GuestCta show=\{!user\} \/>/)
  })
})

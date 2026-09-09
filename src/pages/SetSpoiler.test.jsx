// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchAllSets = vi.fn()
const fetchSpoiledCards = vi.fn()
const fetchMechanicHistory = vi.fn()

vi.mock('../lib/upcomingSets', async () => {
  const actual = await vi.importActual('../lib/upcomingSets')
  return {
    ...actual,
    fetchAllSets: (...a) => fetchAllSets(...a),
    fetchSpoiledCards: (...a) => fetchSpoiledCards(...a),
    fetchMechanicHistory: (...a) => fetchMechanicHistory(...a),
  }
})
vi.mock('../components/Auth', () => ({ useAuth: () => ({ user: null }) }))
vi.mock('../components/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }))
vi.mock('../lib/supabase', () => ({ sb: { from: () => ({}) } }))
vi.mock('../lib/setCompletion', () => ({ addMissingToWishlist: vi.fn() }))

// The hover preview is gated on a fine pointer, read once at module load.
// jsdom answers false to every media query, so the stub has to be in place
// before the module is imported or the preview can never fire in a test.
window.matchMedia = query => ({
  matches: query === '(hover: hover) and (pointer: fine)',
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
})

const { default: SetSpoilerPage } = await import('./SetSpoiler')

const trk = {
  code: 'trk',
  name: 'Star Trek',
  set_type: 'expansion',
  released_at: '2099-11-13',
  card_count: 135,
  icon_svg_uri: 'https://svgs.scryfall.io/sets/trk.svg',
}

const card = (over = {}) => ({
  id: over.name || 'id',
  name: 'General Chang',
  set: 'trk',
  collector_number: '109',
  rarity: 'rare',
  type_line: 'Legendary Creature — Klingon',
  mana_cost: '{B}',
  cmc: 1,
  color_identity: ['B'],
  keywords: [],
  oracle_text: '',
  image_uris: { normal: 'https://cards.scryfall.io/normal/x.jpg' },
  ...over,
})

// The tile carries its name as aria-label rather than title: a native tooltip
// would fire on the same hover that opens the card preview and land on top of
// the image (see 6a8be86).
const tile = (name) => screen.getByRole('button', { name })
const maybeTile = (name) => screen.queryByRole('button', { name })

const renderPage = (path = '/sets/trk') => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/sets/:code" element={<SetSpoilerPage />} /></Routes>
  </MemoryRouter>,
)

beforeEach(() => {
  fetchAllSets.mockReset().mockResolvedValue([trk])
  fetchSpoiledCards.mockReset().mockResolvedValue([])
  fetchMechanicHistory.mockReset().mockResolvedValue(null)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(cleanup)

describe('SetSpoilerPage', () => {
  it('shows the set, its date and how many cards are revealed', async () => {
    fetchSpoiledCards.mockResolvedValue([card(), card({ name: 'Shock Wave', id: 'b' })])
    renderPage()

    await waitFor(() => expect(screen.getByText('2 cards revealed')).toBeTruthy())
    expect(screen.getByRole('heading', { name: 'Star Trek' })).toBeTruthy()
    expect(screen.getByText('Nov 13, 2099')).toBeTruthy()
    // Distinct cards and printings are different counts, labelled apart rather
    // than presented as one figure.
    expect(screen.getByText('135 printings')).toBeTruthy()
  })

  it('tells the visitor nothing is spoiled yet rather than showing an empty grid', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText(/Nothing has been previewed/i)).toBeTruthy())
  })

  // Home's Upcoming Sets panel is where these pages are reached from, so back
  // goes there; the calendar stays in the trail.
  it('sends the back link to Home and keeps the calendar one click away', async () => {
    fetchSpoiledCards.mockResolvedValue([card()])
    renderPage()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Star Trek' })).toBeTruthy())

    const crumbs = within(screen.getByRole('navigation', { name: /breadcrumb/i })).getAllByRole('link')
    expect(crumbs.map(a => a.getAttribute('href'))).toEqual(['/', '/sets'])
  })

  // A mechanic whose lookup could not be answered must not be labelled new —
  // the rate-limit case that wrongly flagged Ward on a large set.
  it('leaves a mechanic unflagged when its history lookup fails', async () => {
    fetchSpoiledCards.mockResolvedValue([
      card({ keywords: ['Ward'], oracle_text: 'Ward {2}' }),
    ])
    fetchMechanicHistory.mockResolvedValue(null)
    renderPage()

    await waitFor(() => expect(screen.getByText('Ward')).toBeTruthy())
    expect(screen.queryByText('New')).toBeNull()
  })

  it('explains an unknown set code instead of rendering a blank page', async () => {
    fetchAllSets.mockResolvedValue([])
    renderPage('/sets/nope')
    await waitFor(() => expect(screen.getByText(/No set with the code/i)).toBeTruthy())
  })

  it('filters the grid from a breakdown row and can clear it again', async () => {
    fetchSpoiledCards.mockResolvedValue([
      card({ name: 'Rare One', id: 'a', rarity: 'rare' }),
      card({ name: 'Common One', id: 'b', rarity: 'common' }),
    ])
    renderPage()

    await waitFor(() => expect(tile('Rare One')).toBeTruthy())
    const rarityGroup = screen.getByRole('heading', { name: 'Rarity' }).parentElement
    fireEvent.click(within(rarityGroup).getByText('rare'))

    await waitFor(() => expect(maybeTile('Common One')).toBeNull())
    expect(screen.getByText('1 of 2 cards')).toBeTruthy()

    fireEvent.click(screen.getByText('Clear filters'))
    await waitFor(() => expect(tile('Common One')).toBeTruthy())
  })

  it('opens a card and shows its rules text', async () => {
    fetchSpoiledCards.mockResolvedValue([card({ oracle_text: 'Menace (This creature can\'t be blocked except by two or more creatures.)' })])
    renderPage()

    await waitFor(() => expect(tile('General Chang')).toBeTruthy())
    fireEvent.click(tile('General Chang'))

    await waitFor(() => expect(screen.getByRole('heading', { name: 'General Chang' })).toBeTruthy())
    expect(screen.getByText(/can't be blocked except by two or more creatures/)).toBeTruthy()
    // Signed out, so the wishlist control is an invitation to sign in.
    expect(screen.getByText(/to add spoiled cards to a wishlist/i)).toBeTruthy()
  })

  it('flags a mechanic with no earlier printing as new, and explains it', async () => {
    fetchSpoiledCards.mockResolvedValue([
      card({ keywords: ['Station'], oracle_text: 'Station (Tap another creature you control.)' }),
      card({ name: 'Flier', id: 'b', keywords: ['Flying'], oracle_text: 'Flying' }),
    ])
    fetchMechanicHistory.mockImplementation(async (name) => (
      name === 'Station'
        ? { keyword: 'Station', priorCount: 0 }
        : { keyword: name, priorCount: 3283 }
    ))
    renderPage()

    await waitFor(() => expect(screen.getByText('New')).toBeTruthy())
    expect(screen.getByText('Tap another creature you control.')).toBeTruthy()
  })

  // The cards are the point of the page, so the filters sit in a rail beside
  // them rather than in panels stacked above them.
  it('puts the filters in a rail, not between the header and the cards', async () => {
    fetchSpoiledCards.mockResolvedValue([card()])
    renderPage()

    await waitFor(() => expect(tile('General Chang')).toBeTruthy())
    const rail = screen.getByRole('complementary', { name: /filter the revealed cards/i })
    expect(within(rail).getByRole('heading', { name: 'Rarity' })).toBeTruthy()
    expect(within(rail).queryByRole('button', { name: 'General Chang' })).toBeNull()
  })

  it('folds a long mechanic list behind a Show all', async () => {
    const keywords = ['Flying', 'Trample', 'Ward', 'Menace', 'Reach', 'Haste', 'Vigilance', 'Lifelink', 'Deathtouch']
    fetchSpoiledCards.mockResolvedValue(keywords.map((k, i) => card({ id: `k${i}`, name: `Card ${i}`, keywords: [k] })))
    renderPage()

    // Equal counts sort by name, so Ward is the one past the fold.
    await waitFor(() => expect(screen.getByText('Show all 9')).toBeTruthy())
    expect(screen.getByText('Deathtouch')).toBeTruthy()
    expect(screen.queryByText('Ward')).toBeNull()

    fireEvent.click(screen.getByText('Show all 9'))
    expect(screen.getByText('Ward')).toBeTruthy()
  })

  it('keeps a mechanic filter in the URL so the view can be shared', async () => {
    fetchSpoiledCards.mockResolvedValue([
      card({ name: 'Stationed', id: 'a', keywords: ['Station'] }),
      card({ name: 'Flier', id: 'b', keywords: ['Flying'] }),
    ])
    renderPage('/sets/trk?mechanic=Station')

    await waitFor(() => expect(tile('Stationed')).toBeTruthy())
    expect(maybeTile('Flier')).toBeNull()
  })
})

describe('hover preview', () => {
  // The shared useCardPreview portal: an anchor carrying the cursor-follow
  // transform, wrapping the card that carries the entry animation.
  const previewAnchor = () => document.querySelector('[class*="hoverPreviewAnchor"]')

  it('shows an enlarged card while the pointer is over a tile', async () => {
    fetchSpoiledCards.mockResolvedValue([card()])
    renderPage()
    await waitFor(() => expect(tile('General Chang')).toBeTruthy())
    expect(previewAnchor()).toBeNull()

    fireEvent.mouseEnter(tile('General Chang'), { clientX: 400, clientY: 300 })
    const anchor = previewAnchor()
    expect(anchor).toBeTruthy()
    expect(anchor.style.width).toBe(`${340}px`)
    // Positioned by transform, never left/top — see useCardPreview.js.
    expect(anchor.style.transform).toMatch(/^translate3d\(/)
  })

  it('follows the cursor without re-rendering through React state', async () => {
    fetchSpoiledCards.mockResolvedValue([card()])
    renderPage()
    await waitFor(() => expect(tile('General Chang')).toBeTruthy())

    const target = tile('General Chang')
    fireEvent.mouseEnter(target, { clientX: 100, clientY: 200 })
    const first = previewAnchor().style.transform

    fireEvent.mouseMove(target, { clientX: 500, clientY: 400 })
    expect(previewAnchor().style.transform).not.toBe(first)
  })

  it('hides the preview when the pointer leaves', async () => {
    fetchSpoiledCards.mockResolvedValue([card()])
    renderPage()
    await waitFor(() => expect(tile('General Chang')).toBeTruthy())

    fireEvent.mouseEnter(tile('General Chang'), { clientX: 400, clientY: 300 })
    expect(previewAnchor()).toBeTruthy()

    fireEvent.mouseLeave(tile('General Chang'))
    expect(previewAnchor()).toBeNull()
  })

  // The preview sits above the modal in the stacking order, so leaving it up
  // would float an enlarged card over the card's own detail view.
  it('drops the preview when the card is opened', async () => {
    fetchSpoiledCards.mockResolvedValue([card()])
    renderPage()
    await waitFor(() => expect(tile('General Chang')).toBeTruthy())

    fireEvent.mouseEnter(tile('General Chang'), { clientX: 400, clientY: 300 })
    expect(previewAnchor()).toBeTruthy()

    fireEvent.click(tile('General Chang'))
    expect(previewAnchor()).toBeNull()
  })
})

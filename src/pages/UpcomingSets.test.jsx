// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchUpcomingSets = vi.fn()

vi.mock('../lib/upcomingSets', async () => {
  const actual = await vi.importActual('../lib/upcomingSets')
  return { ...actual, fetchUpcomingSets: (...args) => fetchUpcomingSets(...args) }
})

const { default: UpcomingSetsPage } = await import('./UpcomingSets')

const set = (over = {}) => ({
  code: 'trk',
  name: 'Star Trek',
  set_type: 'expansion',
  released_at: '2099-11-13',
  card_count: 135,
  icon_svg_uri: 'https://svgs.scryfall.io/sets/trk.svg',
  ...over,
})

const renderPage = () => render(<MemoryRouter><UpcomingSetsPage /></MemoryRouter>)

beforeEach(() => { fetchUpcomingSets.mockReset() })
afterEach(cleanup)

describe('UpcomingSetsPage', () => {
  it('lists each announced set with its release date and countdown', async () => {
    fetchUpcomingSets.mockResolvedValue([set()])
    renderPage()

    await waitFor(() => expect(screen.getByText('Star Trek')).toBeTruthy())
    expect(screen.getByText('Expansion')).toBeTruthy()
    expect(screen.getByText('135 printings revealed')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Star Trek/ }).getAttribute('href')).toBe('/sets/trk')
  })

  // The whole point of the page: a set opens in DeckLoom, not on Scryfall.
  it('never links a set out to Scryfall', async () => {
    fetchUpcomingSets.mockResolvedValue([set()])
    renderPage()

    await waitFor(() => expect(screen.getByText('Star Trek')).toBeTruthy())
    const setLinks = screen.getAllByRole('link').map(a => a.getAttribute('href'))
    expect(setLinks.some(href => href?.includes('scryfall.com/sets'))).toBe(false)
  })

  it('nests a companion product under the set it ships with', async () => {
    fetchUpcomingSets.mockResolvedValue([
      set(),
      set({ code: 'trc', name: 'Star Trek Commander', set_type: 'commander', parent_set_code: 'trk', card_count: 41 }),
    ])
    renderPage()

    await waitFor(() => expect(screen.getByText('Star Trek Commander')).toBeTruthy())
    expect(screen.getAllByRole('article')).toHaveLength(1)
  })

  it('says so plainly when nothing is announced', async () => {
    fetchUpcomingSets.mockResolvedValue([])
    renderPage()
    await waitFor(() => expect(screen.getByText(/No sets have been announced/i)).toBeTruthy())
  })

  it('reports a failed fetch instead of spinning forever', async () => {
    fetchUpcomingSets.mockRejectedValue(new Error('offline'))
    renderPage()
    await waitFor(() => expect(screen.getByText(/Could not load the release calendar/i)).toBeTruthy())
  })
})

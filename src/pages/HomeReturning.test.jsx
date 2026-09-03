// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChangelogPanel, fetchTrendingDecks } from './Home'

const entries = [{
  version: 'July 19, 2026',
  label: 'New',
  updates: ['A focused update'],
}]

describe('returning Home changelog', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => cleanup())

  it('starts collapsed to keep the dashboard scannable', () => {
    render(<ChangelogPanel entries={entries} />)

    const toggle = screen.getByRole('button', { name: /what's new/i })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('A focused update')).toBeNull()
  })

  it('remembers when the user chooses to expand it', () => {
    render(<ChangelogPanel entries={entries} />)

    fireEvent.click(screen.getByRole('button', { name: /what's new/i }))

    expect(screen.getByText('A focused update')).toBeTruthy()
    expect(localStorage.getItem('av_changelog_open')).toBe('true')
  })
})

describe('returning Home trending decks', () => {
  const now = Date.parse('2026-09-03T12:00:00Z')

  // Three decks the server has already windowed and ranked. "Settled deck" is
  // the important one: it leads on recent likes while its card list has not
  // changed in 46 days. Home used to filter it out on that staleness, which
  // removed the most-liked deck in the app on the morning it was liked.
  const SERVER_ROWS = [
    {
      id: 'settled-but-liked', user_id: 'user-1', name: 'Settled deck',
      like_count: 2, recent_like_count: 2,
      deck_modified_at: '2026-07-19T20:44:38Z', updated_at: '2026-07-24T17:45:45Z',
      description: JSON.stringify({ coverArtUri: 'https://example.com/art.jpg' }),
    },
    {
      id: 'recently-edited', user_id: 'user-2', name: 'Busy deck',
      like_count: 1, recent_like_count: 1,
      deck_modified_at: '2026-08-31T10:34:00Z', updated_at: '2026-08-31T10:34:00Z',
      description: '{}',
    },
    {
      id: 'third', user_id: 'user-3', name: 'Third deck',
      like_count: 1, recent_like_count: 1,
      deck_modified_at: '2026-08-24T06:45:18Z', updated_at: '2026-08-24T06:45:18Z',
      description: '{}',
    },
  ]

  const makeRpc = (decks = SERVER_ROWS) => vi.fn(async name => {
    if (name === 'get_community_decks') return { data: { decks }, error: null }
    return { data: [{ user_id: 'user-1', nickname: 'LoomMage' }], error: null }
  })

  // Decks without a cached coverArtUri fall through to a commander-art lookup.
  // Not what these tests are about, so it resolves to nothing.
  const makeClient = (decks = SERVER_ROWS) => {
    const chain = {
      select: () => chain,
      in: () => chain,
      eq: async () => ({ data: [], error: null }),
    }
    return { rpc: makeRpc(decks), from: () => chain }
  }

  it('delegates the window to the RPC and resolves author names', async () => {
    const client = makeClient()
    const rpc = client.rpc
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() }

    const result = await fetchTrendingDecks({ client, storage, now })

    expect(rpc).toHaveBeenNthCalledWith(1, 'get_community_decks', {
      p_sort: 'trending',
      p_limit: 3,
      p_recent_days: 30,
    })
    expect(rpc).toHaveBeenNthCalledWith(2, 'get_user_nicknames',
      { p_user_ids: ['user-1', 'user-2', 'user-3'] })
    expect(result.nicks).toEqual({ 'user-1': 'LoomMage' })
    expect(storage.setItem).toHaveBeenCalledOnce()
  })

  it('renders every deck the server returned, in its order', async () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() }

    const result = await fetchTrendingDecks({ client: makeClient(), storage, now })

    // Three tiles, not two — and the settled-but-liked deck still leads.
    expect(result.decks.map(deck => deck.id))
      .toEqual(['settled-but-liked', 'recently-edited', 'third'])
  })

  it('ignores a cache written by the previous all-time-likes ranking', async () => {
    // The v2 key held decks chosen by the old rule; reading it would keep
    // showing them for the life of the session.
    const storage = {
      getItem: vi.fn(key => key === 'av_home_trending_decks_v2'
        ? JSON.stringify({ at: now, decks: [{ id: 'stale-pick' }], nicks: {} })
        : null),
      setItem: vi.fn(),
    }

    const result = await fetchTrendingDecks({ client: makeClient(), storage, now })

    expect(storage.getItem).toHaveBeenCalledWith('av_home_trending_decks_v3')
    expect(result.decks.map(deck => deck.id)).not.toContain('stale-pick')
  })

  it('serves a fresh v3 cache without hitting the network', async () => {
    const client = makeClient()
    const rpc = client.rpc
    const cached = { at: now - 1000, decks: [{ id: 'cached' }], nicks: {} }
    const storage = { getItem: vi.fn(() => JSON.stringify(cached)), setItem: vi.fn() }

    const result = await fetchTrendingDecks({ client, storage, now })

    expect(rpc).not.toHaveBeenCalled()
    expect(result.decks.map(deck => deck.id)).toEqual(['cached'])
  })
})

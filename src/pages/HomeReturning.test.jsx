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
  it('uses the Deck Browser trending criteria and resolves author names', async () => {
    const now = Date.parse('2026-07-19T12:00:00Z')
    const rpc = vi.fn(async name => {
      if (name === 'get_community_decks') {
        return {
          data: {
            decks: [
              {
                id: 'fresh-liked', user_id: 'user-1', name: 'Fresh deck', like_count: 4,
                updated_at: '2026-07-18T12:00:00Z',
                description: JSON.stringify({ coverArtUri: 'https://example.com/art.jpg' }),
              },
              {
                id: 'fresh-unliked', user_id: 'user-2', name: 'No likes', like_count: 0,
                updated_at: '2026-07-18T12:00:00Z', description: '{}',
              },
              {
                id: 'stale-liked', user_id: 'user-3', name: 'Stale deck', like_count: 9,
                updated_at: '2026-05-01T12:00:00Z', description: '{}',
              },
            ],
          },
          error: null,
        }
      }
      return { data: [{ user_id: 'user-1', nickname: 'LoomMage' }], error: null }
    })
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() }

    const result = await fetchTrendingDecks({ client: { rpc }, storage, now })

    expect(rpc).toHaveBeenNthCalledWith(1, 'get_community_decks', {
      p_sort: 'trending',
      p_limit: 3,
    })
    expect(rpc).toHaveBeenNthCalledWith(2, 'get_user_nicknames', { p_user_ids: ['user-1'] })
    expect(result.decks.map(deck => deck.id)).toEqual(['fresh-liked'])
    expect(result.nicks).toEqual({ 'user-1': 'LoomMage' })
    expect(storage.setItem).toHaveBeenCalledOnce()
  })
})

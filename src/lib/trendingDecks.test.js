import { describe, expect, it, vi } from 'vitest'
import {
  TRENDING_DECK_COUNT,
  TRENDING_WINDOW_DAYS,
  fetchTrendingDeckRows,
} from './trendingDecks'

// These pin the contract between the two Trending surfaces and the RPC. The
// bug they guard against: for a while "Trending" ranked all-time likes with no
// time component, and the recency window lived in the client — applied AFTER
// the RPC had truncated to three rows, and measuring when the deck was last
// EDITED rather than last LIKED. That dropped the most-liked deck in the app on
// the morning it was liked, and rendered two tiles instead of three.

const rpcReturning = decks => vi.fn(async () => ({ data: { decks }, error: null }))

describe('fetchTrendingDeckRows', () => {
  it('asks the RPC to do the windowing, so the filter runs before the limit', async () => {
    const rpc = rpcReturning([])
    await fetchTrendingDeckRows({ client: { rpc } })

    expect(rpc).toHaveBeenCalledWith('get_community_decks', {
      p_sort: 'trending',
      p_limit: TRENDING_DECK_COUNT,
      p_recent_days: TRENDING_WINDOW_DAYS,
    })
  })

  it('sends a window at all — without p_recent_days the RPC ranks but does not filter', async () => {
    const rpc = rpcReturning([])
    await fetchTrendingDeckRows({ client: { rpc } })
    expect(rpc.mock.calls[0][1].p_recent_days).toBeGreaterThan(0)
  })

  it('returns the server ordering untouched', async () => {
    // The server ranks on recent likes, all-time likes only as the tiebreak.
    // Re-sorting here would undo that.
    const rpc = rpcReturning([
      { id: 'a', recent_like_count: 2, like_count: 2 },
      { id: 'b', recent_like_count: 1, like_count: 9 },
      { id: 'c', recent_like_count: 1, like_count: 1 },
    ])
    expect((await fetchTrendingDeckRows({ client: { rpc } })).map(d => d.id))
      .toEqual(['a', 'b', 'c'])
  })

  it('does not drop a deck whose card list has not been touched in months', async () => {
    // The regression in one test. This deck is trending — it was liked today —
    // and it is exactly the row the old client-side edit-recency filter removed.
    const rpc = rpcReturning([{
      id: 'settled-but-liked',
      name: 'Dinos',
      like_count: 2,
      recent_like_count: 2,
      deck_modified_at: '2026-07-19T20:44:38Z',
      updated_at: '2026-07-24T17:45:45Z',
    }])

    const rows = await fetchTrendingDeckRows({ client: { rpc } })

    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('settled-but-liked')
  })

  it('keeps every row the server returned, up to the full count', async () => {
    const rpc = rpcReturning([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    expect(await fetchTrendingDeckRows({ client: { rpc } })).toHaveLength(TRENDING_DECK_COUNT)
  })

  it('honours an explicit window and limit', async () => {
    const rpc = rpcReturning([])
    await fetchTrendingDeckRows({ client: { rpc }, days: 7, limit: 6 })

    expect(rpc).toHaveBeenCalledWith('get_community_decks', {
      p_sort: 'trending',
      p_limit: 6,
      p_recent_days: 7,
    })
  })

  it('throws on an RPC error so callers can fall back rather than render junk', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: new Error('boom') }))
    await expect(fetchTrendingDeckRows({ client: { rpc } })).rejects.toThrow('boom')
  })

  it.each([
    ['a null payload', null],
    ['a payload with no decks key', {}],
    ['a non-array decks value', { decks: 'nope' }],
  ])('returns an empty list for %s', async (_label, data) => {
    const rpc = vi.fn(async () => ({ data, error: null }))
    expect(await fetchTrendingDeckRows({ client: { rpc } })).toEqual([])
  })
})

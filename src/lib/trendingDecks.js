import { sb } from './supabase'

// The "Trending" query, shared by the two surfaces that show it: the Deck
// Browser headliner (`/builder?tab=browser`) and the Home dashboard panel. They
// enrich and cache the result differently, but they must ask the same question —
// they are the same feature, and previously each carried its own copy of the
// window and its own filtering.
//
// Trending means "picked up the most likes in the last N days", ranked by likes
// inside the window with all-time likes only as the tiebreak. It is NOT an
// all-time leaderboard, and the window is NOT about when the deck was last
// edited. Both of those were true until 2026-09-03; see
// 20260903103000_trending_by_recent_likes.sql for what that produced.
//
// The windowing belongs to the RPC (`p_recent_days`), not to the caller. Doing
// it here would mean filtering rows the server had already truncated to
// TRENDING_DECK_COUNT, so a single excluded deck would leave the section short
// with nothing promoted in its place. If you find yourself adding a .filter()
// to the result of this function, that is the bug coming back.

export const TRENDING_WINDOW_DAYS = 30
export const TRENDING_DECK_COUNT = 3

export async function fetchTrendingDeckRows({
  client = sb,
  days = TRENDING_WINDOW_DAYS,
  limit = TRENDING_DECK_COUNT,
} = {}) {
  const { data, error } = await client.rpc('get_community_decks', {
    p_sort: 'trending',
    p_limit: limit,
    p_recent_days: days,
  })
  if (error) throw error
  return Array.isArray(data?.decks) ? data.decks : []
}

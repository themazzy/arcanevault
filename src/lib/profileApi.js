import { sb } from './supabase'

// Fetchers for the public profile page, shaped for React Query.
//
// The page used to fire, on every visit: get_public_profile, get_public_decks,
// one get_deck_cards_for_view PER art-less deck, getUserFollowStats twice (page
// + FollowButton), and two game_results selects — with no caching, so going back
// to a profile re-ran all of it. get_public_decks now resolves commander art
// server-side and get_public_profile reads a precomputed row, so this is down to
// three cached calls.

export const PROFILE_STALE_MS = 5 * 60 * 1000

export async function fetchPublicProfile(username) {
  const { data, error } = await sb.rpc('get_public_profile', { p_username: username })
  if (error) throw error
  return data ?? null
}

export async function fetchPublicDecks(username) {
  const { data, error } = await sb.rpc('get_public_decks', { p_username: username })
  if (error) throw error
  return Array.isArray(data) ? data : []
}

export async function fetchFollowList(username, kind) {
  const { data, error } = await sb.rpc('get_user_follow_list', {
    p_username: username,
    p_kind: kind,
  })
  if (error) throw error
  return Array.isArray(data) ? data : []
}

// Rebuilds the caller's own profile_stats row. The nightly pg_cron job keeps
// everyone fresh; this is what stops YOUR page showing yesterday's totals right
// after an import. Fire-and-forget — a failure just means the cached numbers
// stay a few hours old.
export async function refreshMyProfileStats() {
  const { error } = await sb.rpc('refresh_my_profile_stats')
  if (error) throw error
}

export const profileKeys = {
  profile: username => ['publicProfile', username],
  decks: username => ['publicDecks', username],
  follows: (username, kind) => ['followList', username, kind],
}

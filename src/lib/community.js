// Client helpers for the community layer (likes, comments, follows,
// notifications). Public reads go through SECURITY DEFINER RPCs; writes are
// direct, RLS-gated table ops.
import { sb } from './supabase'

// ── Likes ─────────────────────────────────────────────────────────────────
export async function getDeckSocial(deckId) {
  const { data, error } = await sb.rpc('get_deck_social', { p_deck_id: deckId })
  if (error) throw error
  return data || null   // { like_count, comment_count, viewer_liked, is_owner }
}

export async function setDeckLike(deckId, userId, like) {
  if (like) {
    const { error } = await sb.from('deck_likes').upsert({ deck_id: deckId, user_id: userId }, { onConflict: 'deck_id,user_id', ignoreDuplicates: true })
    if (error) throw error
  } else {
    const { error } = await sb.from('deck_likes').delete().eq('deck_id', deckId).eq('user_id', userId)
    if (error) throw error
  }
}

// ── Comments ──────────────────────────────────────────────────────────────
export async function getDeckComments(deckId) {
  const { data, error } = await sb.rpc('get_deck_comments', { p_deck_id: deckId })
  if (error) throw error
  return data || []
}

export async function postComment(deckId, userId, body) {
  const trimmed = String(body || '').trim().slice(0, 2000)
  if (!trimmed) return
  const { error } = await sb.from('deck_comments').insert({ deck_id: deckId, user_id: userId, body: trimmed })
  if (error) throw error
}

export async function deleteComment(commentId) {
  const { error } = await sb.from('deck_comments').delete().eq('id', commentId)
  if (error) throw error
}

// ── Follows ───────────────────────────────────────────────────────────────
export async function getUserFollowStats(username) {
  const { data, error } = await sb.rpc('get_user_follow_stats', { p_username: username })
  if (error) throw error
  return data || null   // { user_id, follower_count, following_count, viewer_following, is_self }
}

export async function setFollow(followerId, followingId, follow) {
  if (follow) {
    const { error } = await sb.from('user_follows').upsert({ follower_id: followerId, following_id: followingId }, { onConflict: 'follower_id,following_id', ignoreDuplicates: true })
    if (error) throw error
  } else {
    const { error } = await sb.from('user_follows').delete().eq('follower_id', followerId).eq('following_id', followingId)
    if (error) throw error
  }
}

// ── Discovery ─────────────────────────────────────────────────────────────
export async function listPublicDecks({ sort = 'popular', format = null, limit = 24, offset = 0 } = {}) {
  const { data, error } = await sb.rpc('list_public_decks', { p_sort: sort, p_format: format, p_limit: limit, p_offset: offset })
  if (error) throw error
  return data || []
}

// ── Notifications ─────────────────────────────────────────────────────────
export async function getMyNotifications(limit = 30) {
  const { data, error } = await sb.rpc('get_my_notifications', { p_limit: limit })
  if (error) throw error
  return data || []
}

export async function getUnreadNotificationCount() {
  const { count, error } = await sb
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('read', false)
  if (error) throw error
  return count || 0
}

export async function markAllNotificationsRead() {
  const { error } = await sb.rpc('mark_all_notifications_read')
  if (error) throw error
}

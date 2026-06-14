// Deck-level action history (printing optimizations, visibility, bracket,
// imports, commander/format changes…). One row per discrete action — NOT
// per-card diffs. Logging is best-effort and must never block the action.

import { sb } from './supabase'

export function logDeckChange(deckId, userId, action, detail = null) {
  if (!deckId || !userId || !action) return
  // Fire-and-forget; a history write failing should never surface to the user.
  sb.from('deck_changes')
    .insert({ deck_id: deckId, user_id: userId, action, detail })
    .then(({ error }) => { if (error) console.warn('[deckHistory]', error.message) })
}

export async function fetchDeckHistory(deckId, { limit = 100 } = {}) {
  if (!deckId) return []
  const { data, error } = await sb
    .from('deck_changes')
    .select('id, action, detail, created_at')
    .eq('deck_id', deckId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data || []
}

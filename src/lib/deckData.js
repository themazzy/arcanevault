import { sb } from './supabase'

export async function fetchDeckCards(deckId) {
  const { data, error } = await sb
    .from('deck_cards_view')
    .select('*')
    .eq('deck_id', deckId)
    .order('is_commander', { ascending: false })

  if (error) throw error
  return data || []
}

export async function fetchDeckAllocations(deckId) {
  const { data, error } = await sb
    .from('deck_allocations_view')
    .select('*')
    .eq('deck_id', deckId)

  if (error) throw error
  return data || []
}

export async function fetchDeckAllocationsForUser(userId) {
  const { data, error } = await sb
    .from('deck_allocations_view')
    .select('*')
    .eq('user_id', userId)

  if (error) throw error
  return data || []
}

export async function upsertDeckAllocations(deckId, userId, rows) {
  if (!rows?.length) return

  const payload = rows.map(row => ({
    id: row.id,
    deck_id: deckId,
    user_id: userId,
    card_id: row.card_id,
    qty: row.qty,
  }))

  const { error } = await sb
    .from('deck_allocations')
    .upsert(payload, { onConflict: 'deck_id,card_id' })

  if (error) throw error
}

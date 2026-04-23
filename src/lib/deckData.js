import { sb } from './supabase'

export function mergeAllocationRows(rows) {
  const merged = new Map()

  for (const row of rows || []) {
    if (!row?.card_id || !(row.qty > 0)) continue
    const existing = merged.get(row.card_id)
    if (existing) {
      existing.qty += row.qty
      continue
    }
    merged.set(row.card_id, {
      ...row,
      qty: row.qty,
    })
  }

  return [...merged.values()]
}

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
  const mergedRows = mergeAllocationRows(rows)
  if (!mergedRows.length) return

  const payload = mergedRows.map(row => ({
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

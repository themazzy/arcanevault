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

// Only used to build the ownership-badge match sets (deckAllocationKeys needs
// card_print_id/scryfall_id/name/foil, plus deck_id to exclude the current
// deck). Selecting just these columns — instead of deck_allocations_view's
// full column list, which joins card_prints for several unused wide fields —
// lets Postgres prune that join's projection: ~3x faster for users with a
// few thousand allocations, where the unpruned query risked the 8s
// authenticated statement timeout and left the badge showing stale data.
//
// Paginated — PostgREST caps an unbounded query at 1000 rows by default, and
// a large collection can have several thousand allocations. Without this,
// rows past the first page are silently dropped, which showed up as the
// ownership badge saying "Owned" for a card that was actually allocated to
// another deck outside the truncated result.
const PAGE_SIZE = 1000
export async function fetchDeckAllocationsForUser(userId) {
  const rows = []
  let from = 0
  while (true) {
    const { data, error } = await sb
      .from('deck_allocations_view')
      .select('deck_id, card_print_id, scryfall_id, name, foil')
      .eq('user_id', userId)
      .order('id')
      .range(from, from + PAGE_SIZE - 1)

    if (error) throw error
    if (data?.length) rows.push(...data)
    if (!data || data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return rows
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

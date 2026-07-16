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

const ALLOCATION_MATCH_COLS = 'deck_id, card_print_id, scryfall_id, name, foil'
const ALLOCATION_PAGE_SIZE = 1000

// PostgREST silently caps an unbounded query at 1000 rows. Each identity tier
// below can plausibly exceed that (e.g. a basic land allocated across dozens
// of collection decks matches once per deck in the name tier), so every tier
// pages through its full result instead of trusting a single response.
async function fetchAllAllocationPages(buildQuery) {
  const rows = []
  let from = 0
  while (true) {
    const { data, error } = await buildQuery()
      .order('id')
      .range(from, from + ALLOCATION_PAGE_SIZE - 1)
    if (error) throw error
    if (data?.length) rows.push(...data)
    if (!data || data.length < ALLOCATION_PAGE_SIZE) break
    from += ALLOCATION_PAGE_SIZE
  }
  return rows
}

// Only used to build the ownership-badge match sets (deckAllocationKeys needs
// card_print_id/scryfall_id/name/foil, plus deck_id to exclude the current
// deck). Scoped to the identities of one deck's card list — via
// collectCardIdentities() — instead of fetching every allocation the user
// owns across all their decks: that scaled with total collection size (an
// unbounded query previously either risked the 8s authenticated statement
// timeout, or silently truncated at PostgREST's 1000-row default and dropped
// the exact allocation the badge needed to find). This scales with the
// current deck's card count instead, which stays bounded regardless of how
// large the rest of the collection grows.
//
// Runs the print/scryfall/name tiers as separate queries and merges the
// results. The name query preloads allocations for alternate printings so a
// DeckBuilder version change can recalculate its badge immediately; the badge
// matcher still requires the exact print + foil when identifiers are present.
export async function fetchDeckAllocationsForCardIdentities(userId, { cardPrintIds = [], scryfallIds = [], names = [] } = {}) {
  const uniqueCardPrintIds = [...new Set(cardPrintIds.filter(Boolean))]
  const uniqueScryfallIds = [...new Set(scryfallIds.filter(Boolean))]
  const uniqueNames = [...new Set(names.filter(Boolean))]
  if (!uniqueCardPrintIds.length && !uniqueScryfallIds.length && !uniqueNames.length) return []

  const queries = []
  if (uniqueCardPrintIds.length) {
    queries.push(fetchAllAllocationPages(() => sb.from('deck_allocations_view').select(ALLOCATION_MATCH_COLS).eq('user_id', userId).in('card_print_id', uniqueCardPrintIds)))
  }
  if (uniqueScryfallIds.length) {
    queries.push(fetchAllAllocationPages(() => sb.from('deck_allocations_view').select(ALLOCATION_MATCH_COLS).eq('user_id', userId).in('scryfall_id', uniqueScryfallIds)))
  }
  if (uniqueNames.length) {
    queries.push(fetchAllAllocationPages(() => sb.from('deck_allocations_view').select(ALLOCATION_MATCH_COLS).eq('user_id', userId).in('name', uniqueNames)))
  }

  const results = await Promise.all(queries)
  const rows = []
  const seen = new Set()
  for (const tierRows of results) {
    for (const row of tierRows) {
      const key = `${row.deck_id}|${row.card_print_id}|${row.scryfall_id}|${row.foil}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(row)
    }
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

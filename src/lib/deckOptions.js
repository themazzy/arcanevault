// Deck choices for the life tracker's "which deck are you playing?" pickers.
//
// The list comes from the same source as the /builder tab — the get_my_decks() RPC
// — so the tracker offers exactly the decks the user already sees there, in the same
// order (most recently modified first, which is also the most useful order when
// picking a deck at the table). That RPC already:
//   - excludes group folders (isGroup) and anything flagged hideFromBuilder
//   - collapses a linked builder/collection pair to a single row
//
// Two things still have to happen client-side.
//
// 1. ATTRIBUTION. get_my_decks keeps the COLLECTION half of a linked pair, but the
//    id a game must be recorded against is the BUILDER half: /builder/:id reads win
//    rates by querying game_results.deck_id against the builder folder id, and a
//    linked collection deck navigates there via linked_builder_id (see
//    DeckBuilder.jsx loadDeckGameResults). Recording against the collection half
//    would appear in Stats but leave the deck builder's win rate empty. So a linked
//    collection row is displayed, and attributed to its builder id.
//
// 2. DISAMBIGUATION. Two decks can share a name without being linked — a builder
//    deck and a collection deck that were never paired. Both are real choices, so
//    both are listed, with a qualifier so they can be told apart.
//
// The dedup and group filtering below duplicate the RPC on purpose: they make this
// function safe over a raw `folders` query too, which is the fallback when the RPC
// is unavailable. On already-deduped RPC rows they are no-ops.
//
// Dependency-free by design — the equivalent helpers in collectionFetchers
// (isGroupFolder) and deckSync (getLinkedDeckIds) pull in supabase, IndexedDB and
// price loading, and this runs on the public /join/:code route too.

import { sb } from './supabase'

export const DECK_TYPE_LABEL = {
  builder_deck: 'Builder',
  deck: 'Collection',
}

/**
 * Load the user's decks exactly as the /builder tab lists them.
 *
 * Falls back to a direct folders query if the RPC is unavailable — an empty deck
 * list would silently cost the user their win/loss record for the game, which is
 * worse than a slightly different order.
 *
 * @param {string} userId
 * @returns {Promise<Array<object>>} buildDeckOptions output
 */
export async function loadDeckOptions(userId) {
  try {
    const { data, error } = await sb.rpc('get_my_decks')
    if (error) throw error
    const rows = typeof data === 'string' ? JSON.parse(data) : data
    if (Array.isArray(rows)) return buildDeckOptions(rows)
  } catch (err) {
    console.warn('[decks] get_my_decks failed, falling back to folders', err?.message || err)
  }

  const { data } = await sb.from('folders')
    .select('id,name,type,description')
    .eq('user_id', userId)
    .in('type', ['deck', 'builder_deck'])
    .order('name')
  return buildDeckOptions(data)
}

function readMeta(row) {
  try { return JSON.parse(row?.description || '{}') } catch { return {} }
}

/**
 * @param {Array<{id:string,name:string,type:string,description?:string,card_count?:number}>} rows
 *   get_my_decks() output, or a raw folders query as a fallback.
 * @returns {Array<{id:string,folderId:string,name:string,type:string,label:string,cardCount:number|null}>}
 *   `id` is what to store in game_results.deck_id; `folderId` is the row itself.
 */
export function buildDeckOptions(rows) {
  const decks = (rows || []).filter(r => r?.id && (r.type === 'deck' || r.type === 'builder_deck'))

  const meta = new Map(decks.map(r => [r.id, readMeta(r)]))
  const present = new Set(decks.map(r => r.id))

  // Only fires on the raw-folders fallback, where both halves of a pair are present.
  // The "present" check matters: a dangling link must not delete a deck from the list.
  const supersededByBuilder = new Set()
  for (const row of decks) {
    if (row.type !== 'builder_deck') continue
    const linkedDeckId = meta.get(row.id)?.linked_deck_id
    if (linkedDeckId && present.has(linkedDeckId)) supersededByBuilder.add(linkedDeckId)
  }

  const kept = decks.filter(row => {
    const rowMeta = meta.get(row.id)
    if (rowMeta?.isGroup === true) return false
    if (rowMeta?.hideFromBuilder === true) return false
    if (row.type === 'deck' && supersededByBuilder.has(row.id)) return false
    return true
  })

  const nameCounts = kept.reduce((counts, row) => {
    const key = row.name?.trim().toLowerCase() || ''
    counts.set(key, (counts.get(key) || 0) + 1)
    return counts
  }, new Map())

  // Input order is preserved: get_my_decks sorts by deck_modified_at desc, so the
  // deck you last touched comes first.
  return kept.map(row => {
    const rowMeta = meta.get(row.id) || {}
    const linkedBuilderId = row.type === 'deck' ? rowMeta.linked_builder_id : null
    const ambiguous = (nameCounts.get(row.name?.trim().toLowerCase() || '') || 0) > 1
    const qualifier = DECK_TYPE_LABEL[row.type]
    return {
      id: linkedBuilderId || row.id,
      folderId: row.id,
      name: row.name,
      type: row.type,
      label: ambiguous && qualifier ? `${row.name} · ${qualifier}` : row.name,
      cardCount: Number.isFinite(row.card_count) ? row.card_count : null,
    }
  })
}

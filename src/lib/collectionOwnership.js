import { sb } from './supabase'
import { deleteCard } from './db'

const PRUNE_BATCH_SIZE = 100

// A card is "placed" if it appears in any folder_cards / deck_allocations row.
// We check the RAW placement rows rather than a folder-resolved map, because
// buildCardFolderMap drops placements whose folder metadata hasn't loaded yet
// (e.g. a just-created binder whose row isn't in the folders cache). Keying
// orphan detection off the resolved map therefore flags freshly-added cards as
// unplaced and prunes them. The optional cardFolderMap is an extra "known
// placed" source (e.g. optimistic post-save patches) — a card is unplaced only
// when absent from both.
export function findUnplacedCardIds(cards, placementData, cardFolderMap = {}) {
  const placedIds = new Set([
    ...(placementData?.folderCards || []).map(row => row.card_id),
    ...(placementData?.deckAllocations || []).map(row => row.card_id),
  ])
  return (cards || [])
    .filter(card => !placedIds.has(card.id) && !(cardFolderMap[card.id]?.length))
    .map(card => card.id)
}

function chunk(items, size = PRUNE_BATCH_SIZE) {
  const chunks = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

/**
 * Delete owned cards that have no placement left anywhere.
 *
 * ⚠ The two Supabase reads below are NOT an optimization and must not be
 * removed. They are the only thing separating a stale cache from real data
 * loss, and this is the one path in the app that hard-deletes `cards` rows.
 *
 * `cardIds` is a list of CANDIDATES derived from local state, and local state
 * is routinely behind the server. Fill a binder on one device and open the app
 * on another: the cards arrive through the sync before their placements do, so
 * for a moment they look unplaced to that second device. Worse,
 * `folderMembershipSynced` in Collection flips true on
 * `placementsQuery.isSuccess`, which a setQueryData seed from IndexedDB
 * satisfies just as well as a network fetch — so the caller's "placements are
 * synced" gate can be true while the placements are purely local.
 *
 * Re-querying folder_cards and deck_allocations here makes that safe: the
 * local view only nominates, and Supabase decides. A card placed on another
 * device appears in these results and survives, whatever the cache believed.
 *
 * Trusting the caller instead would delete a user's cards on a device that
 * simply had not caught up yet — silently, and with no way back.
 */
export async function pruneUnplacedCards(cardIds) {
  const uniqueIds = [...new Set((cardIds || []).filter(Boolean))]
  if (!uniqueIds.length) return []

  const remainingLinks = []
  for (const ids of chunk(uniqueIds)) {
    const { data, error } = await sb
      .from('folder_cards')
      .select('card_id')
      .in('card_id', ids)

    if (error) throw error
    if (data?.length) remainingLinks.push(...data)
  }

  const remainingAllocations = []
  for (const ids of chunk(uniqueIds)) {
    const { data, error } = await sb
      .from('deck_allocations')
      .select('card_id')
      .in('card_id', ids)

    if (error) throw error
    if (data?.length) remainingAllocations.push(...data)
  }

  const placedIds = new Set([
    ...remainingLinks.map(row => row.card_id),
    ...remainingAllocations.map(row => row.card_id),
  ])
  const orphanIds = uniqueIds.filter(id => !placedIds.has(id))
  if (!orphanIds.length) return []

  for (const ids of chunk(orphanIds)) {
    const { error } = await sb.from('cards').delete().in('id', ids)
    if (error) throw error
  }

  await Promise.all(orphanIds.map(id => deleteCard(id)))
  return orphanIds
}

// Bulk-remove binder/list placements. Takes rows of { id: card_id, folderId }
// and issues one folder_cards delete per source folder (chunked), instead of
// one request per row. Delete errors are ignored — matching the callers'
// previous per-row behavior; the post-action IDB refresh resyncs state.
export async function removeFolderCardPlacements(rows) {
  const byFolder = new Map()
  for (const row of rows || []) {
    if (!row?.id || !row?.folderId) continue
    const ids = byFolder.get(row.folderId) || []
    ids.push(row.id)
    byFolder.set(row.folderId, ids)
  }
  for (const [folderId, cardIds] of byFolder) {
    for (const ids of chunk(cardIds)) {
      await sb.from('folder_cards').delete().eq('folder_id', folderId).in('card_id', ids)
    }
  }
}

export async function getPlacedQtyByCardIds(cardIds) {
  const uniqueIds = [...new Set((cardIds || []).filter(Boolean))]
  const qtyByCardId = new Map()
  if (!uniqueIds.length) return qtyByCardId

  for (const ids of chunk(uniqueIds)) {
    const { data, error } = await sb
      .from('folder_cards')
      .select('card_id, qty')
      .in('card_id', ids)

    if (error) throw error
    for (const row of data || []) {
      qtyByCardId.set(row.card_id, (qtyByCardId.get(row.card_id) || 0) + (row.qty || 0))
    }
  }

  for (const ids of chunk(uniqueIds)) {
    const { data, error } = await sb
      .from('deck_allocations')
      .select('card_id, qty')
      .in('card_id', ids)

    if (error) throw error
    for (const row of data || []) {
      qtyByCardId.set(row.card_id, (qtyByCardId.get(row.card_id) || 0) + (row.qty || 0))
    }
  }

  return qtyByCardId
}

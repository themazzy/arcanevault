import { sb } from './supabase'
import { deleteCard } from './db'

const PRUNE_BATCH_SIZE = 100

function chunk(items, size = PRUNE_BATCH_SIZE) {
  const chunks = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

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

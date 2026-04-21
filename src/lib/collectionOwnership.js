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

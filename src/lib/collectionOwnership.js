import { sb } from './supabase'
import { deleteCard } from './db'

export async function pruneUnplacedCards(cardIds) {
  const uniqueIds = [...new Set((cardIds || []).filter(Boolean))]
  if (!uniqueIds.length) return []

  const { data: remainingLinks, error: linksError } = await sb
    .from('folder_cards')
    .select('card_id')
    .in('card_id', uniqueIds)

  if (linksError) throw linksError

  const placedIds = new Set((remainingLinks || []).map(row => row.card_id))
  const orphanIds = uniqueIds.filter(id => !placedIds.has(id))
  if (!orphanIds.length) return []

  const { error: deleteError } = await sb.from('cards').delete().in('id', orphanIds)
  if (deleteError) throw deleteError

  await Promise.all(orphanIds.map(id => deleteCard(id)))
  return orphanIds
}

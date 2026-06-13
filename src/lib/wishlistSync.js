// Wishlist <-> collection sync helpers.
//
// - removeAcquiredFromWishlists: when cards enter the collection, drop the
//   matching wishlist items. Matches on EXACT card_print_id + foil — this is
//   destructive, so we only remove the precise want that was fulfilled (buying
//   a non-foil never clears a foil want, a different printing never clears it).
// - findOwnedCardNames: for "add only if not owned" — matches by card NAME
//   (you own the card in any printing), since that skip is non-destructive and
//   the useful intent is "don't wishlist what I already have".

import { sb } from './supabase'
import { getLocalFolders, deleteListItemsByIds, putListItems } from './db'

function foilKey(printId, foil) {
  return `${printId}|${foil ? 1 : 0}`
}

async function getUserListFolderIds(userId) {
  // IDB-first: the folder list is tiny and the delete is scoped by both
  // folder_id and card_print_id, so a momentarily-stale list is harmless.
  const folders = await getLocalFolders(userId).catch(() => [])
  return (folders || []).filter(f => f.type === 'list').map(f => f.id)
}

/**
 * @param {string} userId
 * @param {Array<{card_print_id: string, foil: boolean}>} acquired
 * @returns {Promise<{removedIds: string[], removedItems: object[]}>}
 */
export async function removeAcquiredFromWishlists(userId, acquired) {
  const wanted = new Set()
  const printIds = new Set()
  for (const a of acquired || []) {
    if (!a?.card_print_id) continue
    printIds.add(a.card_print_id)
    wanted.add(foilKey(a.card_print_id, a.foil))
  }
  if (!printIds.size) return { removedIds: [], removedItems: [] }

  const listFolderIds = await getUserListFolderIds(userId)
  if (!listFolderIds.length) return { removedIds: [], removedItems: [] }

  const { data, error } = await sb
    .from('list_items')
    .select('id, folder_id, card_print_id, foil')
    .in('folder_id', listFolderIds)
    .in('card_print_id', [...printIds])
  if (error) throw error

  const matches = (data || []).filter(row => wanted.has(foilKey(row.card_print_id, row.foil)))
  if (!matches.length) return { removedIds: [], removedItems: [] }

  const removedIds = matches.map(row => row.id)
  const { error: delError } = await sb.from('list_items').delete().in('id', removedIds)
  if (delError) throw delError

  await deleteListItemsByIds(removedIds).catch(() => {})
  return { removedIds, removedItems: matches }
}

/**
 * Lowercased set of card names the user already owns (any printing), limited
 * to the given candidate names. Used to skip already-owned cards when adding
 * to a wishlist.
 * @param {string} userId
 * @param {string[]} names
 * @returns {Promise<Set<string>>}
 */
export async function findOwnedCardNames(userId, names) {
  const unique = [...new Set((names || []).map(n => String(n || '').trim()).filter(Boolean))]
  if (!unique.length) return new Set()

  const owned = new Set()
  // owned_cards_view exposes name (resolved via card_prints post-normalization).
  const CHUNK = 200
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK)
    const { data, error } = await sb
      .from('owned_cards_view')
      .select('name')
      .eq('user_id', userId)
      .in('name', chunk)
    if (error) throw error
    for (const row of data || []) {
      if (row?.name) owned.add(String(row.name).toLowerCase())
    }
  }
  return owned
}

// Re-export so callers can write removed rows back without importing db too.
export { putListItems }

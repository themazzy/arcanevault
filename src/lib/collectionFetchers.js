import { sb } from './supabase'
import { loadCardMapWithSharedPrices } from './sharedCardPrices'
import { createOfflineError } from './networkUtils'

const PAGE = 1000

function assertOnline() {
  if (!navigator.onLine) throw createOfflineError()
}

export function isGroupFolder(folder) {
  try { return JSON.parse(folder?.description || '{}').isGroup === true } catch { return false }
}

export async function fetchCollectionCards(userId) {
  assertOnline()

  const rows = []
  let from = 0
  while (true) {
    const { data, error } = await sb.from('cards')
      .select('*')
      .eq('user_id', userId)
      .order('name')
      .order('id')
      .range(from, from + PAGE - 1)

    if (error) throw error
    if (data?.length) rows.push(...data)
    if (!data || data.length < PAGE) break
    from += PAGE
  }
  return rows
}

export async function fetchFolders(userId, { includeGroups = false } = {}) {
  assertOnline()

  const { data, error } = await sb.from('folders')
    .select('id,name,type,description,updated_at')
    .eq('user_id', userId)
    .order('name')

  if (error) throw error
  const folders = data || []
  return includeGroups ? folders : folders.filter(folder => !isGroupFolder(folder))
}

export async function fetchFolderCardsPaged(folderIds) {
  if (!folderIds?.length) return []
  assertOnline()

  const rows = []
  let from = 0
  while (true) {
    const { data, error } = await sb.from('folder_cards')
      .select('id,card_id,folder_id,qty,updated_at')
      .in('folder_id', folderIds)
      .order('id')
      .range(from, from + PAGE - 1)

    if (error) throw error
    if (data?.length) rows.push(...data)
    if (!data || data.length < PAGE) break
    from += PAGE
  }
  return rows
}

export async function fetchDeckAllocationsPaged(deckIds, userId) {
  if (!deckIds?.length) return []
  assertOnline()

  const rows = []
  let from = 0
  while (true) {
    const { data, error } = await sb.from('deck_allocations')
      .select('id,card_id,deck_id,qty,user_id,updated_at')
      .eq('user_id', userId)
      .in('deck_id', deckIds)
      .order('id')
      .range(from, from + PAGE - 1)

    if (error) throw error
    if (data?.length) rows.push(...data)
    if (!data || data.length < PAGE) break
    from += PAGE
  }
  return rows
}

export async function fetchFolderPlacements({ queryKey }) {
  const [, userId] = queryKey
  assertOnline()

  const folders = await fetchFolders(userId)
  const binderIds = folders.filter(folder => folder.type === 'binder').map(folder => folder.id)
  const deckIds = folders.filter(folder => folder.type === 'deck').map(folder => folder.id)
  const [folderCards, deckAllocations] = await Promise.all([
    fetchFolderCardsPaged(binderIds),
    fetchDeckAllocationsPaged(deckIds, userId),
  ])

  return { folderCards, deckAllocations }
}

export async function fetchSfMap(cards, cacheTtlMs, onProgress) {
  return loadCardMapWithSharedPrices(cards, { onProgress, cacheTtlMs })
}

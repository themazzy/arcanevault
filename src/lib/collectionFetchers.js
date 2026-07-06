import { sb } from './supabase'
import { loadCardMapWithSharedPrices } from './sharedCardPrices'
import { createOfflineError } from './networkUtils'
import { getMeta, setMeta, getLocalCards, putCards, deleteCard, deleteAllCards } from './db'

const PAGE = 1000

function assertOnline() {
  if (!navigator.onLine) throw createOfflineError()
}

export function isGroupFolder(folder) {
  try { return JSON.parse(folder?.description || '{}').isGroup === true } catch { return false }
}

// Read via owned_cards_view so name/set_code/scryfall_id are sourced from
// card_prints (post-5d the base table no longer carries denormalized cols).
// Order by `id` — sorting by `name` on the server forces a top-N heapsort
// over the full join, which times out for large collections. The client
// sorts in the filter worker anyway.
async function fetchAllOwnedCards(userId) {
  assertOnline()

  const rows = []
  let from = 0
  while (true) {
    const { data, error } = await sb.from('owned_cards_view')
      .select('*')
      .eq('user_id', userId)
      .order('id')
      .range(from, from + PAGE - 1)

    if (error) throw error
    if (data?.length) rows.push(...data)
    if (!data || data.length < PAGE) break
    from += PAGE
  }
  return rows
}

async function fetchCardsUpdatedSince(userId, sinceIso) {
  assertOnline()

  const rows = []
  let from = 0
  while (true) {
    const { data, error } = await sb.from('owned_cards_view')
      .select('*')
      .eq('user_id', userId)
      .gt('updated_at', sinceIso)
      .order('id')
      .range(from, from + PAGE - 1)

    if (error) throw error
    if (data?.length) rows.push(...data)
    if (!data || data.length < PAGE) break
    from += PAGE
  }
  return rows
}

// Queries the raw `cards` table (not owned_cards_view) so this skips the
// per-row card_prints join entirely — just an index scan on user_id. Used to
// detect hard deletes, which leave no updated_at trace to pick up otherwise.
async function fetchOwnedCardIds(userId) {
  assertOnline()

  const ids = []
  let from = 0
  while (true) {
    const { data, error } = await sb.from('cards')
      .select('id')
      .eq('user_id', userId)
      .order('id')
      .range(from, from + PAGE - 1)

    if (error) throw error
    if (data?.length) ids.push(...data.map(row => row.id))
    if (!data || data.length < PAGE) break
    from += PAGE
  }
  return ids
}

export function computeIdsToDelete(localIds, freshIds) {
  return [...localIds].filter(id => !freshIds.has(id))
}

function cardsSyncCursorKey(userId) {
  return `cards_synced_at:${userId}`
}

// Fetches the current owned-cards snapshot for a user, syncing only what
// changed since the last call instead of re-pulling the whole collection
// every time (a full re-fetch previously took 10s+ for large collections,
// since every row requires a per-row join against card_prints). Reads/writes
// through IDB and returns the merged full list — same contract as a full
// fetch, callers don't need to know it's incremental under the hood.
export async function syncOwnedCards(userId) {
  const syncStartedAt = new Date().toISOString()
  const cursor = await getMeta(cardsSyncCursorKey(userId))

  if (!cursor) {
    const fullRows = await fetchAllOwnedCards(userId)
    await deleteAllCards(userId)
    await putCards(fullRows)
    await setMeta(cardsSyncCursorKey(userId), syncStartedAt)
    return fullRows
  }

  const localCards = await getLocalCards(userId)
  const localIds = new Set(localCards.map(c => c.id))

  const changed = await fetchCardsUpdatedSince(userId, cursor)
  await putCards(changed)

  const freshIds = new Set(await fetchOwnedCardIds(userId))
  for (const id of computeIdsToDelete(localIds, freshIds)) {
    await deleteCard(id)
  }

  await setMeta(cardsSyncCursorKey(userId), syncStartedAt)
  return getLocalCards(userId)
}

export async function fetchCollectionCards(userId) {
  return syncOwnedCards(userId)
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
  return loadCardMapWithSharedPrices(cards, { onProgress, cacheTtlMs, priceLookup: 'set' })
}

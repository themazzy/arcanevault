import { sb } from './supabase'
import { loadCardMapWithSharedPrices } from './sharedCardPrices'
import { assertOnline } from './networkUtils'
import { getMeta, setMeta, getLocalCards, getCardsByIds, putCards, deleteCard, deleteAllCards } from './db'
import { fetchAllByKeyset, fetchAllByKeysetSharded } from './keysetPager'
import { chunkIds } from './deckBuilderHelpers'

const PAGE = 1000

export function isGroupFolder(folder) {
  try { return JSON.parse(folder?.description || '{}').isGroup === true } catch { return false }
}

/**
 * Resolve owned-card rows by id, IDB first, fetching whatever is missing.
 *
 * For any caller that has just pulled fresh placement rows from Supabase: those
 * rows can point at cards the local cache has never seen — created on another
 * device, or by a surface that reached Supabase before IDB caught up. Joining
 * them against `getCardsByIds` alone silently DROPS such placements, so the
 * reconcile that was supposed to repair the view instead renders it empty. That
 * is what made a freshly scanned binder show nothing until the user visited
 * Collection and triggered syncOwnedCards.
 *
 * Anything fetched is written through, so the next paint is local again. Never
 * use this for a first paint — it does a round trip; the IDB-only read is the
 * right call there.
 */
export async function loadOwnedCardsByIds(userId, ids) {
  const unique = [...new Set((ids || []).filter(Boolean))]
  if (!unique.length) return []

  const local = await getCardsByIds(unique)
  const byId = new Map(local.map(row => [row.id, row]))
  const missing = unique.filter(id => !byId.has(id))

  if (missing.length && userId) {
    try {
      assertOnline()
      const fetched = []
      for (const batch of chunkIds(missing)) {
        const { data, error } = await sb.from('owned_cards_view')
          .select('*')
          .eq('user_id', userId)
          .in('id', batch)
        if (error) throw error
        if (data?.length) fetched.push(...data)
      }
      if (fetched.length) {
        await putCards(fetched).catch(() => {})
        for (const row of fetched) byId.set(row.id, row)
      }
    } catch (err) {
      // Offline, or the fetch failed: fall back to whatever IDB had. Callers
      // render fewer cards rather than none.
      console.warn('[collection] could not resolve cards missing locally:', err?.message || err)
    }
  }

  return unique.map(id => byId.get(id)).filter(Boolean)
}

// Read via owned_cards_view so name/set_code/scryfall_id are sourced from
// card_prints (post-5d the base table no longer carries denormalized cols).
// Order by `id` — sorting by `name` on the server forces a top-N heapsort
// over the full join, which times out for large collections. The client
// sorts in the filter worker anyway.
//
// Paged by keyset, not OFFSET: every scanned row costs a card_prints join, so
// OFFSET paging re-paid that join for all skipped rows and blew the 8s
// statement timeout partway through a 12k-card collection (see keysetPager.js).
// Sharded: this is the cold-cache path (first load on a device), where a single
// serial walk costs one round trip per 1000 cards. Incremental syncs below stay
// on the plain walk — they rarely exceed one page.
async function fetchAllOwnedCards(userId) {
  assertOnline()

  return fetchAllByKeysetSharded(() => sb.from('owned_cards_view')
    .select('*')
    .eq('user_id', userId), { page: PAGE })
}

async function fetchCardsUpdatedSince(userId, sinceIso) {
  assertOnline()

  return fetchAllByKeyset(() => sb.from('owned_cards_view')
    .select('*')
    .eq('user_id', userId)
    .gt('updated_at', sinceIso), { page: PAGE })
}

// Queries the raw `cards` table (not owned_cards_view) so this skips the
// per-row card_prints join entirely — just an index scan on user_id. Used to
// detect hard deletes, which leave no updated_at trace to pick up otherwise.
async function fetchOwnedCardIds(userId) {
  assertOnline()

  const rows = await fetchAllByKeysetSharded(() => sb.from('cards')
    .select('id')
    .eq('user_id', userId), { page: PAGE })
  return rows.map(row => row.id)
}

// One request, no rows on the wire — the cheap gate in front of the id scan
// above (which costs a round trip per 1000 cards).
//
// `limit(0)` rather than `head: true`: the count rides the Content-Range header
// either way, but Chrome logs every bodiless HEAD response as "Fetch failed
// loading" in the console even on a 200, which reads like a real error.
export async function fetchOwnedCardCount(userId) {
  assertOnline()

  const { count, error } = await sb.from('cards')
    .select('id', { count: 'exact' })
    .eq('user_id', userId)
    .limit(0)

  if (error) throw error
  return count || 0
}

// True when the server holds fewer cards than we do after merging this sync's
// changes — i.e. something was hard-deleted (or a past sync left us short).
//
// Every insert reaches us through the updated_at fetch, so post-merge local
// size is |local| + |new| while the server is |local| - |deleted| + |new|:
// the two agree exactly when nothing was deleted. That makes the count a
// sufficient trigger for the full id scan, and lets the common case (nothing
// deleted) skip it entirely.
export function needsDeleteScan(localIdCount, serverCount) {
  return localIdCount !== serverCount
}

export function computeIdsToDelete(localIds, freshIds) {
  return [...localIds].filter(id => !freshIds.has(id))
}

function cardsSyncCursorKey(userId) {
  return `cards_synced_at:${userId}`
}

// The cursor is derived from server-written updated_at values (see
// advanceCursor), never the device clock — a client clock running ahead of
// the server would otherwise permanently skip rows another device changed
// inside the skew window. The overlap re-fetches a few minutes of already-seen
// rows on every sync, which is idempotent (putCards overwrites), and covers
// writes that committed after our fetch with an updated_at just below the
// cursor (in-flight transactions, sub-second timestamp ties).
export const SYNC_CURSOR_OVERLAP_MS = 5 * 60 * 1000

export function advanceCursor(currentCursor, rows) {
  let max = currentCursor || null
  let maxMs = max ? Date.parse(max) : -Infinity
  for (const row of rows || []) {
    if (!row?.updated_at) continue
    const ms = Date.parse(row.updated_at)
    if (Number.isFinite(ms) && ms > maxMs) { max = row.updated_at; maxMs = ms }
  }
  return max
}

function cursorWithOverlap(cursor) {
  const ms = Date.parse(cursor)
  if (!Number.isFinite(ms)) return cursor
  return new Date(ms - SYNC_CURSOR_OVERLAP_MS).toISOString()
}

// Fetches the current owned-cards snapshot for a user, syncing only what
// changed since the last call instead of re-pulling the whole collection
// every time (a full re-fetch previously took 10s+ for large collections,
// since every row requires a per-row join against card_prints). Reads/writes
// through IDB and returns the merged full list — same contract as a full
// fetch, callers don't need to know it's incremental under the hood.
export async function syncOwnedCards(userId) {
  const cursor = await getMeta(cardsSyncCursorKey(userId))

  if (!cursor) {
    const fullRows = await fetchAllOwnedCards(userId)
    await deleteAllCards(userId)
    await putCards(fullRows)
    // An empty collection stores no cursor and stays on the (trivially cheap)
    // full-fetch path until it has a server timestamp to anchor to.
    const nextCursor = advanceCursor(null, fullRows)
    if (nextCursor) await setMeta(cardsSyncCursorKey(userId), nextCursor)
    return fullRows
  }

  const localCards = await getLocalCards(userId)
  const localIds = new Set(localCards.map(c => c.id))

  const [changed, serverCount] = await Promise.all([
    fetchCardsUpdatedSince(userId, cursorWithOverlap(cursor)),
    fetchOwnedCardCount(userId),
  ])
  await putCards(changed)

  // The id scan pages the whole collection — a round trip per 1000 cards on
  // every sync, which dominated Home's load for a large collection. The count
  // above tells us whether it can be skipped, which it almost always can.
  const mergedIds = new Set(localIds)
  for (const row of changed) mergedIds.add(row.id)

  if (needsDeleteScan(mergedIds.size, serverCount)) {
    const freshIds = new Set(await fetchOwnedCardIds(userId))
    for (const id of computeIdsToDelete(localIds, freshIds)) {
      await deleteCard(id)
    }
  }

  await setMeta(cardsSyncCursorKey(userId), advanceCursor(cursor, changed))
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

  // Return the folders fetched alongside the placements so consumers build their
  // card→folder map from one consistent snapshot. Building it from a separately
  // cached `folders` list that lags behind lets buildCardFolderMap silently drop
  // placements whose folder isn't loaded yet (e.g. a just-created binder).
  return { folders, folderCards, deckAllocations }
}

export async function fetchSfMap(cards, onProgress) {
  return loadCardMapWithSharedPrices(cards, { onProgress, priceLookup: 'set' })
}

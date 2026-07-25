import { sb } from './supabase'
import { parseDeckMeta } from './deckBuilderApi'
import { boardForCard } from './attractions'

function normalizeName(name) {
  return String(name || '').trim().toLowerCase()
}

export function diffDeckMeta(baseMeta = {}, nextMeta = {}) {
  const base = baseMeta || {}
  const next = nextMeta || {}
  const patch = {}
  const removeKeys = []
  const keys = new Set([...Object.keys(base), ...Object.keys(next)])
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) {
      removeKeys.push(key)
      continue
    }
    if (JSON.stringify(base[key]) !== JSON.stringify(next[key])) patch[key] = next[key]
  }
  return { patch, removeKeys }
}

export async function patchDeckMeta(folderId, baseMeta, nextMeta) {
  if (!folderId) throw new Error('Missing folder id')
  const { patch, removeKeys } = diffDeckMeta(baseMeta, nextMeta)
  if (!Object.keys(patch).length && !removeKeys.length) return nextMeta || {}
  const { data, error } = await sb.rpc('patch_deck_meta', {
    p_folder_id: folderId,
    p_patch: patch,
    p_remove_keys: removeKeys,
  })
  if (error) throw error
  return data || nextMeta || {}
}

// folders carries UNIQUE (user_id, name, type), so creating a builder deck named
// after a collection deck fails when a builder deck of that name already exists.
// PostgREST reports it as HTTP 409 / Postgres 23505.
const UNIQUE_VIOLATION = '23505'

export function isUniqueNameConflict(error) {
  if (!error) return false
  return error.code === UNIQUE_VIOLATION || error.status === 409 || error.statusCode === 409
}

/**
 * What to do when "Edit in Builder" collides with an existing builder deck of the
 * same name.
 *
 * The collision is almost always the deck the user wants to pair with — a builder
 * deck and a collection deck holding the same list that were never linked. Before
 * this, the insert simply failed: the operation was impossible in exactly the case
 * where it was most wanted, and there is no other affordance anywhere in the app for
 * pairing two folders that already exist.
 *
 * Adoption is offered rather than performed, because there is no standalone unlink
 * button (unlinkPairedDeck is only wired into the delete flows), so a wrong guess is
 * awkward to undo.
 *
 * @param {object|null} existing the same-name builder deck, or null if none found
 * @returns {{ action: 'adopt'|'already-paired'|'unknown', builderDeckId?: string, reason?: string }}
 */
export function resolveBuilderNameConflict(existing) {
  if (!existing?.id) {
    return { action: 'unknown', reason: 'No builder deck of that name could be found.' }
  }
  const meta = parseDeckMeta(existing.description || '{}')
  if (meta.linked_deck_id) {
    return {
      action: 'already-paired',
      builderDeckId: existing.id,
      reason: `A builder deck named "${existing.name}" is already paired with another collection deck.`,
    }
  }
  return { action: 'adopt', builderDeckId: existing.id }
}

export async function linkDeckPair(builderDeckId, collectionDeckId) {
  const { data, error } = await sb.rpc('link_deck_pair', {
    p_builder_id: builderDeckId,
    p_collection_id: collectionDeckId,
  })
  if (error) throw error
  return data
}

export async function setLinkedDeckVisibility(deckId, isPublic) {
  const { data, error } = await sb.rpc('set_linked_deck_visibility', {
    p_deck_id: deckId,
    p_is_public: !!isPublic,
  })
  if (error) throw error
  return data
}

export async function setLinkedDeckBracket(deckId, bracket, manual = false) {
  const { data, error } = await sb.rpc('set_linked_deck_bracket', {
    p_deck_id: deckId,
    p_bracket: bracket ?? null,
    p_manual: !!manual,
  })
  if (error) throw error
  return data
}

export function getLinkedDeckIds(folderOrMeta) {
  const meta = folderOrMeta?.description != null ? parseDeckMeta(folderOrMeta.description) : (folderOrMeta || {})
  return {
    linkedDeckId: meta.linked_deck_id || null,
    linkedBuilderId: meta.linked_builder_id || null,
  }
}

export function getSyncState(folderOrMeta) {
  const meta = folderOrMeta?.description != null ? parseDeckMeta(folderOrMeta.description) : (folderOrMeta || {})
  return meta.sync_state || {
    version: 1,
    last_sync_at: null,
    last_sync_snapshot: null,
    unsynced_builder: false,
    unsynced_collection: false,
  }
}

/**
 * Set the link fields on one side's meta.
 *
 * ⚠ This does NOT establish a pairing — it only edits a meta object. To create a
 * pair, call linkDeckPair(): the RPC applies the type and relink guards, locks both
 * rows in a stable order, and repoints game_results.deck_id from the collection deck
 * onto the builder deck. A collection deck may have been played for months with no
 * builder counterpart, so skipping that step orphans its win rate.
 *
 * Legitimate uses are re-asserting a link that already exists (persistLinkedSyncSnapshot),
 * remapping ids on restore (backup.js buildLinkedPairUpdates), and as a local fallback
 * when the RPC's return value is unavailable.
 */
export function withLinkedPair(meta, { linkedDeckId = null, linkedBuilderId = null } = {}) {
  const next = { ...meta }
  if (linkedDeckId) next.linked_deck_id = linkedDeckId
  else delete next.linked_deck_id
  if (linkedBuilderId) next.linked_builder_id = linkedBuilderId
  else delete next.linked_builder_id
  return next
}

export function clearLinkedPair(meta, side) {
  const next = { ...meta }
  if (side === 'builder') delete next.linked_deck_id
  if (side === 'collection') delete next.linked_builder_id
  delete next.sync_state
  return next
}

export function writeSyncState(meta, syncState) {
  return {
    ...meta,
    sync_state: {
      version: 1,
      last_sync_at: syncState?.last_sync_at || null,
      last_sync_snapshot: syncState?.last_sync_snapshot || null,
      unsynced_builder: !!syncState?.unsynced_builder,
      unsynced_collection: !!syncState?.unsynced_collection,
    },
  }
}

export function getLogicalKey(row) {
  const foil = row?.foil ? '1' : '0'
  if (row?.card_print_id) return `cp:${row.card_print_id}|${foil}`
  if (row?.scryfall_id) return `sf:${row.scryfall_id}|${foil}`
  const set = String(row?.set_code || '').toLowerCase()
  const cn = String(row?.collector_number || '').toLowerCase()
  if (set && cn) return `nsc:${normalizeName(row?.name)}|${set}|${cn}|${foil}`
  return `name:${normalizeName(row?.name)}|${foil}`
}

export function normalizeBuilderCards(rows) {
  const map = new Map()
  for (const row of rows || []) {
    const key = getLogicalKey(row)
    const current = map.get(key) || {
      key,
      source: 'builder',
      name: row.name,
      scryfall_id: row.scryfall_id || null,
      set_code: row.set_code || null,
      collector_number: row.collector_number || null,
      foil: !!row.foil,
      board: boardForCard(row, null, row.board || 'main'),
      qty: 0,
      is_commander: false,
    }
    current.qty += row.qty || 0
    current.is_commander = current.is_commander || !!row.is_commander
    map.set(key, current)
  }
  return [...map.values()]
}

export function normalizeCollectionAllocations(rows) {
  const map = new Map()
  for (const row of rows || []) {
    const key = getLogicalKey(row)
    const current = map.get(key) || {
      key,
      source: 'collection',
      name: row.name,
      scryfall_id: row.scryfall_id || null,
      set_code: row.set_code || null,
      collector_number: row.collector_number || null,
      foil: !!row.foil,
      board: boardForCard(row, null, row.board || 'main'),
      qty: 0,
      allocations: [],
    }
    current.qty += row.qty || 0
    current.allocations.push(row)
    map.set(key, current)
  }
  return [...map.values()]
}

function toMap(rows) {
  return new Map((rows || []).map(row => [row.key, row]))
}

export function buildSyncSnapshot({ builderCards, collectionCards }) {
  return {
    builder_cards: normalizeBuilderCards(builderCards),
    collection_cards: normalizeCollectionAllocations(collectionCards).map(({ allocations: _allocations, ...rest }) => rest),
  }
}

export function buildSyncDiff({ baseline, builderCards, collectionCards }) {
  const baseBuilder = toMap(baseline?.builder_cards || [])
  const baseCollection = toMap(baseline?.collection_cards || [])
  const currentBuilder = toMap(normalizeBuilderCards(builderCards))
  const currentCollection = toMap(normalizeCollectionAllocations(collectionCards).map(({ allocations: _allocations, ...rest }) => rest))

  const allKeys = new Set([
    ...baseBuilder.keys(),
    ...baseCollection.keys(),
    ...currentBuilder.keys(),
    ...currentCollection.keys(),
  ])

  const builderOnly = []
  const collectionOnly = []
  const conflicts = []

  // When a baseline row has been removed from both sides since the snapshot,
  // currentBuilder/currentCollection have no entry for the key — fall back to
  // the baseline row so the diff still carries name/print metadata. Without
  // this, SyncModal renders the placeholder "Card" with empty quantities.
  const builderRowFor = key => currentBuilder.get(key) || baseBuilder.get(key) || null
  const collectionRowFor = key => currentCollection.get(key) || baseCollection.get(key) || null

  for (const key of allKeys) {
    const baseB = baseBuilder.get(key)?.qty || 0
    const baseC = baseCollection.get(key)?.qty || 0
    const currB = currentBuilder.get(key)?.qty || 0
    const currC = currentCollection.get(key)?.qty || 0
    const builderChanged = currB !== baseB
    const collectionChanged = currC !== baseC
    if (!builderChanged && !collectionChanged) continue
    // If the card is gone from both current states, there's nothing actionable
    // — skip the phantom diff entry so it doesn't surface in the UI.
    if (currB === 0 && currC === 0) continue
    if (builderChanged && !collectionChanged) {
      builderOnly.push({
        key,
        baselineQty: Math.max(baseB, baseC),
        builderQty: currB,
        collectionQty: currC,
        builder: builderRowFor(key),
        collection: collectionRowFor(key),
      })
      continue
    }
    if (!builderChanged && collectionChanged) {
      collectionOnly.push({
        key,
        baselineQty: Math.max(baseB, baseC),
        builderQty: currB,
        collectionQty: currC,
        builder: builderRowFor(key),
        collection: collectionRowFor(key),
      })
      continue
    }
    if (currB === currC) continue
    conflicts.push({
      key,
      baselineBuilderQty: baseB,
      baselineCollectionQty: baseC,
      builderQty: currB,
      collectionQty: currC,
      builder: builderRowFor(key),
      collection: collectionRowFor(key),
    })
  }

  return { builderOnly, collectionOnly, conflicts }
}

/**
 * The current state of both sides, in the shape buildSyncDiff expects as a baseline.
 * Used to record "these two agree right now" as the new reference point.
 */
export function buildPairSnapshot({ builderCards, collectionCards }) {
  return {
    builder_cards: normalizeBuilderCards(builderCards || []),
    collection_cards: normalizeCollectionAllocations(collectionCards || [])
      .map(({ allocations: _allocations, ...rest }) => rest),
  }
}

/** Does either side still claim to be out of sync? */
export function hasStaleUnsyncedFlag(...metas) {
  return metas.some(meta => {
    const state = getSyncState(meta)
    return !!(state.unsynced_builder || state.unsynced_collection)
  })
}

/**
 * Clear an unsynced flag that a fresh comparison has disproved.
 *
 * `unsynced_builder` / `unsynced_collection` are a cached hint, written whenever
 * drift becomes possible — at link time, or on an edit to either side. Until now
 * they were only ever cleared by persistLinkedSyncSnapshot, which runs after an
 * apply. So a pair whose sides had converged (or were never actually different) kept
 * its badge forever: opening the sync review reported no changes, there was nothing
 * to apply, and nothing wrote the flag back down.
 *
 * Recording the snapshot as well as clearing the flags matters, because these pairs
 * have last_sync_snapshot: null — with no baseline every future comparison starts
 * from scratch.
 *
 * @returns {Promise<object|null>} persisted metas, or null when there was nothing to fix
 */
export async function reconcileCleanPair({ builderDeckId, collectionDeckId, snapshot }) {
  if (!builderDeckId || !collectionDeckId) return null

  const rows = await fetchLinkedDeckPair(builderDeckId, collectionDeckId)
  const builder = rows.find(row => row.id === builderDeckId)
  const collection = rows.find(row => row.id === collectionDeckId)
  if (!builder || !collection) return null

  const builderMeta = parseDeckMeta(builder.description)
  const collectionMeta = parseDeckMeta(collection.description)
  if (!hasStaleUnsyncedFlag(builderMeta, collectionMeta)) return null

  return persistLinkedSyncSnapshot({
    builderDeckId,
    collectionDeckId,
    builderMeta,
    collectionMeta,
    snapshot,
    hasUnresolved: false,
  })
}

export function summarizeSyncDiff(diff) {
  const total = (diff?.builderOnly?.length || 0) + (diff?.collectionOnly?.length || 0) + (diff?.conflicts?.length || 0)
  return {
    total,
    dirty: total > 0,
  }
}

export async function persistLinkedSyncSnapshot({
  builderDeckId,
  collectionDeckId,
  builderMeta,
  collectionMeta,
  snapshot,
  hasUnresolved = false,
}) {
  const now = new Date().toISOString()
  const builderNext = writeSyncState(builderMeta, {
    last_sync_at: now,
    last_sync_snapshot: snapshot,
    unsynced_builder: hasUnresolved,
    unsynced_collection: hasUnresolved,
  })
  const collectionNext = writeSyncState(collectionMeta, {
    last_sync_at: now,
    last_sync_snapshot: snapshot,
    unsynced_builder: hasUnresolved,
    unsynced_collection: hasUnresolved,
  })
  const [persistedBuilder, persistedCollection] = await Promise.all([
    patchDeckMeta(builderDeckId, builderMeta, builderNext),
    patchDeckMeta(collectionDeckId, collectionMeta, collectionNext),
  ])
  return { builderNext: persistedBuilder, collectionNext: persistedCollection }
}

export async function markLinkedPairUnsynced({ builderDeckId, collectionDeckId }) {
  const ids = [builderDeckId, collectionDeckId].filter(Boolean)
  if (ids.length < 2) return null

  const { data, error } = await sb.from('folders').select('id, description').in('id', ids)
  if (error) throw error

  const byId = new Map((data || []).map(row => [row.id, row]))
  const builderFolder = byId.get(builderDeckId)
  const collectionFolder = byId.get(collectionDeckId)
  if (!builderFolder || !collectionFolder) return null

  const builderMeta = parseDeckMeta(builderFolder.description || '{}')
  const collectionMeta = parseDeckMeta(collectionFolder.description || '{}')
  const syncState = getSyncState(builderMeta).last_sync_snapshot
    ? getSyncState(builderMeta)
    : getSyncState(collectionMeta)
  const now = new Date().toISOString()

  const builderNext = writeSyncState(builderMeta, {
    last_sync_at: syncState?.last_sync_at || now,
    last_sync_snapshot: syncState?.last_sync_snapshot || null,
    unsynced_builder: true,
    unsynced_collection: true,
  })
  const collectionNext = writeSyncState(collectionMeta, {
    last_sync_at: syncState?.last_sync_at || now,
    last_sync_snapshot: syncState?.last_sync_snapshot || null,
    unsynced_builder: true,
    unsynced_collection: true,
  })

  const [persistedBuilder, persistedCollection] = await Promise.all([
    patchDeckMeta(builderDeckId, builderMeta, builderNext),
    patchDeckMeta(collectionDeckId, collectionMeta, collectionNext),
  ])

  return { builderNext: persistedBuilder, collectionNext: persistedCollection }
}

export async function unlinkPairedDeck({ counterpart }) {
  if (!counterpart?.id) return null
  const counterMeta = parseDeckMeta(counterpart.description)
  const cleared = clearLinkedPair(counterMeta, counterpart.type === 'deck' ? 'collection' : 'builder')
  return patchDeckMeta(counterpart.id, counterMeta, cleared)
}

export async function fetchLinkedDeckPair(builderDeckId, collectionDeckId) {
  const ids = [builderDeckId, collectionDeckId].filter(Boolean)
  if (!ids.length) return []
  const { data, error } = await sb.from('folders').select('*').in('id', ids)
  if (error) throw error
  return data || []
}

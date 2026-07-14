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

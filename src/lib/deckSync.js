import { sb } from './supabase'
import { parseDeckMeta, serializeDeckMeta } from './deckBuilderApi'

function normalizeName(name) {
  return String(name || '').trim().toLowerCase()
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
  if (row?.scryfall_id) return `sf:${row.scryfall_id}|${foil}`
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
      board: row.board || 'main',
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
      board: row.board || 'main',
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
    collection_cards: normalizeCollectionAllocations(collectionCards).map(({ allocations, ...rest }) => rest),
  }
}

export function buildSyncDiff({ baseline, builderCards, collectionCards }) {
  const baseBuilder = toMap(baseline?.builder_cards || [])
  const baseCollection = toMap(baseline?.collection_cards || [])
  const currentBuilder = toMap(normalizeBuilderCards(builderCards))
  const currentCollection = toMap(normalizeCollectionAllocations(collectionCards).map(({ allocations, ...rest }) => rest))

  const allKeys = new Set([
    ...baseBuilder.keys(),
    ...baseCollection.keys(),
    ...currentBuilder.keys(),
    ...currentCollection.keys(),
  ])

  const builderOnly = []
  const collectionOnly = []
  const conflicts = []

  for (const key of allKeys) {
    const baseB = baseBuilder.get(key)?.qty || 0
    const baseC = baseCollection.get(key)?.qty || 0
    const currB = currentBuilder.get(key)?.qty || 0
    const currC = currentCollection.get(key)?.qty || 0
    const builderChanged = currB !== baseB
    const collectionChanged = currC !== baseC
    if (!builderChanged && !collectionChanged) continue
    if (builderChanged && !collectionChanged) {
      builderOnly.push({
        key,
        baselineQty: Math.max(baseB, baseC),
        builderQty: currB,
        collectionQty: currC,
        builder: currentBuilder.get(key) || null,
        collection: currentCollection.get(key) || null,
      })
      continue
    }
    if (!builderChanged && collectionChanged) {
      collectionOnly.push({
        key,
        baselineQty: Math.max(baseB, baseC),
        builderQty: currB,
        collectionQty: currC,
        builder: currentBuilder.get(key) || null,
        collection: currentCollection.get(key) || null,
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
      builder: currentBuilder.get(key) || null,
      collection: currentCollection.get(key) || null,
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
  await Promise.all([
    sb.from('folders').update({ description: serializeDeckMeta(builderNext) }).eq('id', builderDeckId),
    sb.from('folders').update({ description: serializeDeckMeta(collectionNext) }).eq('id', collectionDeckId),
  ])
  return { builderNext, collectionNext }
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

  await Promise.all([
    sb.from('folders').update({ description: serializeDeckMeta(builderNext) }).eq('id', builderDeckId),
    sb.from('folders').update({ description: serializeDeckMeta(collectionNext) }).eq('id', collectionDeckId),
  ])

  return { builderNext, collectionNext }
}

export async function unlinkPairedDeck({ counterpart }) {
  if (!counterpart?.id) return null
  const counterMeta = parseDeckMeta(counterpart.description)
  const cleared = clearLinkedPair(counterMeta, counterpart.type === 'deck' ? 'collection' : 'builder')
  await sb.from('folders').update({ description: serializeDeckMeta(cleared) }).eq('id', counterpart.id)
  return cleared
}

export async function fetchLinkedDeckPair(builderDeckId, collectionDeckId) {
  const ids = [builderDeckId, collectionDeckId].filter(Boolean)
  if (!ids.length) return []
  const { data, error } = await sb.from('folders').select('*').in('id', ids)
  if (error) throw error
  return data || []
}

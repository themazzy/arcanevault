// ── backup.js ─────────────────────────────────────────────────────────────────
// Full-collection backup (export) and restore. The exported JSON is
// self-contained: cards/list items/deck cards carry scryfall_id + print
// metadata instead of local card_print_id, so a restore can re-resolve prints
// on any account. folders/cards/deck_categories ids are carried through only
// as cross-reference keys within the file — restore always assigns fresh ids
// and inserts additively; it never deletes or overwrites existing data.

import { sb } from './supabase'
import { ensureCardPrints, getCardPrint } from './cardPrints'
import { additiveSaveOwnedCards, additiveSaveWishlistItems, ownedCardKey } from './deckBuilderWrites'
import { parseDeckMeta, serializeDeckMeta } from './deckBuilderApi'
import { getLinkedDeckIds, withLinkedPair } from './deckSync'
import { downloadFile } from './exportUtils'

export const BACKUP_APP = 'deckloom'
export const BACKUP_KIND = 'collection-backup'
export const BACKUP_VERSION = 1

const PAGE = 1000
const INSERT_BATCH = 500
const ID_BATCH = 200

function chunk(items, size) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function pagedSelect(makeQuery) {
  const rows = []
  let from = 0
  while (true) {
    const { data, error } = await makeQuery(from, from + PAGE - 1)
    if (error) throw error
    if (data?.length) rows.push(...data)
    if (!data || data.length < PAGE) break
    from += PAGE
  }
  return rows
}

async function pagedSelectByIds(ids, makeQuery) {
  if (!ids?.length) return []
  const rows = []
  for (const idsBatch of chunk(ids, ID_BATCH)) {
    rows.push(...await pagedSelect((from, to) => makeQuery(idsBatch, from, to)))
  }
  return rows
}

// ── Export: fetchers (flat queries only — see CLAUDE.md nested-select gotcha) ─

async function fetchAllFolders(userId) {
  const { data, error } = await sb.from('folders')
    .select('id,name,type,description')
    .eq('user_id', userId)
    .order('name')
  if (error) throw error
  return data || []
}

function fetchOwnedCards(userId) {
  return pagedSelect((from, to) => sb.from('owned_cards_view')
    .select('id,scryfall_id,name,set_code,collector_number,qty,foil,condition,language,purchase_price,currency,misprint,altered')
    .eq('user_id', userId)
    .order('id')
    .range(from, to))
}

function fetchFolderCardsFull(folderIds) {
  return pagedSelectByIds(folderIds, (ids, from, to) => sb.from('folder_cards')
    .select('folder_id,card_id,qty,trade_any_version,trade_note')
    .in('folder_id', ids)
    .order('id')
    .range(from, to))
}

function fetchDeckAllocationsFull(deckIds, userId) {
  return pagedSelectByIds(deckIds, (ids, from, to) => sb.from('deck_allocations')
    .select('deck_id,card_id,qty')
    .eq('user_id', userId)
    .in('deck_id', ids)
    .order('id')
    .range(from, to))
}

function fetchListItemsFull(folderIds) {
  return pagedSelectByIds(folderIds, (ids, from, to) => sb.from('list_items_view')
    .select('folder_id,scryfall_id,name,set_code,collector_number,foil,qty')
    .in('folder_id', ids)
    .order('id')
    .range(from, to))
}

function fetchDeckCategoriesFull(deckIds, userId) {
  return pagedSelectByIds(deckIds, (ids, from, to) => sb.from('deck_categories')
    .select('id,deck_id,name,sort_order')
    .eq('user_id', userId)
    .in('deck_id', ids)
    .order('id')
    .range(from, to))
}

function fetchDeckCardsFull(deckIds) {
  return pagedSelectByIds(deckIds, (ids, from, to) => sb.from('deck_cards_view')
    .select('id,deck_id,scryfall_id,name,set_code,collector_number,qty,foil,is_commander,board,category_id')
    .in('deck_id', ids)
    .order('id')
    .range(from, to))
}

export function summarizeBackup(backup) {
  return {
    folders: backup?.folders?.length || 0,
    cards: backup?.cards?.length || 0,
    folderCards: backup?.folder_cards?.length || 0,
    deckAllocations: backup?.deck_allocations?.length || 0,
    listItems: backup?.list_items?.length || 0,
    deckCategories: backup?.deck_categories?.length || 0,
    deckCards: backup?.deck_cards?.length || 0,
  }
}

export async function buildCollectionBackup(userId) {
  const folders = await fetchAllFolders(userId)
  const binderIds = folders.filter(f => f.type === 'binder').map(f => f.id)
  const deckIds = folders.filter(f => f.type === 'deck').map(f => f.id)
  const listIds = folders.filter(f => f.type === 'list').map(f => f.id)
  const builderDeckIds = folders.filter(f => f.type === 'builder_deck').map(f => f.id)

  const [cards, folderCards, deckAllocations, listItems, deckCategories, deckCards] = await Promise.all([
    fetchOwnedCards(userId),
    fetchFolderCardsFull(binderIds),
    fetchDeckAllocationsFull(deckIds, userId),
    fetchListItemsFull(listIds),
    fetchDeckCategoriesFull(builderDeckIds, userId),
    fetchDeckCardsFull(builderDeckIds),
  ])

  return {
    app: BACKUP_APP,
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    folders,
    cards,
    folder_cards: folderCards,
    deck_allocations: deckAllocations,
    list_items: listItems,
    deck_categories: deckCategories,
    deck_cards: deckCards,
  }
}

export async function downloadCollectionBackup(userId) {
  const backup = await buildCollectionBackup(userId)
  const stamp = backup.exported_at.slice(0, 10)
  downloadFile(JSON.stringify(backup, null, 2), `deckloom-backup-${stamp}.json`, 'application/json;charset=utf-8')
  return summarizeBackup(backup)
}

// ── Restore: validation ────────────────────────────────────────────────────────

export function validateBackupFile(data) {
  if (!data || typeof data !== 'object') return 'File is not valid JSON.'
  if (data.app !== BACKUP_APP || data.kind !== BACKUP_KIND) return 'This file is not a DeckLoom collection backup.'
  if (typeof data.version !== 'number' || data.version > BACKUP_VERSION) {
    return 'This backup was created by a newer version of DeckLoom and cannot be restored here.'
  }
  return null
}

// ── Restore: pure row/id-mapping builders (unit-tested without touching Supabase) ─

export function buildFolderInsertRows(folders, userId, genId = () => crypto.randomUUID()) {
  const idMap = new Map()
  const rows = (folders || []).map(f => {
    const newId = genId()
    idMap.set(f.id, newId)
    return { id: newId, user_id: userId, name: f.name, type: f.type, description: f.description ?? null }
  })
  return { rows, idMap }
}

// Linked builder/collection deck pairs store each other's folder id inside
// `description` (see deckSync.js). Restore assigns fresh folder ids, so those
// references must be rewritten or they'd silently point at nothing.
export function buildLinkedPairUpdates(folders, folderIdMap) {
  const updates = []
  for (const f of folders || []) {
    if (!f.description || !f.description.includes('linked_')) continue
    const meta = parseDeckMeta(f.description)
    const { linkedDeckId, linkedBuilderId } = getLinkedDeckIds(meta)
    if (!linkedDeckId && !linkedBuilderId) continue
    const newFolderId = folderIdMap.get(f.id)
    if (!newFolderId) continue
    const nextMeta = withLinkedPair(meta, {
      linkedDeckId: linkedDeckId ? (folderIdMap.get(linkedDeckId) || null) : null,
      linkedBuilderId: linkedBuilderId ? (folderIdMap.get(linkedBuilderId) || null) : null,
    })
    updates.push({ id: newFolderId, description: serializeDeckMeta(nextMeta) })
  }
  return updates
}

// additiveSaveOwnedCards merges rows onto existing owned-card stacks keyed by
// print+foil+language+condition, so several original backup card ids can
// collapse onto one saved row. Map every original id forward from that key.
export function buildCardIdMap(backupCards, savedCards, printMap, getCardPrintFn = getCardPrint) {
  const savedByKey = new Map((savedCards || []).map(row => [ownedCardKey(row), row.id]))
  const idMap = new Map()
  for (const c of backupCards || []) {
    const print = getCardPrintFn(printMap, { id: c.scryfall_id, name: c.name, set_code: c.set_code, collector_number: c.collector_number })
    if (!print) continue
    const key = ownedCardKey({ card_print_id: print.id, foil: c.foil, language: c.language, condition: c.condition })
    const newId = savedByKey.get(key)
    if (newId) idMap.set(c.id, newId)
  }
  return idMap
}

export function buildFolderCardInsertRows(folderCards, folderIdMap, cardIdMap, genId = () => crypto.randomUUID()) {
  const rows = []
  for (const fc of folderCards || []) {
    const folderId = folderIdMap.get(fc.folder_id)
    const cardId = cardIdMap.get(fc.card_id)
    if (!folderId || !cardId) continue
    rows.push({
      id: genId(), folder_id: folderId, card_id: cardId, qty: fc.qty || 1,
      trade_any_version: !!fc.trade_any_version, trade_note: fc.trade_note || null,
    })
  }
  return rows
}

export function buildDeckAllocationInsertRows(deckAllocations, folderIdMap, cardIdMap, userId, genId = () => crypto.randomUUID()) {
  const rows = []
  for (const da of deckAllocations || []) {
    const deckId = folderIdMap.get(da.deck_id)
    const cardId = cardIdMap.get(da.card_id)
    if (!deckId || !cardId) continue
    rows.push({ id: genId(), deck_id: deckId, user_id: userId, card_id: cardId, qty: da.qty || 1 })
  }
  return rows
}

export function groupListItemsByFolder(listItems, folderIdMap) {
  const byFolder = new Map()
  for (const li of listItems || []) {
    const folderId = folderIdMap.get(li.folder_id)
    if (!folderId) continue
    if (!byFolder.has(folderId)) byFolder.set(folderId, [])
    byFolder.get(folderId).push({
      scryfall_id: li.scryfall_id, name: li.name, set_code: li.set_code,
      collector_number: li.collector_number, foil: !!li.foil, qty: li.qty || 1,
    })
  }
  return byFolder
}

export function buildDeckCategoryInsertRows(deckCategories, folderIdMap, userId, genId = () => crypto.randomUUID()) {
  const idMap = new Map()
  const rows = []
  for (const cat of deckCategories || []) {
    const deckId = folderIdMap.get(cat.deck_id)
    if (!deckId) continue
    const newId = genId()
    idMap.set(cat.id, newId)
    rows.push({ id: newId, deck_id: deckId, user_id: userId, name: cat.name, sort_order: cat.sort_order || 0 })
  }
  return { rows, idMap }
}

export function buildDeckCardInsertRows(deckCards, folderIdMap, categoryIdMap, printMap, userId, getCardPrintFn = getCardPrint, genId = () => crypto.randomUUID()) {
  const rows = []
  for (const dc of deckCards || []) {
    const deckId = folderIdMap.get(dc.deck_id)
    if (!deckId) continue
    const print = getCardPrintFn(printMap, { id: dc.scryfall_id, name: dc.name, set_code: dc.set_code, collector_number: dc.collector_number })
    if (!print) continue
    rows.push({
      id: genId(), deck_id: deckId, user_id: userId, card_print_id: print.id,
      qty: dc.qty || 1, foil: !!dc.foil, is_commander: !!dc.is_commander, board: dc.board || 'main',
      category_id: dc.category_id ? (categoryIdMap.get(dc.category_id) || null) : null,
    })
  }
  return rows
}

// ── Restore: orchestration ──────────────────────────────────────────────────────

export async function restoreCollectionBackup(userId, backup, { onProgress } = {}) {
  const invalid = validateBackupFile(backup)
  if (invalid) throw new Error(invalid)

  const printSources = [
    ...(backup.cards || []),
    ...(backup.list_items || []),
    ...(backup.deck_cards || []),
  ].map(row => ({ id: row.scryfall_id, name: row.name, set_code: row.set_code, collector_number: row.collector_number }))
  const printMap = await ensureCardPrints(printSources)
  onProgress?.({ phase: 'prints' })

  const { rows: folderRows, idMap: folderIdMap } = buildFolderInsertRows(backup.folders, userId)
  for (const batch of chunk(folderRows, INSERT_BATCH)) {
    const { error } = await sb.from('folders').insert(batch)
    if (error) throw error
  }
  const linkedUpdates = buildLinkedPairUpdates(backup.folders, folderIdMap)
  for (const u of linkedUpdates) {
    const { error } = await sb.from('folders').update({ description: u.description }).eq('id', u.id)
    if (error) throw error
  }
  onProgress?.({ phase: 'folders', count: folderRows.length })

  const cardRowsForSave = (backup.cards || []).map(c => ({
    user_id: userId,
    scryfall_id: c.scryfall_id, name: c.name, set_code: c.set_code, collector_number: c.collector_number,
    foil: !!c.foil, qty: c.qty || 1, condition: c.condition || 'near_mint', language: c.language || 'en',
    purchase_price: c.purchase_price ?? 0, currency: c.currency || 'EUR',
    misprint: !!c.misprint, altered: !!c.altered,
  }))
  const savedCards = cardRowsForSave.length ? await additiveSaveOwnedCards(cardRowsForSave, 'Backup restore card') : []
  const cardIdMap = buildCardIdMap(backup.cards, savedCards, printMap)
  onProgress?.({ phase: 'cards', count: savedCards.length })

  const folderCardRows = buildFolderCardInsertRows(backup.folder_cards, folderIdMap, cardIdMap)
  for (const batch of chunk(folderCardRows, INSERT_BATCH)) {
    const { error } = await sb.from('folder_cards').insert(batch)
    if (error) throw error
  }

  const deckAllocationRows = buildDeckAllocationInsertRows(backup.deck_allocations, folderIdMap, cardIdMap, userId)
  for (const batch of chunk(deckAllocationRows, INSERT_BATCH)) {
    const { error } = await sb.from('deck_allocations').insert(batch)
    if (error) throw error
  }
  onProgress?.({ phase: 'placements' })

  const listItemsByFolder = groupListItemsByFolder(backup.list_items, folderIdMap)
  for (const [folderId, rows] of listItemsByFolder) {
    await additiveSaveWishlistItems(folderId, userId, rows, 'Backup restore wishlist item')
  }
  onProgress?.({ phase: 'wishlists', count: backup.list_items?.length || 0 })

  const { rows: categoryRows, idMap: categoryIdMap } = buildDeckCategoryInsertRows(backup.deck_categories, folderIdMap, userId)
  for (const batch of chunk(categoryRows, INSERT_BATCH)) {
    const { error } = await sb.from('deck_categories').insert(batch)
    if (error) throw error
  }

  const deckCardRows = buildDeckCardInsertRows(backup.deck_cards, folderIdMap, categoryIdMap, printMap, userId)
  for (const batch of chunk(deckCardRows, INSERT_BATCH)) {
    const { error } = await sb.from('deck_cards').insert(batch)
    if (error) throw error
  }
  onProgress?.({ phase: 'decks', count: deckCardRows.length })

  return {
    folders: folderRows.length,
    cards: savedCards.length,
    folderCards: folderCardRows.length,
    deckAllocations: deckAllocationRows.length,
    listItems: backup.list_items?.length || 0,
    deckCategories: categoryRows.length,
    deckCards: deckCardRows.length,
  }
}

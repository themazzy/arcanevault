/**
 * ArcaneVault local IndexedDB layer
 *
 * Stores:
 *   scryfall    — Scryfall card data (prices, types, images, etc.)
 *   cards       — Mirror of Supabase cards table, for offline use
 *   folders     — Mirror of Supabase folders
 *   folder_cards— Links between folders and owned collection cards
 *   deck_cards  — Cards in builder decks (not necessarily owned)
 *   meta        — Key/value store for sync timestamps, cache versions, etc.
 */

import { openDB } from 'idb'

const DB_NAME    = 'arcanevault'
const DB_VERSION = 6
const SCRYFALL_METADATA_UPDATED_AT_KEY = 'scryfall_metadata_updated_at'
const LEGACY_SCRYFALL_PRICES_UPDATED_AT_KEY = 'scryfall_prices_updated_at'

let _db = null

async function getDb() {
  if (_db) return _db
  _db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      // scryfall store — card data from Scryfall API
      if (!db.objectStoreNames.contains('scryfall')) {
        const sf = db.createObjectStore('scryfall', { keyPath: 'key' })
        sf.createIndex('set_code', 'set_code')
      }

      // cards store — owned cards (mirror of Supabase)
      if (!db.objectStoreNames.contains('cards')) {
        const c = db.createObjectStore('cards', { keyPath: 'id' })
        c.createIndex('user_id',         'user_id')
        c.createIndex('set_code',        'set_code')
        c.createIndex('updated_at',      'updated_at')
      }

      if (!db.objectStoreNames.contains('card_prints')) {
        const cp = db.createObjectStore('card_prints', { keyPath: 'id' })
        cp.createIndex('scryfall_id', 'scryfall_id', { unique: true })
        cp.createIndex('set_code', 'set_code')
      }

      // folder_cards store — links between folders and owned collection cards
      if (!db.objectStoreNames.contains('folder_cards')) {
        const fc = db.createObjectStore('folder_cards', { keyPath: 'id' })
        fc.createIndex('folder_id', 'folder_id')
        fc.createIndex('card_id',   'card_id')
        fc.createIndex('updated_at', 'updated_at')
      } else if (oldVersion < 3) {
        const fc = transaction.objectStore('folder_cards')
        if (!fc.indexNames.contains('updated_at')) fc.createIndex('updated_at', 'updated_at')
      }

      // folders store — binders, decks, wishlists, builder decks
      if (!db.objectStoreNames.contains('folders')) {
        const f = db.createObjectStore('folders', { keyPath: 'id' })
        f.createIndex('user_id', 'user_id')
        f.createIndex('type',    'type')
      }

      // meta store — sync timestamps, settings, cache info
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' })
      }

      if (!db.objectStoreNames.contains('scanner_hashes')) {
        const sh = db.createObjectStore('scanner_hashes', { keyPath: 'scryfall_id' })
        sh.createIndex('name', 'name')
      }

      // deck_cards store (v2) — cards in builder decks, independent of collection
      if (oldVersion < 2) {
        if (!db.objectStoreNames.contains('deck_cards')) {
          const dc = db.createObjectStore('deck_cards', { keyPath: 'id' })
          dc.createIndex('deck_id', 'deck_id')
          dc.createIndex('user_id', 'user_id')
        }
      }

      if (!db.objectStoreNames.contains('deck_allocations')) {
        const da = db.createObjectStore('deck_allocations', { keyPath: 'id' })
        da.createIndex('deck_id', 'deck_id')
        da.createIndex('card_id', 'card_id')
        da.createIndex('user_id', 'user_id')
      }
    }
  })
  return _db
}

// ── Meta helpers ──────────────────────────────────────────────────────────────

export async function getMeta(key) {
  const db = await getDb()
  const row = await db.get('meta', key)
  return row?.value ?? null
}

export async function setMeta(key, value) {
  const db = await getDb()
  await db.put('meta', { key, value })
}

// ── Scryfall data ─────────────────────────────────────────────────────────────

export async function getScryfallEntry(key) {
  const db = await getDb()
  return db.get('scryfall', key)
}

export async function getAllScryfallEntries() {
  const db = await getDb()
  return db.getAll('scryfall')
}

export async function putScryfallEntries(entries) {
  const db = await getDb()
  const tx = db.transaction('scryfall', 'readwrite')
  await Promise.all([
    ...entries.map(e => tx.store.put(e)),
    tx.done,
  ])
}

export async function clearScryfallStore() {
  const db = await getDb()
  await db.clear('scryfall')
  await setMeta(SCRYFALL_METADATA_UPDATED_AT_KEY, null)
  await setMeta(LEGACY_SCRYFALL_PRICES_UPDATED_AT_KEY, null)
}

async function getScryfallMetadataUpdatedAt() {
  const current = await getMeta(SCRYFALL_METADATA_UPDATED_AT_KEY)
  if (current != null) return current

  const legacy = await getMeta(LEGACY_SCRYFALL_PRICES_UPDATED_AT_KEY)
  if (legacy != null) {
    await setMeta(SCRYFALL_METADATA_UPDATED_AT_KEY, legacy)
    return legacy
  }
  return null
}

export async function getScryfallCacheInfo() {
  const db = await getDb()
  const count = await db.count('scryfall')
  const updatedAt = await getScryfallMetadataUpdatedAt()
  return { count, updatedAt }
}

export async function getAllScannerHashEntries() {
  const db = await getDb()
  return db.getAll('scanner_hashes')
}

export async function putScannerHashEntries(entries) {
  if (!entries?.length) return
  const db = await getDb()
  const tx = db.transaction('scanner_hashes', 'readwrite')
  await Promise.all([
    ...entries.map(entry => tx.store.put(entry)),
    tx.done,
  ])
}

export async function clearScannerHashEntries() {
  const db = await getDb()
  await db.clear('scanner_hashes')
}

export async function getScannerHashCount() {
  const db = await getDb()
  return db.count('scanner_hashes')
}

// ── Cards ─────────────────────────────────────────────────────────────────────

export async function getLocalCards(userId) {
  const db = await getDb()
  return db.getAllFromIndex('cards', 'user_id', userId)
}

export async function getCardsByIds(ids) {
  if (!ids?.length) return []
  const db = await getDb()
  const results = await Promise.all(ids.map(id => db.get('cards', id)))
  return results.filter(Boolean)
}

export async function getLocalCardPrints() {
  const db = await getDb()
  return db.getAll('card_prints')
}

export async function putCardPrints(rows) {
  if (!rows?.length) return
  const db = await getDb()
  const tx = db.transaction('card_prints', 'readwrite')
  await Promise.all([
    ...rows.map(r => tx.store.put(r)),
    tx.done,
  ])
}

export async function putCards(cards) {
  if (!cards?.length) return
  const db = await getDb()
  const tx = db.transaction('cards', 'readwrite')
  await Promise.all([
    ...cards.map(c => tx.store.put(c)),
    tx.done,
  ])
}

export async function deleteCard(id) {
  const db = await getDb()
  await db.delete('cards', id)
}

export async function deleteAllCards(userId) {
  const db = await getDb()
  const all = await db.getAllFromIndex('cards', 'user_id', userId)
  const tx = db.transaction('cards', 'readwrite')
  await Promise.all([
    ...all.map(c => tx.store.delete(c.id)),
    tx.done,
  ])
}

// ── Folders ───────────────────────────────────────────────────────────────────

export async function getLocalFolders(userId) {
  const db = await getDb()
  return db.getAllFromIndex('folders', 'user_id', userId)
}

export async function putFolders(folders) {
  if (!folders?.length) return
  const db = await getDb()
  const tx = db.transaction('folders', 'readwrite')
  await Promise.all([
    ...folders.map(f => tx.store.put(f)),
    tx.done,
  ])
}

export async function deleteFolder(id) {
  const db = await getDb()
  await db.delete('folders', id)
  const db2 = await getDb()
  const fcs = await db2.getAllFromIndex('folder_cards', 'folder_id', id)
  const tx = db2.transaction('folder_cards', 'readwrite')
  await Promise.all([...fcs.map(fc => tx.store.delete(fc.id)), tx.done])
}

// ── Folder Cards ──────────────────────────────────────────────────────────────

export async function getLocalFolderCards(folderId) {
  const db = await getDb()
  return db.getAllFromIndex('folder_cards', 'folder_id', folderId)
}

export async function getAllLocalFolderCards(folderIds) {
  const db = await getDb()
  const results = await Promise.all(folderIds.map(id => db.getAllFromIndex('folder_cards', 'folder_id', id)))
  return results.flat()
}

export async function putFolderCards(rows) {
  if (!rows?.length) return
  const db = await getDb()
  const tx = db.transaction('folder_cards', 'readwrite')
  await Promise.all([...rows.map(r => tx.store.put(r)), tx.done])
}

export async function replaceLocalFolderCards(folderIds, rows) {
  const ids = [...new Set((folderIds || []).filter(Boolean))]
  const db = await getDb()
  const tx = db.transaction('folder_cards', 'readwrite')
  for (const folderId of ids) {
    const existing = await tx.store.index('folder_id').getAll(folderId)
    for (const row of existing) await tx.store.delete(row.id)
  }
  for (const row of rows || []) await tx.store.put(row)
  await tx.done
}

// ── Deck Cards (builder) ──────────────────────────────────────────────────────

export async function getDeckCards(deckId) {
  const db = await getDb()
  return db.getAllFromIndex('deck_cards', 'deck_id', deckId)
}

export async function putDeckCards(rows) {
  if (!rows?.length) return
  const db = await getDb()
  const tx = db.transaction('deck_cards', 'readwrite')
  await Promise.all([...rows.map(r => tx.store.put(r)), tx.done])
}

export async function deleteDeckCardLocal(id) {
  const db = await getDb()
  await db.delete('deck_cards', id)
}

export async function deleteAllDeckCardsLocal(deckId) {
  const db = await getDb()
  const all = await db.getAllFromIndex('deck_cards', 'deck_id', deckId)
  const tx = db.transaction('deck_cards', 'readwrite')
  await Promise.all([...all.map(r => tx.store.delete(r.id)), tx.done])
}

export async function getDeckAllocations(deckId) {
  const db = await getDb()
  return db.getAllFromIndex('deck_allocations', 'deck_id', deckId)
}

export async function getAllDeckAllocationsForUser(userId) {
  const db = await getDb()
  return db.getAllFromIndex('deck_allocations', 'user_id', userId)
}

export async function putDeckAllocations(rows) {
  if (!rows?.length) return
  const db = await getDb()
  const tx = db.transaction('deck_allocations', 'readwrite')
  await Promise.all([...rows.map(r => tx.store.put(r)), tx.done])
}

export async function replaceDeckAllocations(deckIds, rows) {
  const ids = [...new Set((deckIds || []).filter(Boolean))]
  const db = await getDb()
  const tx = db.transaction('deck_allocations', 'readwrite')
  for (const deckId of ids) {
    const existing = await tx.store.index('deck_id').getAll(deckId)
    for (const row of existing) await tx.store.delete(row.id)
  }
  for (const row of rows || []) await tx.store.put(row)
  await tx.done
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

export async function getDbStats() {
  const db = await getDb()
  const [cards, folders, folderCards, scryfall, deckCards, cardPrints, deckAllocations] = await Promise.all([
    db.count('cards'),
    db.count('folders'),
    db.count('folder_cards'),
    db.count('scryfall'),
    db.count('deck_cards'),
    db.count('card_prints'),
    db.count('deck_allocations'),
  ])
  const sfInfo = await getScryfallCacheInfo()
  return { cards, folders, folderCards, scryfall, deckCards, cardPrints, deckAllocations, sfUpdatedAt: sfInfo.updatedAt }
}

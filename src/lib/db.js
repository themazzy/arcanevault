/**
 * ArcaneVault local IndexedDB layer
 *
 * Stores:
 *   scryfall  — Scryfall card data (prices, types, images, etc.)
 *               keyed by "set_code-collector_number"
 *   cards     — Mirror of Supabase cards table, for offline use
 *   folders   — Mirror of Supabase folders + folder_cards
 *   meta      — Key/value store for sync timestamps, cache versions, etc.
 *
 * All operations are async. The DB opens lazily on first use.
 */

import { openDB } from 'idb'

const DB_NAME    = 'arcanevault'
const DB_VERSION = 1

let _db = null

async function getDb() {
  if (_db) return _db
  _db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
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

      // folder_cards store — links between folders and cards
      if (!db.objectStoreNames.contains('folder_cards')) {
        const fc = db.createObjectStore('folder_cards', { keyPath: 'id' })
        fc.createIndex('folder_id', 'folder_id')
        fc.createIndex('card_id',   'card_id')
      }

      // folders store — binders, decks, wishlists
      if (!db.objectStoreNames.contains('folders')) {
        const f = db.createObjectStore('folders', { keyPath: 'id' })
        f.createIndex('user_id', 'user_id')
        f.createIndex('type',    'type')
      }

      // meta store — sync timestamps, settings, cache info
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' })
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
// Each entry: { key, set_code, collector_number, prices, type_line, ... }
// Prices have a `prices_updated_at` timestamp for TTL checking.
// Images (image_uris) never expire.

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
  await setMeta('scryfall_prices_updated_at', null)
}

export async function getScryfallCacheInfo() {
  const db = await getDb()
  const count = await db.count('scryfall')
  const updatedAt = await getMeta('scryfall_prices_updated_at')
  return { count, updatedAt }
}

// ── Cards ─────────────────────────────────────────────────────────────────────

export async function getLocalCards(userId) {
  const db = await getDb()
  return db.getAllFromIndex('cards', 'user_id', userId)
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
  // Also clean up folder_cards
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

// ── Diagnostics ───────────────────────────────────────────────────────────────

export async function getDbStats() {
  const db = await getDb()
  const [cards, folders, folderCards, scryfall] = await Promise.all([
    db.count('cards'),
    db.count('folders'),
    db.count('folder_cards'),
    db.count('scryfall'),
  ])
  const sfInfo = await getScryfallCacheInfo()
  return { cards, folders, folderCards, scryfall, sfUpdatedAt: sfInfo.updatedAt }
}

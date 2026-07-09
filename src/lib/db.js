/**
 * DeckLoom local IndexedDB layer
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
const DB_VERSION = 9
const SCRYFALL_METADATA_UPDATED_AT_KEY = 'scryfall_metadata_updated_at'
const LEGACY_SCRYFALL_PRICES_UPDATED_AT_KEY = 'scryfall_prices_updated_at'

let _db = null
let _dbPromise = null

// The browser can close an IDB connection behind our back — typically after
// the tab sits backgrounded on Android and the OS reclaims resources. The
// cached handle then throws "The database connection is closing" on every
// transaction until the page is reloaded. A dead handle is only detectable by
// trying it, so probe with an empty transaction (auto-commits, microseconds)
// before handing the cache out, and reopen when it fails.
function isDbLive(db) {
  try {
    db.transaction('meta', 'readonly')
    return true
  } catch {
    return false
  }
}

function getDb() {
  if (_db) {
    if (isDbLive(_db)) return Promise.resolve(_db)
    _db = null
  }
  if (!_dbPromise) {
    _dbPromise = openConnection()
      .then(db => { _db = db; _dbPromise = null; return db })
      .catch(err => { _dbPromise = null; throw err })
  }
  return _dbPromise
}

// Test-only: closes the underlying connection while leaving it cached, the
// same state a browser-initiated close leaves behind.
export async function _simulateExternalConnectionClose() {
  const db = await getDb()
  db.close()
}

async function openConnection() {
  return openDB(DB_NAME, DB_VERSION, {
    // The browser terminated the connection abnormally; drop the cache so the
    // next call reopens instead of failing forever.
    terminated() { _db = null },
    // Another tab (running newer code after a deploy) requested a version
    // upgrade; keeping this connection open would block it indefinitely.
    blocking() {
      try { _db?.close() } catch { /* already closing */ }
      _db = null
    },
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

      if (!db.objectStoreNames.contains('card_prices')) {
        const prices = db.createObjectStore('card_prices', { keyPath: 'id' })
        prices.createIndex('scryfall_id', 'scryfall_id')
        prices.createIndex('set_code', 'set_code')
        prices.createIndex('snapshot_date', 'snapshot_date')
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

      // v9: the scanner's per-row hash cache (106k object records) is replaced
      // by scanner_pack — a handful of binary chunk blobs. Deleting the old
      // store here frees the ~50–100 MB it occupied on existing devices.
      if (db.objectStoreNames.contains('scanner_hashes')) {
        db.deleteObjectStore('scanner_hashes')
      }
      if (!db.objectStoreNames.contains('scanner_pack')) {
        db.createObjectStore('scanner_pack', { keyPath: 'file' })
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

      // list_items store (v8) — wishlist items mirrored from Supabase for instant offline reads
      if (!db.objectStoreNames.contains('list_items')) {
        const li = db.createObjectStore('list_items', { keyPath: 'id' })
        li.createIndex('folder_id', 'folder_id')
        li.createIndex('user_id', 'user_id')
      }
    }
  })
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

// ── Scanner hash-pack chunks ─────────────────────────────────────────────────
// Each record is one binary pack chunk: { file, buf: ArrayBuffer, bytes, hashVersion }

export async function getPackChunk(file) {
  const db = await getDb()
  const row = await db.get('scanner_pack', file)
  return row?.buf instanceof ArrayBuffer ? row : null
}

export async function putPackChunk(record) {
  const db = await getDb()
  await db.put('scanner_pack', record)
}

export async function getPackChunkKeys() {
  const db = await getDb()
  return db.getAllKeys('scanner_pack')
}

export async function deletePackChunks(files) {
  if (!files?.length) return
  const db = await getDb()
  const tx = db.transaction('scanner_pack', 'readwrite')
  await Promise.all([
    ...files.map(file => tx.store.delete(file)),
    tx.done,
  ])
}

export async function clearPackChunks() {
  const db = await getDb()
  await db.clear('scanner_pack')
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

export async function getLocalCardPriceRowsByIds(scryfallIds, snapshotDates) {
  const ids = new Set((scryfallIds || []).filter(Boolean).map(id => String(id).trim()))
  const dates = [...new Set((snapshotDates || []).filter(Boolean))]
  if (!ids.size || !dates.length) return []

  const db = await getDb()
  // One getAllFromIndex per snapshot date (typically 2 calls) instead of one
  // db.get per id+date pair — a 12k-card collection was issuing ~24k
  // individual gets here, which dominated every Stats/Collection load.
  const rowsByDate = await Promise.all(
    dates.map(date => db.getAllFromIndex('card_prices', 'snapshot_date', date)),
  )
  return rowsByDate.flat().filter(row => ids.has(row.scryfall_id))
}

export async function getLocalCardPriceRowsBySetCodes(setCodes, snapshotDates) {
  const sets = new Set((setCodes || []).map(s => String(s || '').trim().toLowerCase()).filter(Boolean))
  const dates = new Set((snapshotDates || []).filter(Boolean))
  if (!sets.size || !dates.size) return []

  const db = await getDb()
  const rowsBySet = await Promise.all([...sets].map(setCode => db.getAllFromIndex('card_prices', 'set_code', setCode)))
  return rowsBySet.flat().filter(row => dates.has(row.snapshot_date))
}

export async function putCardPriceRows(rows) {
  if (!rows?.length) return
  const cachedAt = Date.now()
  const db = await getDb()
  const tx = db.transaction('card_prices', 'readwrite')
  // Queue all puts without awaiting each one — awaiting per-put serializes
  // the transaction and made bulk price caching take seconds.
  const puts = []
  for (const row of rows) {
    const scryfallId = row?.scryfall_id ? String(row.scryfall_id).trim() : null
    const snapshotDate = row?.snapshot_date
    if (!scryfallId || !snapshotDate) continue
    puts.push(tx.store.put({
      ...row,
      id: `${scryfallId}|${snapshotDate}`,
      scryfall_id: scryfallId,
      set_code: row.set_code ? String(row.set_code).trim().toLowerCase() : row.set_code,
      cached_at: row.cached_at || cachedAt,
    }))
  }
  await Promise.all([...puts, tx.done])
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

export async function deleteLocalFoldersAndPlacements(folderIds) {
  const ids = [...new Set((folderIds || []).filter(Boolean))]
  if (!ids.length) return

  const db = await getDb()
  const [folderCards, deckAllocations] = await Promise.all([
    Promise.all(ids.map(id => db.getAllFromIndex('folder_cards', 'folder_id', id))),
    Promise.all(ids.map(id => db.getAllFromIndex('deck_allocations', 'deck_id', id))),
  ])

  const tx = db.transaction(['folders', 'folder_cards', 'deck_allocations'], 'readwrite')
  const foldersStore = tx.objectStore('folders')
  const folderCardsStore = tx.objectStore('folder_cards')
  const deckAllocationsStore = tx.objectStore('deck_allocations')

  for (const id of ids) foldersStore.delete(id)
  for (const row of folderCards.flat()) folderCardsStore.delete(row.id)
  for (const row of deckAllocations.flat()) deckAllocationsStore.delete(row.id)

  await tx.done
}

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

export async function deleteFolderCardsByIds(ids) {
  const uniqueIds = [...new Set((ids || []).filter(Boolean))]
  if (!uniqueIds.length) return
  const db = await getDb()
  const tx = db.transaction('folder_cards', 'readwrite')
  await Promise.all([
    ...uniqueIds.map(id => tx.store.delete(id)),
    tx.done,
  ])
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

// Bulk read deck_allocations for many deck ids in a single transaction.
// Single readonly transaction, one cursor scan filtered by deck_id Set — far cheaper
// than opening N independent transactions when listing many decks at once.
export async function getAllDeckAllocationsForFolders(deckIds) {
  if (!deckIds?.length) return []
  const ids = new Set(deckIds.filter(Boolean))
  if (!ids.size) return []
  const db = await getDb()
  const tx = db.transaction('deck_allocations', 'readonly')
  const results = await Promise.all(
    [...ids].map(id => tx.store.index('deck_id').getAll(id))
  )
  await tx.done
  return results.flat()
}

export async function putDeckAllocations(rows) {
  if (!rows?.length) return
  const db = await getDb()
  const tx = db.transaction('deck_allocations', 'readwrite')
  await Promise.all([...rows.map(r => tx.store.put(r)), tx.done])
}

export async function deleteDeckAllocationsByIds(ids) {
  const uniqueIds = [...new Set((ids || []).filter(Boolean))]
  if (!uniqueIds.length) return
  const db = await getDb()
  const tx = db.transaction('deck_allocations', 'readwrite')
  await Promise.all([
    ...uniqueIds.map(id => tx.store.delete(id)),
    tx.done,
  ])
}

export async function deleteDeckAllocationsByCardIds(cardIds) {
  const uniqueIds = [...new Set((cardIds || []).filter(Boolean))]
  if (!uniqueIds.length) return
  const db = await getDb()
  const tx = db.transaction('deck_allocations', 'readwrite')
  for (const cardId of uniqueIds) {
    const rows = await tx.store.index('card_id').getAll(cardId)
    for (const row of rows) await tx.store.delete(row.id)
  }
  await tx.done
}

export async function deleteFolderCardsByCardIds(cardIds) {
  const uniqueIds = [...new Set((cardIds || []).filter(Boolean))]
  if (!uniqueIds.length) return
  const db = await getDb()
  const tx = db.transaction('folder_cards', 'readwrite')
  for (const cardId of uniqueIds) {
    const rows = await tx.store.index('card_id').getAll(cardId)
    for (const row of rows) await tx.store.delete(row.id)
  }
  await tx.done
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

// ── List items (wishlists) ────────────────────────────────────────────────────

export async function getLocalListItems(folderId) {
  if (!folderId) return []
  const db = await getDb()
  return db.getAllFromIndex('list_items', 'folder_id', folderId)
}

export async function getAllLocalListItems(userId) {
  if (!userId) return []
  const db = await getDb()
  return db.getAllFromIndex('list_items', 'user_id', userId)
}

export async function getAllLocalListItemsForFolders(folderIds) {
  if (!folderIds?.length) return []
  const ids = new Set(folderIds.filter(Boolean))
  if (!ids.size) return []
  const db = await getDb()
  const tx = db.transaction('list_items', 'readonly')
  const results = await Promise.all(
    [...ids].map(id => tx.store.index('folder_id').getAll(id))
  )
  await tx.done
  return results.flat()
}

export async function putListItems(rows) {
  if (!rows?.length) return
  const db = await getDb()
  const tx = db.transaction('list_items', 'readwrite')
  await Promise.all([...rows.map(r => tx.store.put(r)), tx.done])
}

export async function deleteListItemsByIds(ids) {
  const uniqueIds = [...new Set((ids || []).filter(Boolean))]
  if (!uniqueIds.length) return
  const db = await getDb()
  const tx = db.transaction('list_items', 'readwrite')
  await Promise.all([
    ...uniqueIds.map(id => tx.store.delete(id)),
    tx.done,
  ])
}

export async function replaceLocalListItems(folderIds, rows) {
  const ids = [...new Set((folderIds || []).filter(Boolean))]
  const db = await getDb()
  const tx = db.transaction('list_items', 'readwrite')
  for (const folderId of ids) {
    const existing = await tx.store.index('folder_id').getAll(folderId)
    for (const row of existing) await tx.store.delete(row.id)
  }
  for (const row of rows || []) await tx.store.put(row)
  await tx.done
}

// ── Folder meta cache (counts + values per folder, persisted) ────────────────
// Lets the index page paint last-known counts/values immediately on revisit
// instead of showing "—" while prices reload. Keyed by (userId, type) with the
// priceSource captured so stale values can be invalidated when the user swaps
// currency settings.

function folderMetaKey(userId, type) {
  return `folder_meta_${userId}_${type}`
}

export async function getFolderMetaCache(userId, type) {
  if (!userId || !type) return null
  return await getMeta(folderMetaKey(userId, type))
}

export async function setFolderMetaCache(userId, type, meta, priceSource) {
  if (!userId || !type || !meta) return
  await setMeta(folderMetaKey(userId, type), { meta, priceSource, savedAt: Date.now() })
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

export async function getDbStats() {
  const db = await getDb()
  const [cards, folders, folderCards, scryfall, deckCards, cardPrints, deckAllocations, cardPrices, listItems] = await Promise.all([
    db.count('cards'),
    db.count('folders'),
    db.count('folder_cards'),
    db.count('scryfall'),
    db.count('deck_cards'),
    db.count('card_prints'),
    db.count('deck_allocations'),
    db.count('card_prices'),
    db.count('list_items'),
  ])
  const sfInfo = await getScryfallCacheInfo()
  return { cards, folders, folderCards, scryfall, deckCards, cardPrints, deckAllocations, cardPrices, listItems, sfUpdatedAt: sfInfo.updatedAt }
}

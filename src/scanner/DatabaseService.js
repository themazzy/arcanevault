/**
 * DatabaseService — on-device card hash store
 *
 * Native (Android/iOS):  @capacitor-community/sqlite, fully offline
 * Web (dev/browser):     fetches hashes directly from Supabase (up to 10k cards)
 *
 * Speed improvements:
 *  - Pre-parsed IDB cache: stores hash_u32 (Array<number>) so warm starts skip
 *    all BigInt/hex parsing (~880K parseInt calls for a 10K-card DB).
 *  - Incremental band index: _addToIndex() is O(1) per card; the old
 *    _rebuildIndex() (O(N)) was called after every page batch = O(N²/B) total.
 *  - Chunked native SQLite load: first 5000 rows available immediately;
 *    rest streams in background so scanning starts before full load.
 */

import { Capacitor } from '@capacitor/core'
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite'
import { sb } from '../lib/supabase'
import {
  clearScannerHashEntries,
  getAllScannerHashEntries,
  getScannerHashCount,
  getMeta,
  putScannerHashEntries,
  setMeta,
} from '../lib/db'
import { hexToHash, hammingDistance } from './hashCore'

export { hammingDistance }

const DB_NAME          = 'arcanevault_hashes'
const PAGE_SIZE        = 1000
const NATIVE_CHUNK     = 5000
const BAND_MASK        = 0x3F  // 6-bit bands
const WEB_PAGE_RETRY_ATTEMPTS = 3
const WEB_PAGE_RETRY_BASE_MS  = 250
const NATIVE_SQLITE_STARTUP_TIMEOUT_MS = 3000
// Bump to invalidate IDB cache when stored hash schema changes (e.g. new columns).
// v3: added .order('scryfall_id') to paginated fetches for consistent pagination.
// v4: CLAHE 4×4 tile grid + BT.601 grayscale — all hashes reseeded.
// v5: BT.709 grayscale + scanner hash pipeline reseed marker.
const CACHE_VERSION    = 5
// [wordIndex, shift] — 16 bands of 6 bits across the 8 Uint32 words
const BAND_SPECS = [
  [0, 0], [0, 16], [1, 0], [1, 16],
  [2, 0], [2, 16], [3, 0], [3, 16],
  [4, 0], [4, 16], [5, 0], [5, 16],
  [6, 0], [6, 16], [7, 0], [7, 16],
]

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Augment raw Supabase/SQLite rows with a pre-parsed hash_u32 field so that
 * subsequent rowToHash() calls can skip hexToHash() entirely.
 */
function augmentWithParsed(rows) {
  return rows.map(r => {
    if (r.hash_u32) return r   // already augmented
    const hash = hexToHash(r.phash_hex)
    if (!hash) return r
    const colorHash = r.phash_hex2 ? hexToHash(r.phash_hex2) : null
    return {
      ...r,
      hash_u32: Array.from(hash),
      ...(colorHash ? { hash_u32_color: Array.from(colorHash) } : {}),
    }
  })
}

/**
 * Convert a raw DB row into the in-memory hash object.
 * Uses pre-parsed hash_u32 / hash_u32_color when available (warm IDB cache).
 */
function rowToHash(r) {
  let hash
  if (r.hash_u32) {
    hash = new Uint32Array(r.hash_u32)
  } else {
    hash = hexToHash(r.phash_hex)
  }
  if (!hash) return null
  let hashColor = null
  if (r.hash_u32_color) {
    hashColor = new Uint32Array(r.hash_u32_color)
  } else if (r.phash_hex2) {
    hashColor = hexToHash(r.phash_hex2)
  }
  return {
    id:        r.scryfall_id,
    name:      r.name,
    setCode:   r.set_code,
    collNum:   r.collector_number,
    imageUri:  r.image_uri,
    hash,
    hashColor,
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Service ───────────────────────────────────────────────────────────────────

class DatabaseService {
  _hashes      = []
  _bandIndex   = BAND_SPECS.map(() => new Map())
  _sqlite      = null
  _db          = null
  _isNative    = false
  _initialized = false
  _syncing     = false
  _fullyLoaded = false
  _loadPromise = Promise.resolve()
  _mirrorWritePromise = Promise.resolve()
  _initPromise = null
  _onProgress  = null
  _matchWorker = null
  _workerSeq = 1
  _workerPending = new Map()
  _workerFailed = false
  _status = {
    loadedCount: 0,
    totalCount: 0,
    progress: 0,
    phase: 'idle',
    source: 'none',
  }

  _emitProgress(patch = {}) {
    this._status = { ...this._status, ...patch }
    const total = this._status.totalCount || this._status.loadedCount || 0
    this._status.progress = total > 0
      ? Math.max(0, Math.min(100, Math.round((this._status.loadedCount / total) * 100)))
      : 0
    this._onProgress?.({ ...this._status })
  }

  async init(onProgress) {
    this._onProgress = onProgress   // always wire latest caller into ongoing stream
    if (this._initialized) {
      // Re-init if in-memory data is significantly incomplete — happens when the
      // background _continueWebLoad exited early due to network errors skipping pages.
      const total = this._status.totalCount
      const incomplete = total > 0 && this._hashes.length < Math.floor(total * 0.98)
      if (!incomplete) {
        this._emitProgress({
          loadedCount: this._hashes.length,
          totalCount: total || this._hashes.length,
          phase: this._fullyLoaded ? 'ready' : this._status.phase,
        })
        return this
      }
      // Fall through to re-init. Partial IDB rows are kept (see _loadWebCache).
      this._initialized = false
      this._fullyLoaded = false
    }
    if (this._initPromise) {
      await this._initPromise
      this._emitProgress({
        loadedCount: this._hashes.length,
        totalCount: this._status.totalCount || this._hashes.length,
        phase: this._fullyLoaded ? 'ready' : this._status.phase,
      })
      return this
    }

    this._initPromise = (async () => {
      this._isNative = Capacitor.isNativePlatform()
      if (this._isNative) {
        this._emitProgress({
          loadedCount: 0,
          totalCount: 0,
          phase: 'preparing native storage',
          source: 'native',
        })
        const loadedNativeMirror = await this._loadCompleteNativeMirror()
        if (loadedNativeMirror) {
          this._initialized = true
          return this
        }
        await this._initSQLiteForStartup()
      }
      await this._loadCache()
      this._initialized = true
      return this
    })()

    try {
      return await this._initPromise
    } finally {
      this._initPromise = null
    }
  }

  async _initSQLite() {
    if (this._db) return
    this._emitProgress({
      loadedCount: 0,
      totalCount: 0,
      phase: 'opening local database',
      source: 'native',
    })
    this._sqlite = new SQLiteConnection(CapacitorSQLite)
    const isConn = (await this._sqlite.isConnection(DB_NAME, false)).result
    const db = isConn
      ? await this._sqlite.retrieveConnection(DB_NAME, false)
      : await this._sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false)
    await db.open()
    await db.execute(`
      CREATE TABLE IF NOT EXISTS card_hashes (
        scryfall_id      TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        set_code         TEXT,
        collector_number TEXT,
        phash_hex        TEXT,
        phash_hex2       TEXT,
        image_uri        TEXT,
        art_crop_uri     TEXT,
        synced_at        INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_phash ON card_hashes (phash_hex)
        WHERE phash_hex IS NOT NULL;
    `)
    // Migration: add phash_hex2 to existing SQLite DBs that predate this column.
    await db.execute(`ALTER TABLE card_hashes ADD COLUMN phash_hex2 TEXT`).catch(() => {})
    this._db = db
  }

  // ── Sync from Supabase ─────────────────────────────────────────────────────

  async _initSQLiteForStartup() {
    if (this._db) return true
    const openPromise = this._initSQLite()
      .then(() => true)
      .catch(error => {
        console.warn('[DatabaseService] native SQLite startup failed:', error?.message ?? error)
        this._db = null
        return false
      })

    const opened = await Promise.race([
      openPromise,
      sleep(NATIVE_SQLITE_STARTUP_TIMEOUT_MS).then(() => false),
    ])

    if (!opened) {
      this._emitProgress({
        loadedCount: 0,
        totalCount: 0,
        phase: 'connecting',
        source: 'idb',
      })
    }
    return opened
  }

  async sync(onProgress) {
    if (this._syncing) return
    this._syncing = true
    await this._loadPromise   // wait for any background streaming to finish before clearing
    await this._mirrorWritePromise.catch(() => {})
    try {
      let page  = 0
      let total = 0

      while (true) {
        const from = page * PAGE_SIZE
        const to   = from + PAGE_SIZE - 1
        const { data, error } = await sb
          .from('card_hashes')
          .select('scryfall_id,name,set_code,collector_number,phash_hex,phash_hex2,image_uri,art_crop_uri')
          .not('phash_hex', 'is', null)
          .range(from, to)

        if (error) throw error
        if (!data?.length) break

        if (this._isNative && this._db) await this._upsertBatch(data)

        total += data.length
        onProgress?.(total)
        page++
        if (data.length < PAGE_SIZE) break
      }

      // Clear IDB cache so the rebuilt data (with hash_u32) is stored fresh
      await clearScannerHashEntries().catch(() => {})
      await setMeta('scanner_sqlite_count', 0).catch(() => {})

      await this._loadCache()
    } finally {
      this._syncing = false
    }
  }

  async _upsertBatch(rows) {
    const placeholders = rows.map(() => '(?,?,?,?,?,?,?,?,?)').join(',')
    const values = []
    for (const r of rows) {
      values.push(
        r.scryfall_id, r.name,
        r.set_code         ?? null,
        r.collector_number ?? null,
        r.phash_hex        ?? null,
        r.phash_hex2       ?? null,
        r.image_uri        ?? null,
        r.art_crop_uri     ?? null,
        Date.now(),
      )
    }
    await this._db.run(
      `INSERT OR REPLACE INTO card_hashes
         (scryfall_id,name,set_code,collector_number,phash_hex,phash_hex2,image_uri,art_crop_uri,synced_at)
       VALUES ${placeholders}`,
      values,
    )
  }

  _serializeHashForWorker(card) {
    return {
      id: card.id,
      name: card.name,
      setCode: card.setCode,
      collNum: card.collNum,
      imageUri: card.imageUri,
      hash: Array.from(card.hash),
      hashColor: card.hashColor ? Array.from(card.hashColor) : null,
    }
  }

  _ensureMatchWorker() {
    if (this._workerFailed || typeof Worker === 'undefined') return null
    if (this._matchWorker) return this._matchWorker
    try {
      this._matchWorker = new Worker(new URL('./hashMatchWorker.js', import.meta.url), { type: 'module' })
      this._matchWorker.onmessage = event => {
        const { id, ok, result, error } = event.data || {}
        const pending = this._workerPending.get(id)
        if (!pending) return
        this._workerPending.delete(id)
        if (ok) pending.resolve(result)
        else pending.reject(new Error(error || 'Hash match worker failed'))
      }
      this._matchWorker.onerror = error => {
        this._workerFailed = true
        for (const pending of this._workerPending.values()) {
          pending.reject(new Error(error?.message || 'Hash match worker failed'))
        }
        this._workerPending.clear()
        this._matchWorker?.terminate()
        this._matchWorker = null
      }
      return this._matchWorker
    } catch {
      this._workerFailed = true
      return null
    }
  }

  _postMatchWorker(type, payload) {
    const worker = this._ensureMatchWorker()
    if (!worker) return Promise.reject(new Error('Hash match worker unavailable'))
    const id = this._workerSeq++
    return new Promise((resolve, reject) => {
      this._workerPending.set(id, { resolve, reject })
      worker.postMessage({ id, type, payload })
    })
  }

  _resetMatchWorkerData() {
    this._postMatchWorker('reset', {
      hashes: this._hashes.map(card => this._serializeHashForWorker(card)),
    }).catch(() => {})
  }

  _appendMatchWorkerData(cards) {
    if (!cards?.length) return
    this._postMatchWorker('append', {
      hashes: cards.map(card => this._serializeHashForWorker(card)),
    }).catch(() => {})
  }

  _queueScannerHashMirror(entries) {
    if (!entries?.length) return
    this._mirrorWritePromise = this._mirrorWritePromise
      .catch(() => {})
      .then(() => putScannerHashEntries(entries))
      .catch(() => {})
  }

  // ── Load into memory ───────────────────────────────────────────────────────

  async _loadCache() {
    this._hashes = []
    this._bandIndex = BAND_SPECS.map(() => new Map())
    this._resetMatchWorkerData()
    this._fullyLoaded = false
    this._mirrorWritePromise = Promise.resolve()
    if (this._isNative && this._db) {
      await this._loadNativeCache()
    } else {
      await this._loadWebCache()
    }
  }

  // ── Native path: IDB pre-parsed cache → chunked SQLite fallback ────────────

  async _loadCompleteNativeMirror() {
    this._hashes = []
    this._bandIndex = BAND_SPECS.map(() => new Map())
    this._resetMatchWorkerData()
    this._fullyLoaded = false
    this._mirrorWritePromise = Promise.resolve()

    this._emitProgress({
      loadedCount: 0,
      totalCount: 0,
      phase: 'checking cache',
      source: 'native',
    })

    const sqliteCount = Number(await getMeta('scanner_sqlite_count').catch(() => 0)) || 0
    if (sqliteCount <= 0) return false

    const cachedCount = Number(await getScannerHashCount().catch(() => 0)) || 0
    if (cachedCount < sqliteCount) return false

    const cachedRows = await getAllScannerHashEntries().catch(() => [])
    if (cachedRows.length < sqliteCount) return false

    this._emitProgress({
      loadedCount: cachedRows.length,
      totalCount: sqliteCount,
      phase: 'building index',
      source: 'idb cache',
    })
    await new Promise(r => setTimeout(r, 0))

    this._hashes = cachedRows.map(rowToHash).filter(Boolean)
    this._rebuildIndex()
    this._resetMatchWorkerData()
    this._fullyLoaded = true
    this._loadPromise = Promise.resolve(this._hashes.length)
    this._emitProgress({
      loadedCount: this._hashes.length,
      totalCount: sqliteCount,
      phase: 'ready',
      source: 'idb cache',
    })
    return this._hashes.length > 0
  }

  async _loadNativeCache() {
    this._emitProgress({
      loadedCount: 0,
      totalCount: 0,
      phase: 'checking cache',
      source: 'native',
    })

    const sqliteCount = Number(await getMeta('scanner_sqlite_count').catch(() => 0)) || 0
    const cachedCount = sqliteCount > 0
      ? Number(await getScannerHashCount().catch(() => 0)) || 0
      : 0

    // Only load the full IDB cache when counts suggest it is complete.
    // This avoids pulling every cached hash row into the WebView just to
    // discover that native storage is empty or incomplete.
    if (sqliteCount > 0 && cachedCount >= sqliteCount) {
      const cachedRows = await getAllScannerHashEntries().catch(() => [])
      this._hashes = cachedRows.map(rowToHash).filter(Boolean)
      this._rebuildIndex()
      this._resetMatchWorkerData()
      this._fullyLoaded = true
      this._emitProgress({
        loadedCount: this._hashes.length,
        totalCount: this._hashes.length,
        phase: 'ready',
        source: 'idb cache',
      })
      this._loadPromise = Promise.resolve(this._hashes.length)
      return
    }

    // Get total from SQLite
    this._emitProgress({
      loadedCount: 0,
      totalCount: sqliteCount,
      phase: 'reading local database',
      source: 'sqlite',
    })
    const countRes = await this._db.query(
      'SELECT COUNT(*) as cnt FROM card_hashes WHERE phash_hex IS NOT NULL'
    ).catch(() => ({ values: [] }))
    const total = countRes.values?.[0]?.cnt ?? 0

    this._emitProgress({
      loadedCount: 0,
      totalCount: total,
      phase: 'loading hashes',
      source: 'sqlite',
    })

    if (total === 0) {
      this._fullyLoaded = true
      this._loadPromise = Promise.resolve(0)
      return
    }

    // Load first chunk synchronously so scanning can start immediately
    const firstChunk = await this._fetchSQLiteChunk(0)
    const augmented = augmentWithParsed(firstChunk)
    this._hashes = augmented.map(rowToHash).filter(Boolean)
    this._rebuildIndex()
    this._resetMatchWorkerData()
    this._queueScannerHashMirror(augmented)

    this._emitProgress({
      loadedCount: this._hashes.length,
      totalCount: total,
      phase: firstChunk.length === NATIVE_CHUNK ? 'loading hashes' : 'ready',
      source: 'sqlite',
    })

    if (firstChunk.length < NATIVE_CHUNK) {
      this._fullyLoaded = true
      await setMeta('scanner_sqlite_count', total).catch(() => {})
      this._loadPromise = Promise.resolve(this._hashes.length)
      return
    }

    // Stream remainder in background
    this._loadPromise = this._continueNativeLoad(NATIVE_CHUNK, total)
      .finally(async () => {
        this._fullyLoaded = true
        await setMeta('scanner_sqlite_count', total).catch(() => {})
        this._emitProgress({
          loadedCount: this._hashes.length,
          totalCount: total,
          phase: 'ready',
          source: 'sqlite',
        })
      })
  }

  async _fetchSQLiteChunk(offset) {
    const res = await this._db.query(
      'SELECT scryfall_id,name,set_code,collector_number,phash_hex,phash_hex2,image_uri FROM card_hashes WHERE phash_hex IS NOT NULL LIMIT ? OFFSET ?',
      [NATIVE_CHUNK, offset]
    ).catch(() => ({ values: [] }))
    return res.values ?? []
  }

  async _continueNativeLoad(startOffset, total) {
    let offset = startOffset
    while (true) {
      const chunk = await this._fetchSQLiteChunk(offset)
      if (!chunk.length) break
      const augmented = augmentWithParsed(chunk)
      const startIdx = this._hashes.length
      const parsed = augmented.map(rowToHash).filter(Boolean)
      this._hashes.push(...parsed)
      for (let i = startIdx; i < this._hashes.length; i++) {
        this._addToIndex(this._hashes[i], i)
      }
      this._appendMatchWorkerData(parsed)
      this._queueScannerHashMirror(augmented)
      this._emitProgress({
        loadedCount: this._hashes.length,
        totalCount: total,
        phase: chunk.length < NATIVE_CHUNK ? 'finalizing' : 'loading hashes',
        source: 'sqlite',
      })
      if (chunk.length < NATIVE_CHUNK) break
      offset += NATIVE_CHUNK
    }
    return this._hashes.length
  }

  // ── Web path: IDB cache → Supabase network fallback ───────────────────────

  async _loadWebCache() {
    this._emitProgress({ phase: 'connecting', source: 'idb', loadedCount: 0 })

    // Invalidate IDB cache when the stored hash schema changes (CACHE_VERSION bump).
    const storedVersion = Number(await getMeta('scanner_cache_version').catch(() => 0)) || 0
    if (storedVersion !== CACHE_VERSION) {
      await clearScannerHashEntries().catch(() => {})
      await setMeta('scanner_cache_version', CACHE_VERSION).catch(() => {})
      await setMeta('scanner_hash_total_count', 0).catch(() => {})
    }

    // Stage 1: IDB cache + counts only — fast, no page data yet.
    // _fetchTotalCount() is a Supabase network call and slower than the IDB
    // reads. We emit the count as a side-effect the moment it resolves so the
    // UI shows "checking cache 0/N" instead of a blank shimmer during the wait.
    const [cachedRows, cachedTotal, remoteTotal] = await Promise.all([
      getAllScannerHashEntries().catch(() => []),
      getMeta('scanner_hash_total_count').then(v => Number(v) || 0).catch(() => 0),
      this._fetchTotalCount()
        .then(count => {
          if (count > 0) this._emitProgress({ totalCount: count })
          return count
        })
        .catch(() => 0),
    ])

    const expectedTotal = remoteTotal || cachedTotal
    // If the remote count exceeds what we have locally, treat cache as stale
    // so newly-added sets are picked up on every startup.
    const hasCompleteCache = expectedTotal > 0 && cachedRows.length >= expectedTotal

    if (hasCompleteCache) {
      // Yield to main thread so React can paint "building index" before the
      // synchronous map+rebuildIndex blocks the thread.
      this._emitProgress({
        loadedCount: cachedRows.length,
        totalCount: expectedTotal,
        phase: 'building index',
        source: 'idb cache',
      })
      await new Promise(r => setTimeout(r, 0))
      this._hashes = cachedRows.map(rowToHash).filter(Boolean)
      this._rebuildIndex()
      this._resetMatchWorkerData()
      this._fullyLoaded = true
      this._emitProgress({
        loadedCount: this._hashes.length,
        totalCount: expectedTotal,
        phase: 'ready',
        source: 'idb cache',
      })
      this._loadPromise = Promise.resolve(this._hashes.length)
      return
    }

    // Cache is missing, stale, or incomplete (e.g. interrupted download).
    // Only clear IDB when we have MORE rows than remote — that means cards were
    // deleted from the remote DB and IDB has stale rows.
    // For partial downloads (fewer rows than expected), keep what we have: the
    // re-download will upsert on top of existing rows, filling in the gaps without
    // re-fetching pages that were already cached successfully.
    if (cachedRows.length > 0 && remoteTotal > 0 && cachedRows.length > remoteTotal) {
      await clearScannerHashEntries().catch(() => {})
    }

    const totalCount = expectedTotal
    // Emit 0/N so the user sees the full count before page 0 arrives.
    this._emitProgress({
      loadedCount: 0,
      totalCount,
      phase: 'downloading hashes',
      source: 'network',
    })
    // Yield so React paints the "0/N" state before we block on the network.
    await new Promise(r => setTimeout(r, 0))

    // Stage 2: fetch page 0 — user sees the bar advance from 0 → ~10%.
    const firstNetworkPage = await this._fetchWebPageWithRetry(0).catch(error => {
      console.warn('[DatabaseService] initial page fetch failed after retries:', error?.message ?? error)
      return []
    })

    const augmentedFirst = augmentWithParsed(firstNetworkPage)
    this._hashes = augmentedFirst.map(rowToHash).filter(Boolean)
    this._rebuildIndex()
    this._resetMatchWorkerData()
    await Promise.all([
      augmentedFirst.length ? putScannerHashEntries(augmentedFirst).catch(() => {}) : Promise.resolve(),
      totalCount ? setMeta('scanner_hash_total_count', totalCount).catch(() => {}) : Promise.resolve(),
    ])
    this._emitProgress({
      loadedCount: this._hashes.length,
      totalCount: totalCount || this._hashes.length,
      phase: firstNetworkPage.length === PAGE_SIZE
        ? 'downloading hashes'
        : (totalCount > 0 && firstNetworkPage.length === 0 ? 'network retry needed' : 'ready'),
      source: 'network',
    })

    if (firstNetworkPage.length === PAGE_SIZE) {
      this._loadPromise = this._continueWebLoad(1, totalCount)
        .then(loadedCount => {
          const complete = !totalCount || loadedCount >= totalCount
          this._fullyLoaded = complete
          this._emitProgress({
            loadedCount: this._hashes.length,
            totalCount: totalCount || this._hashes.length,
            phase: complete ? 'ready' : this._status.phase,
            source: 'network',
          })
        })
    } else {
      this._fullyLoaded = !(totalCount > 0 && firstNetworkPage.length === 0)
      this._loadPromise = Promise.resolve(this._hashes.length)
    }
  }

  async _fetchWebPage(page) {
    const from = page * PAGE_SIZE
    const to   = from + PAGE_SIZE - 1
    const { data, error } = await sb
      .from('card_hashes')
      .select('scryfall_id,name,set_code,collector_number,phash_hex,phash_hex2,image_uri')
      .not('phash_hex', 'is', null)
      .order('scryfall_id')
      .range(from, to)
    if (error) throw error
    return data ?? []
  }

  async _fetchWebPageWithRetry(page, attempts = WEB_PAGE_RETRY_ATTEMPTS) {
    let lastError = null
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this._fetchWebPage(page)
      } catch (error) {
        lastError = error
        if (attempt >= attempts) break
        await sleep(WEB_PAGE_RETRY_BASE_MS * attempt)
      }
    }
    throw lastError ?? new Error(`Failed to fetch hash page ${page}`)
  }

  async _fetchTotalCount() {
    const { count, error } = await sb
      .from('card_hashes')
      .select('scryfall_id', { count: 'exact', head: true })
      .not('phash_hex', 'is', null)
    if (error) throw error
    return count ?? 0
  }

  async _continueWebLoad(startPage, totalCount = 0) {
    const BATCH = 8   // fetch 8 pages in parallel
    let page = startPage
    let haltedByError = false

    while (true) {
      const results = await Promise.all(
        Array.from({ length: BATCH }, (_, i) =>
          this._fetchWebPageWithRetry(page + i)
            .then(data => ({ page: page + i, data, error: null }))
            .catch(error => ({ page: page + i, data: null, error }))
        )
      )

      let reachedEnd = false
      for (const result of results) {
        if (result.error) {
          haltedByError = true
          reachedEnd = true
          console.warn(
            `[DatabaseService] page fetch failed after retries; stopping at page ${result.page}:`,
            result.error?.message ?? result.error
          )
          break
        }
        const { data } = result
        if (!data.length) { reachedEnd = true; break }
        const augmented = augmentWithParsed(data)
        const startIdx = this._hashes.length
        const parsed = augmented.map(rowToHash).filter(Boolean)
        this._hashes.push(...parsed)
        for (let i = startIdx; i < this._hashes.length; i++) {
          this._addToIndex(this._hashes[i], i)
        }
        this._appendMatchWorkerData(parsed)
        await putScannerHashEntries(augmented).catch(() => {})
        // Emit after every page so the progress bar advances smoothly
        this._emitProgress({
          loadedCount: this._hashes.length,
          totalCount: totalCount || this._hashes.length,
          phase: 'downloading hashes',
          source: 'network',
        })
        if (data.length < PAGE_SIZE) { reachedEnd = true; break }
      }

      if (reachedEnd) break
      page += BATCH
    }

    await setMeta('scanner_hash_total_count', totalCount || this._hashes.length).catch(() => {})
    if (haltedByError) {
      this._emitProgress({
        loadedCount: this._hashes.length,
        totalCount: totalCount || this._hashes.length,
        phase: 'network retry needed',
        source: 'network',
      })
      return this._hashes.length
    }
    return this._hashes.length
  }

  // ── Match ──────────────────────────────────────────────────────────────────

  findMatch(hash, threshold = 20) {
    const best = this.findBest(hash)
    if (!best) return null
    return best.distance <= threshold ? best : null
  }

  findBest(hash) {
    const [best] = this.findBestTwo(hash)
    return best
  }

  findBestTwo(hash) {
    const { best, second } = this.findBestTwoWithStats(hash)
    return [best, second]
  }

  // colorHash: optional Uint32Array(8) from computePHash256Color.
  // When provided, combined distance = 0.65 * luma + 0.35 * color, giving
  // color-identity cards (lands, reprints) a tiebreaker over look-alike art.
  findBestTwoWithStats(hash, colorHash = null, opts = {}) {
    if (!this._hashes.length) {
      return { best: null, second: null, candidateCount: 0, totalCount: 0 }
    }
    const {
      allowedSets = null,
      allowSetFallback = false,
      broadFallbackOnWeak = false,
      weakDistance = 122,
      weakGap = 8,
    } = opts
    const allowed = allowedSets?.size
      ? card => card.setCode && allowedSets.has(String(card.setCode).toLowerCase())
      : null
    const rank = (cards) => {
      let best = null, second = null
      let bestDist = Infinity, secondDist = Infinity
      for (const card of cards) {
        const lumaDist = hammingDistance(hash, card.hash)
        const d = (colorHash && card.hashColor)
          ? Math.round(0.65 * lumaDist + 0.35 * hammingDistance(colorHash, card.hashColor))
          : lumaDist
        if (d < bestDist) {
          second = best; secondDist = bestDist
          best = card;   bestDist   = d
        } else if (d < secondDist) {
          second = card; secondDist = d
        }
      }
      return {
        best: best ? { ...best, distance: bestDist } : null,
        second: second ? { ...second, distance: secondDist } : null,
        candidateCount: cards.length,
      }
    }
    const isWeak = ({ best, second }) => {
      if (!best) return true
      const gap = second ? second.distance - best.distance : 256
      return best.distance > weakDistance || gap < weakGap
    }
    const baseCandidates = this._getCandidates(hash)
    const rankWithFallback = (pool, candidates, source) => {
      let result = rank(candidates)
      let fallback = source
      if (broadFallbackOnWeak && isWeak(result) && candidates.length < pool.length) {
        result = rank(pool)
        fallback = `${source}+broad`
      }
      return { ...result, fallback }
    }

    let pool = allowed ? this._hashes.filter(allowed) : this._hashes
    let candidates = allowed ? baseCandidates.filter(allowed) : baseCandidates
    let ranked = rankWithFallback(pool, candidates.length ? candidates : pool, allowed ? 'locked-set' : 'indexed')

    if (allowed && allowSetFallback && isWeak(ranked)) {
      ranked = rankWithFallback(this._hashes, baseCandidates, 'all-sets-fallback')
    }

    return {
      best: ranked.best,
      second: ranked.second,
      candidateCount: ranked.candidateCount,
      totalCount: this._hashes.length,
      fallback: ranked.fallback,
    }
  }

  async findBestTwoWithStatsAsync(hash, colorHash = null, opts = {}) {
    if (!this._hashes.length) {
      return { best: null, second: null, candidateCount: 0, totalCount: 0 }
    }
    const workerOpts = {
      ...opts,
      allowedSets: opts.allowedSets?.size ? [...opts.allowedSets] : null,
    }
    try {
      return await this._postMatchWorker('match', {
        hash: Array.from(hash),
        colorHash: colorHash ? Array.from(colorHash) : null,
        opts: workerOpts,
      })
    } catch {
      return this.findBestTwoWithStats(hash, colorHash, opts)
    }
  }
  // ── Index ──────────────────────────────────────────────────────────────────

  /** Full rebuild — O(N). Use only when rebuilding from scratch. */
  _rebuildIndex() {
    this._bandIndex = BAND_SPECS.map(() => new Map())
    this._hashes.forEach((card, idx) => this._addToIndex(card, idx))
  }

  /** Incremental insert — O(1). Use when appending a single card. */
  _addToIndex(card, idx) {
    BAND_SPECS.forEach(([wordIdx, shift], bandIdx) => {
      const key = (card.hash[wordIdx] >>> shift) & BAND_MASK
      const bucket = this._bandIndex[bandIdx].get(key)
      if (bucket) bucket.push(idx)
      else this._bandIndex[bandIdx].set(key, [idx])
    })
  }

  _getCandidates(hash) {
    if (!this._bandIndex.length || this._hashes.length <= 2000) return this._hashes

    const hitCounts = new Map()
    BAND_SPECS.forEach(([wordIdx, shift], bandIdx) => {
      const key = (hash[wordIdx] >>> shift) & BAND_MASK
      const bucket = this._bandIndex[bandIdx].get(key)
      if (!bucket) return
      for (const idx of bucket) {
        hitCounts.set(idx, (hitCounts.get(idx) ?? 0) + 1)
      }
    })

    let candidates = [...hitCounts.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 1500)
      .map(([idx]) => this._hashes[idx])

    if (candidates.length >= 32) return candidates

    candidates = [...hitCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2500)
      .map(([idx]) => this._hashes[idx])

    return candidates.length ? candidates : this._hashes
  }

  get cardCount()       { return this._hashes.length }
  get isReady()         { return this._initialized }
  get isSyncing()       { return this._syncing }
  get isFullyLoaded()   { return this._fullyLoaded }
  get status()          { return this._status }
  waitUntilFullyLoaded() { return this._loadPromise }
}

export const databaseService = new DatabaseService()

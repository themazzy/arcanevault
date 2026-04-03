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
    return { ...r, hash_u32: Array.from(hash) }
  })
}

/**
 * Convert a raw DB row into the in-memory hash object.
 * Uses pre-parsed hash_u32 when available (warm IDB cache) to avoid
 * re-parsing hex strings on every load.
 */
function rowToHash(r) {
  let hash
  if (r.hash_u32) {
    hash = new Uint32Array(r.hash_u32)
  } else {
    hash = hexToHash(r.phash_hex)
  }
  if (!hash) return null
  return {
    id:       r.scryfall_id,
    name:     r.name,
    setCode:  r.set_code,
    collNum:  r.collector_number,
    imageUri: r.image_uri,
    hash,
  }
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
  _initPromise = null
  _status = {
    loadedCount: 0,
    totalCount: 0,
    progress: 0,
    phase: 'idle',
    source: 'none',
  }

  _emitProgress(onProgress, patch = {}) {
    this._status = { ...this._status, ...patch }
    const total = this._status.totalCount || this._status.loadedCount || 0
    this._status.progress = total > 0
      ? Math.max(0, Math.min(100, Math.round((this._status.loadedCount / total) * 100)))
      : 0
    onProgress?.({ ...this._status })
  }

  async init(onProgress) {
    if (this._initialized) {
      this._emitProgress(onProgress, {
        loadedCount: this._hashes.length,
        totalCount: this._status.totalCount || this._hashes.length,
        phase: this._fullyLoaded ? 'ready' : this._status.phase,
      })
      return this
    }
    if (this._initPromise) {
      await this._initPromise
      this._emitProgress(onProgress, {
        loadedCount: this._hashes.length,
        totalCount: this._status.totalCount || this._hashes.length,
        phase: this._fullyLoaded ? 'ready' : this._status.phase,
      })
      return this
    }

    this._initPromise = (async () => {
      this._isNative = Capacitor.isNativePlatform()
      if (this._isNative) await this._initSQLite()
      await this._loadCache(onProgress)
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
    this._sqlite = new SQLiteConnection(CapacitorSQLite)
    const isConn = (await this._sqlite.isConnection(DB_NAME, false)).result
    this._db = isConn
      ? await this._sqlite.retrieveConnection(DB_NAME, false)
      : await this._sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false)
    await this._db.open()
    await this._db.execute(`
      CREATE TABLE IF NOT EXISTS card_hashes (
        scryfall_id      TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        set_code         TEXT,
        collector_number TEXT,
        phash_hex        TEXT,
        image_uri        TEXT,
        art_crop_uri     TEXT,
        synced_at        INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_phash ON card_hashes (phash_hex)
        WHERE phash_hex IS NOT NULL;
    `)
  }

  // ── Sync from Supabase ─────────────────────────────────────────────────────

  async sync(onProgress) {
    if (this._syncing) return
    this._syncing = true
    try {
      let page  = 0
      let total = 0

      while (true) {
        const from = page * PAGE_SIZE
        const to   = from + PAGE_SIZE - 1
        const { data, error } = await sb
          .from('card_hashes')
          .select('scryfall_id,name,set_code,collector_number,phash_hex,image_uri,art_crop_uri')
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
    const placeholders = rows.map(() => '(?,?,?,?,?,?,?,?)').join(',')
    const values = []
    for (const r of rows) {
      values.push(
        r.scryfall_id, r.name,
        r.set_code         ?? null,
        r.collector_number ?? null,
        r.phash_hex        ?? null,
        r.image_uri        ?? null,
        r.art_crop_uri     ?? null,
        Date.now(),
      )
    }
    await this._db.run(
      `INSERT OR REPLACE INTO card_hashes
         (scryfall_id,name,set_code,collector_number,phash_hex,image_uri,art_crop_uri,synced_at)
       VALUES ${placeholders}`,
      values,
    )
  }

  // ── Load into memory ───────────────────────────────────────────────────────

  async _loadCache(onProgress) {
    this._hashes = []
    this._bandIndex = BAND_SPECS.map(() => new Map())
    this._fullyLoaded = false
    if (this._isNative && this._db) {
      await this._loadNativeCache(onProgress)
    } else {
      await this._loadWebCache(onProgress)
    }
  }

  // ── Native path: IDB pre-parsed cache → chunked SQLite fallback ────────────

  async _loadNativeCache(onProgress) {
    // Check IDB for pre-parsed cache (populated on previous runs)
    const cachedRows = await getAllScannerHashEntries().catch(() => [])
    const sqliteCount = Number(await getMeta('scanner_sqlite_count').catch(() => 0)) || 0

    if (cachedRows.length > 0 && sqliteCount > 0 && cachedRows.length >= sqliteCount) {
      this._hashes = cachedRows.map(rowToHash).filter(Boolean)
      this._rebuildIndex()
      this._fullyLoaded = true
      this._emitProgress(onProgress, {
        loadedCount: this._hashes.length,
        totalCount: this._hashes.length,
        phase: 'ready',
        source: 'idb cache',
      })
      this._loadPromise = Promise.resolve(this._hashes.length)
      return
    }

    // Get total from SQLite
    const countRes = await this._db.query(
      'SELECT COUNT(*) as cnt FROM card_hashes WHERE phash_hex IS NOT NULL'
    ).catch(() => ({ values: [] }))
    const total = countRes.values?.[0]?.cnt ?? 0

    this._emitProgress(onProgress, {
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
    await putScannerHashEntries(augmented).catch(() => {})

    this._emitProgress(onProgress, {
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
    this._loadPromise = this._continueNativeLoad(NATIVE_CHUNK, onProgress, total)
      .finally(async () => {
        this._fullyLoaded = true
        await setMeta('scanner_sqlite_count', total).catch(() => {})
        this._emitProgress(onProgress, {
          loadedCount: this._hashes.length,
          totalCount: total,
          phase: 'ready',
          source: 'sqlite',
        })
      })
  }

  async _fetchSQLiteChunk(offset) {
    const res = await this._db.query(
      'SELECT scryfall_id,name,set_code,collector_number,phash_hex,image_uri FROM card_hashes WHERE phash_hex IS NOT NULL LIMIT ? OFFSET ?',
      [NATIVE_CHUNK, offset]
    ).catch(() => ({ values: [] }))
    return res.values ?? []
  }

  async _continueNativeLoad(startOffset, onProgress, total) {
    let offset = startOffset
    while (true) {
      const chunk = await this._fetchSQLiteChunk(offset)
      if (!chunk.length) break
      const augmented = augmentWithParsed(chunk)
      const startIdx = this._hashes.length
      this._hashes.push(...augmented.map(rowToHash).filter(Boolean))
      for (let i = startIdx; i < this._hashes.length; i++) {
        this._addToIndex(this._hashes[i], i)
      }
      await putScannerHashEntries(augmented).catch(() => {})
      this._emitProgress(onProgress, {
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

  async _loadWebCache(onProgress) {
    this._emitProgress(onProgress, { phase: 'checking cache', source: 'idb', loadedCount: 0 })
    const cachedRows = await getAllScannerHashEntries().catch(() => [])
    const cachedTotal = Number(await getMeta('scanner_hash_total_count').catch(() => 0)) || 0
    const remoteTotal = Number(await this._fetchTotalCount().catch(() => 0)) || 0
    const expectedTotal = remoteTotal || cachedTotal
    const hasCompleteCache = expectedTotal > 0 && cachedRows.length >= expectedTotal
    const shouldRefreshCache = cachedRows.length > 0 && expectedTotal > 0 && cachedRows.length !== expectedTotal

    if (cachedRows?.length && hasCompleteCache && !shouldRefreshCache) {
      this._hashes = cachedRows.map(rowToHash).filter(Boolean)
      this._rebuildIndex()
      this._fullyLoaded = true
      this._emitProgress(onProgress, {
        loadedCount: this._hashes.length,
        totalCount: expectedTotal,
        phase: 'ready',
        source: 'idb cache',
      })
      this._loadPromise = Promise.resolve(this._hashes.length)
      return
    }

    if (cachedRows?.length && shouldRefreshCache) {
      this._emitProgress(onProgress, {
        loadedCount: cachedRows.length,
        totalCount: expectedTotal,
        phase: 'refreshing cache',
        source: 'network',
      })
      await clearScannerHashEntries().catch(() => {})
    }

    const totalCount = expectedTotal
    this._emitProgress(onProgress, {
      loadedCount: 0,
      totalCount,
      phase: 'downloading hashes',
      source: 'network',
    })

    const firstPage = await this._fetchWebPage(0)
    const augmentedFirst = augmentWithParsed(firstPage)
    this._hashes = augmentedFirst.map(rowToHash).filter(Boolean)
    this._rebuildIndex()
    if (augmentedFirst.length) await putScannerHashEntries(augmentedFirst).catch(() => {})
    if (totalCount) await setMeta('scanner_hash_total_count', totalCount).catch(() => {})
    this._emitProgress(onProgress, {
      loadedCount: this._hashes.length,
      totalCount: totalCount || this._hashes.length,
      phase: firstPage.length === PAGE_SIZE ? 'downloading hashes' : 'ready',
      source: 'network',
    })

    if (firstPage.length === PAGE_SIZE) {
      this._loadPromise = this._continueWebLoad(1, onProgress, totalCount)
        .finally(() => {
          this._fullyLoaded = true
          this._emitProgress(onProgress, {
            loadedCount: this._hashes.length,
            totalCount: totalCount || this._hashes.length,
            phase: 'ready',
            source: 'network',
          })
        })
    } else {
      this._fullyLoaded = true
      this._loadPromise = Promise.resolve(this._hashes.length)
    }
  }

  async _fetchWebPage(page) {
    const from = page * PAGE_SIZE
    const to   = from + PAGE_SIZE - 1
    const { data, error } = await sb
      .from('card_hashes')
      .select('scryfall_id,name,set_code,collector_number,phash_hex,image_uri')
      .not('phash_hex', 'is', null)
      .range(from, to)
    if (error) throw error
    return data ?? []
  }

  async _fetchTotalCount() {
    const { count, error } = await sb
      .from('card_hashes')
      .select('scryfall_id', { count: 'exact', head: true })
      .not('phash_hex', 'is', null)
    if (error) throw error
    return count ?? 0
  }

  async _continueWebLoad(startPage, onProgress, totalCount = 0) {
    const BATCH = 8   // fetch 8 pages in parallel
    let page = startPage

    while (true) {
      const results = await Promise.all(
        Array.from({ length: BATCH }, (_, i) =>
          this._fetchWebPage(page + i).catch(() => [])
        )
      )

      let reachedEnd = false
      for (const data of results) {
        if (!data.length) { reachedEnd = true; break }
        const augmented = augmentWithParsed(data)
        const startIdx = this._hashes.length
        this._hashes.push(...augmented.map(rowToHash).filter(Boolean))
        for (let i = startIdx; i < this._hashes.length; i++) {
          this._addToIndex(this._hashes[i], i)
        }
        await putScannerHashEntries(augmented).catch(() => {})
        if (data.length < PAGE_SIZE) { reachedEnd = true; break }
      }

      this._emitProgress(onProgress, {
        loadedCount: this._hashes.length,
        totalCount: totalCount || this._hashes.length,
        phase: reachedEnd ? 'finalizing cache' : 'downloading hashes',
        source: 'network',
      })
      if (reachedEnd) break
      page += BATCH
    }

    await setMeta('scanner_hash_total_count', totalCount || this._hashes.length).catch(() => {})
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

  findBestTwoWithStats(hash) {
    if (!this._hashes.length) {
      return { best: null, second: null, candidateCount: 0, totalCount: 0 }
    }
    const candidates = this._getCandidates(hash)
    let best = null, second = null
    let bestDist = Infinity, secondDist = Infinity
    for (const card of candidates) {
      const d = hammingDistance(hash, card.hash)
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
      candidateCount: candidates.length,
      totalCount: this._hashes.length,
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

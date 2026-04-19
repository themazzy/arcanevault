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
import { HASH_WORDS, hexToHash, hammingDistance } from './hashCore'

export { hammingDistance }

const DB_NAME          = 'arcanevault_hashes'
const PAGE_SIZE        = 1000
const NATIVE_CHUNK     = 5000
const BAND_MASK        = 0x3F  // 6-bit bands
// Minimum popcount for the query colorHash before the color channel is
// allowed to influence combined distance. Desaturated art (basic lands,
// grey-scale planeswalkers) produces near-empty colorHashes; blending them
// in just adds noise. Scale with hash size - 50 of 384 ~= 13%.
const COLOR_MIN_BITS   = 50
// Bump to invalidate IDB cache when stored hash schema changes (e.g. new columns).
// v3: added .order('scryfall_id') to paginated fetches for consistent pagination.
// v4: CLAHE 4×4 tile grid + BT.601 grayscale — all hashes reseeded.
// v5: 384-bit zigzag hashes + full-card hash column, requires reseed.
// v6: force IDB flush after reseed — stale pre-reseed v5 hashes caused zero matches.
const CACHE_VERSION    = 6
const BAND_SPECS = Array.from({ length: HASH_WORDS }, (_, wordIdx) => ([
  [wordIdx, 0],
  [wordIdx, 16],
])).flat()
const HASH_SELECT_COLUMNS = 'scryfall_id,name,set_code,collector_number,phash_hex,phash_hex2,phash_hex_full,image_uri,art_crop_uri'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Hamming weight (set-bit count) of a Uint32Array. */
function popcountHash(hash) {
  let count = 0
  for (let i = 0; i < hash.length; i++) {
    let v = hash[i] >>> 0
    v = v - ((v >>> 1) & 0x55555555)
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
    v = (v + (v >>> 4)) & 0x0f0f0f0f
    count += (v * 0x01010101) >>> 24
  }
  return count
}

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
    const fullHash = r.phash_hex_full ? hexToHash(r.phash_hex_full) : null
    return {
      ...r,
      hash_u32: Array.from(hash),
      ...(colorHash ? { hash_u32_color: Array.from(colorHash) } : {}),
      ...(fullHash ? { hash_u32_full: Array.from(fullHash) } : {}),
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
  let hashFull = null
  if (r.hash_u32_full) {
    hashFull = new Uint32Array(r.hash_u32_full)
  } else if (r.phash_hex_full) {
    hashFull = hexToHash(r.phash_hex_full)
  }
  return {
    id:        r.scryfall_id,
    name:      r.name,
    setCode:   r.set_code,
    collNum:   r.collector_number,
    imageUri:  r.image_uri,
    hash,
    hashColor,
    hashFull,
  }
}

// ── Service ───────────────────────────────────────────────────────────────────

class DatabaseService {
  _hashes      = []
  _bandIndex   = BAND_SPECS.map(() => new Map())
  _bandIndexFull = BAND_SPECS.map(() => new Map())
  _sqlite      = null
  _db          = null
  _isNative    = false
  _initialized = false
  _syncing     = false
  _fullyLoaded = false
  _loadPromise = Promise.resolve()
  _initPromise = null
  _onProgress  = null
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
      // Wait for any in-flight background download to finish before resetting
      // _hashes — otherwise the old task and new task both write concurrently,
      // causing hashes to accumulate unboundedly across re-opens.
      await this._loadPromise.catch(() => {})
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
      if (this._isNative) await this._initSQLite()
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
        phash_hex2       TEXT,
        phash_hex_full   TEXT,
        image_uri        TEXT,
        art_crop_uri     TEXT,
        synced_at        INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_phash ON card_hashes (phash_hex)
        WHERE phash_hex IS NOT NULL;
    `)
    // Migration: add phash_hex2 to existing SQLite DBs that predate this column.
    await this._db.execute(`ALTER TABLE card_hashes ADD COLUMN phash_hex2 TEXT`).catch(() => {})
    await this._db.execute(`ALTER TABLE card_hashes ADD COLUMN phash_hex_full TEXT`).catch(() => {})
  }

  // ── Sync from Supabase ─────────────────────────────────────────────────────

  async sync(onProgress) {
    if (this._syncing) return
    this._syncing = true
    await this._loadPromise   // wait for any background streaming to finish before clearing
    try {
      let page  = 0
      let total = 0

      while (true) {
        const from = page * PAGE_SIZE
        const to   = from + PAGE_SIZE - 1
        const { data, error } = await sb
          .from('card_hashes')
          .select(HASH_SELECT_COLUMNS)
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
      await setMeta('scanner_last_sync_ts', Date.now()).catch(() => {})
    } finally {
      this._syncing = false
    }
  }

  async getLastSyncTs() {
    const v = await getMeta('scanner_last_sync_ts').catch(() => null)
    return typeof v === 'number' ? v : null
  }

  async _upsertBatch(rows) {
    const placeholders = rows.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',')
    const values = []
    for (const r of rows) {
      values.push(
        r.scryfall_id, r.name,
        r.set_code         ?? null,
        r.collector_number ?? null,
        r.phash_hex        ?? null,
        r.phash_hex2       ?? null,
        r.phash_hex_full   ?? null,
        r.image_uri        ?? null,
        r.art_crop_uri     ?? null,
        Date.now(),
      )
    }
    await this._db.run(
      `INSERT OR REPLACE INTO card_hashes
         (scryfall_id,name,set_code,collector_number,phash_hex,phash_hex2,phash_hex_full,image_uri,art_crop_uri,synced_at)
       VALUES ${placeholders}`,
      values,
    )
  }

  // ── Load into memory ───────────────────────────────────────────────────────

  async _loadCache() {
    this._hashes = []
    this._bandIndex = BAND_SPECS.map(() => new Map())
    this._bandIndexFull = BAND_SPECS.map(() => new Map())
    this._fullyLoaded = false
    if (this._isNative && this._db) {
      await this._loadNativeCache()
    } else {
      await this._loadWebCache()
    }
  }

  // ── Native path: IDB pre-parsed cache → chunked SQLite fallback ────────────

  async _loadNativeCache() {
    const storedVersion = Number(await getMeta('scanner_cache_version').catch(() => 0)) || 0
    if (storedVersion !== CACHE_VERSION) {
      await clearScannerHashEntries().catch(() => {})
      await this._db.execute('DELETE FROM card_hashes').catch(() => {})
      await Promise.all([
        setMeta('scanner_cache_version', CACHE_VERSION).catch(() => {}),
        setMeta('scanner_sqlite_count', 0).catch(() => {}),
        setMeta('scanner_hash_total_count', 0).catch(() => {}),
      ])
    }

    // Check IDB for pre-parsed cache (populated on previous runs)
    const cachedRows = await getAllScannerHashEntries().catch(() => [])
    const sqliteCount = Number(await getMeta('scanner_sqlite_count').catch(() => 0)) || 0

    if (cachedRows.length > 0 && sqliteCount > 0 && cachedRows.length >= sqliteCount) {
      this._hashes = cachedRows.map(rowToHash).filter(Boolean)
      this._rebuildIndex()
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
    await putScannerHashEntries(augmented).catch(() => {})

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
      'SELECT scryfall_id,name,set_code,collector_number,phash_hex,phash_hex2,phash_hex_full,image_uri,art_crop_uri FROM card_hashes WHERE phash_hex IS NOT NULL LIMIT ? OFFSET ?',
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
      this._hashes.push(...augmented.map(rowToHash).filter(Boolean))
      for (let i = startIdx; i < this._hashes.length; i++) {
        this._addToIndex(this._hashes[i], i)
      }
      await putScannerHashEntries(augmented).catch(() => {})
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
    const firstNetworkPage = await this._fetchWebPage(0).catch(() => [])

    const augmentedFirst = augmentWithParsed(firstNetworkPage)
    this._hashes = augmentedFirst.map(rowToHash).filter(Boolean)
    this._rebuildIndex()
    await Promise.all([
      augmentedFirst.length ? putScannerHashEntries(augmentedFirst).catch(() => {}) : Promise.resolve(),
      totalCount ? setMeta('scanner_hash_total_count', totalCount).catch(() => {}) : Promise.resolve(),
    ])
    this._emitProgress({
      loadedCount: this._hashes.length,
      totalCount: totalCount || this._hashes.length,
      phase: firstNetworkPage.length === PAGE_SIZE ? 'downloading hashes' : 'ready',
      source: 'network',
    })

    if (firstNetworkPage.length === PAGE_SIZE) {
      this._loadPromise = this._continueWebLoad(1, totalCount)
        .finally(() => {
          this._fullyLoaded = true
          this._emitProgress({
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
      .select(HASH_SELECT_COLUMNS)
      .not('phash_hex', 'is', null)
      .order('scryfall_id')
      .range(from, to)
    if (error) throw error
    return data ?? []
  }

  /**
   * Lightweight remote vs local count check. Returns immediately — does NOT
   * trigger a sync. Callers decide whether to follow up with sync().
   */
  async checkForUpdates() {
    if (!this._initialized || this._syncing) {
      return { hasUpdates: false, delta: 0, localTotal: this._hashes.length, remoteTotal: this._hashes.length }
    }
    try {
      const remoteTotal = await this._fetchTotalCount()
      const localTotal  = this._hashes.length
      return {
        hasUpdates: remoteTotal > localTotal,
        delta: Math.max(0, remoteTotal - localTotal),
        localTotal,
        remoteTotal,
      }
    } catch {
      return { hasUpdates: false, delta: 0, localTotal: this._hashes.length, remoteTotal: this._hashes.length }
    }
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
    const MAX_CONSECUTIVE_ERRORS = 3
    let page = startPage
    let consecutiveErrors = 0

    while (true) {
      const results = await Promise.all(
        Array.from({ length: BATCH }, (_, i) =>
          this._fetchWebPage(page + i).catch(err => {
            console.warn('[DatabaseService] page fetch error, skipping:', err?.message ?? err)
            return null   // null = transient error; [] = genuine end-of-data
          })
        )
      )

      let reachedEnd = false
      for (const data of results) {
        if (data === null) {
          consecutiveErrors++
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) { reachedEnd = true; break }
          continue        // transient error — skip page, don't stop
        }
        consecutiveErrors = 0
        if (!data.length) { reachedEnd = true; break }
        const augmented = augmentWithParsed(data)
        const startIdx = this._hashes.length
        this._hashes.push(...augmented.map(rowToHash).filter(Boolean))
        for (let i = startIdx; i < this._hashes.length; i++) {
          this._addToIndex(this._hashes[i], i)
        }
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

  // colorHash: optional saturation hash from computeAllHashes().
  // When provided and the query has enough saturation signal (≥COLOR_MIN_BITS),
  // combined distance = 0.65 * luma + 0.35 * color, giving color-identity cards
  // (lands, reprints) a tiebreaker over look-alike art.
  findBestTwoWithStats(hash, colorHash = null, fullHash = null) {
    if (!this._hashes.length) {
      return { best: null, second: null, candidateCount: 0, totalCount: 0 }
    }
    const candidates = this._getCandidates(hash, fullHash)
    const useColor = colorHash && popcountHash(colorHash) >= COLOR_MIN_BITS
    let best = null, second = null
    let bestDist = Infinity, secondDist = Infinity
    for (const card of candidates) {
      const d = this._scoreCard(card, hash, colorHash, fullHash, useColor)
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

  /**
   * Last-resort full linear scan. Bypasses the LSH band index which requires
   * ≥2 band hits and can silently drop heavily distorted scans even when the
   * true Hamming distance would be acceptable.
   *
   * Cost: ~80–150ms on a 30k-card DB. Only call after all art-crop / rotation
   * / reticle fallbacks have failed to produce a confident match.
   */
  findBestTwoFullScan(hash, colorHash = null, fullHash = null) {
    if (!this._hashes.length) {
      return { best: null, second: null, candidateCount: 0, totalCount: 0 }
    }
    const useColor = colorHash && popcountHash(colorHash) >= COLOR_MIN_BITS
    let best = null, second = null
    let bestDist = Infinity, secondDist = Infinity
    for (const card of this._hashes) {
      const d = this._scoreCard(card, hash, colorHash, fullHash, useColor)
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
      candidateCount: this._hashes.length,
      totalCount: this._hashes.length,
    }
  }

  // ── Index ──────────────────────────────────────────────────────────────────

  /** Full rebuild — O(N). Use only when rebuilding from scratch. */
  _rebuildIndex() {
    this._bandIndex = BAND_SPECS.map(() => new Map())
    this._bandIndexFull = BAND_SPECS.map(() => new Map())
    this._hashes.forEach((card, idx) => this._addToIndex(card, idx))
  }

  /** Incremental insert — O(1). Use when appending a single card. */
  _addToIndex(card, idx) {
    this._addHashToIndex(this._bandIndex, card.hash, idx)
    if (card.hashFull) this._addHashToIndex(this._bandIndexFull, card.hashFull, idx)
  }

  _addHashToIndex(index, hash, idx) {
    BAND_SPECS.forEach(([wordIdx, shift], bandIdx) => {
      const key = (hash[wordIdx] >>> shift) & BAND_MASK
      const bucket = index[bandIdx].get(key)
      if (bucket) bucket.push(idx)
      else index[bandIdx].set(key, [idx])
    })
  }

  _accumulateBandHits(hitCounts, index, hash) {
    if (!hash) return
    BAND_SPECS.forEach(([wordIdx, shift], bandIdx) => {
      const key = (hash[wordIdx] >>> shift) & BAND_MASK
      const bucket = index[bandIdx].get(key)
      if (!bucket) return
      for (const idx of bucket) {
        hitCounts.set(idx, (hitCounts.get(idx) ?? 0) + 1)
      }
    })
  }

  _scoreCard(card, hash, colorHash, fullHash, useColor) {
    const artDist = hammingDistance(hash, card.hash)
    const fullDist = fullHash && card.hashFull ? hammingDistance(fullHash, card.hashFull) : Infinity
    let distance = Math.min(artDist, fullDist)
    if (useColor && card.hashColor) {
      distance = Math.round(0.65 * distance + 0.35 * hammingDistance(colorHash, card.hashColor))
    }
    return distance
  }

  _getCandidates(hash, fullHash = null) {
    if (!this._bandIndex.length || this._hashes.length <= 2000) return this._hashes

    const hitCounts = new Map()
    this._accumulateBandHits(hitCounts, this._bandIndex, hash)
    if (fullHash) this._accumulateBandHits(hitCounts, this._bandIndexFull, fullHash)

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

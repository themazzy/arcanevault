/**
 * DatabaseService — on-device card hash store
 *
 * Native (Android/iOS):  @capacitor-community/sqlite, fully offline
 * Web (dev/browser):     fetches hashes directly from Supabase (up to 10k cards)
 *
 * Supabase `card_hashes` table must have a `phash_hex` TEXT column (64 hex chars).
 * We avoid reading the BIGINT hash_part_* columns in JS to sidestep the 53-bit
 * precision limit of JavaScript Numbers.
 */

import { Capacitor } from '@capacitor/core'
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite'
import { sb } from '../lib/supabase'

const DB_NAME   = 'arcanevault_hashes'
const PAGE_SIZE = 1000
const BAND_WIDTH = 6
const BAND_MASK = (1n << BigInt(BAND_WIDTH)) - 1n
const BAND_SPECS = [
  ['p1', 0], ['p1', 16], ['p1', 32], ['p1', 48],
  ['p2', 0], ['p2', 16], ['p2', 32], ['p2', 48],
  ['p3', 0], ['p3', 16], ['p3', 32], ['p3', 48],
  ['p4', 0], ['p4', 16], ['p4', 32], ['p4', 48],
]

// ── Hash math ─────────────────────────────────────────────────────────────────

export function hexToHashParts(hex) {
  if (!hex || hex.length !== 64) return null
  try {
    return {
      p1: BigInt('0x' + hex.slice(0,  16)),
      p2: BigInt('0x' + hex.slice(16, 32)),
      p3: BigInt('0x' + hex.slice(32, 48)),
      p4: BigInt('0x' + hex.slice(48, 64)),
    }
  } catch { return null }
}

function popcount64(n) {
  let count = 0
  let val = BigInt.asUintN(64, n)
  while (val > 0n) { val &= val - 1n; count++ }
  return count
}

export function hammingDistance(a, b) {
  return popcount64(a.p1 ^ b.p1) +
         popcount64(a.p2 ^ b.p2) +
         popcount64(a.p3 ^ b.p3) +
         popcount64(a.p4 ^ b.p4)
}

// ── Row → in-memory hash object ───────────────────────────────────────────────

function rowToHash(r) {
  const parts = hexToHashParts(r.phash_hex)
  if (!parts) return null
  return {
    id:       r.scryfall_id,
    name:     r.name,
    setCode:  r.set_code,
    collNum:  r.collector_number,
    imageUri: r.image_uri,
    ...parts,
  }
}

// ── Service ───────────────────────────────────────────────────────────────────

class DatabaseService {
  _hashes      = []    // { id, name, setCode, collNum, p1..p4 BigInt, imageUri }
  _bandIndex   = BAND_SPECS.map(() => new Map())
  _sqlite      = null
  _db          = null
  _isNative    = false
  _initialized = false
  _syncing     = false
  _fullyLoaded = false
  _loadPromise = Promise.resolve()

  async init(onProgress) {
    this._isNative = Capacitor.isNativePlatform()
    if (this._isNative) await this._initSQLite()
    await this._loadCache(onProgress)
    this._initialized = true
    return this
  }

  async _initSQLite() {
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
      const res = await this._db.query(
        'SELECT scryfall_id,name,set_code,collector_number,phash_hex,image_uri FROM card_hashes WHERE phash_hex IS NOT NULL'
      )
      this._hashes = (res.values ?? []).map(rowToHash).filter(Boolean)
      this._rebuildIndex()
      this._fullyLoaded = true
      this._loadPromise = Promise.resolve(this._hashes.length)
    } else {
      // Web fallback — PostgREST caps at 1000 rows per request regardless of .limit().
      // Load the first page synchronously so init() resolves quickly, then paginate
      // the remaining pages in the background so the scanner is usable immediately.
      const firstPage = await this._fetchWebPage(0)
      this._hashes = firstPage.map(rowToHash).filter(Boolean)
      this._rebuildIndex()
      onProgress?.(this._hashes.length)

      if (firstPage.length === PAGE_SIZE) {
        // More pages exist — continue loading without blocking init()
        this._loadPromise = this._continueWebLoad(1, onProgress)
          .finally(() => { this._fullyLoaded = true })
      } else {
        this._fullyLoaded = true
        this._loadPromise = Promise.resolve(this._hashes.length)
      }
    }
  }

  async _fetchWebPage(page) {
    const from = page * PAGE_SIZE
    const to   = from + PAGE_SIZE - 1
    const { data } = await sb
      .from('card_hashes')
      .select('scryfall_id,name,set_code,collector_number,phash_hex,image_uri')
      .not('phash_hex', 'is', null)
      .range(from, to)
    return data ?? []
  }

  async _continueWebLoad(startPage, onProgress) {
    const BATCH = 8   // fetch 8 pages in parallel — ~8× faster than sequential
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
        this._hashes.push(...data.map(rowToHash).filter(Boolean))
        if (data.length < PAGE_SIZE) { reachedEnd = true; break }
      }

      this._rebuildIndex()
      onProgress?.(this._hashes.length)
      if (reachedEnd) break
      page += BATCH
    }

    return this._hashes.length
  }

  // ── Match ──────────────────────────────────────────────────────────────────

  findMatch(hash, threshold = 20) {
    const best = this.findBest(hash)
    if (!best) return null
    return best.distance <= threshold ? best : null
  }

  // Like findMatch but always returns the closest card (no threshold cutoff).
  findBest(hash) {
    const [best] = this.findBestTwo(hash)
    return best
  }

  // Returns the two closest cards. Used for gap-check: a match is only
  // confirmed when best is significantly closer than second-best.
  findBestTwo(hash) {
    const { best, second } = this.findBestTwoWithStats(hash)
    return [best, second]
  }

  findBestTwoWithStats(hash) {
    if (!this._hashes.length) {
      return {
        best: null,
        second: null,
        candidateCount: 0,
        totalCount: 0,
      }
    }
    const candidates = this._getCandidates(hash)
    let best = null, second = null
    let bestDist = Infinity, secondDist = Infinity
    for (const card of candidates) {
      const d = hammingDistance(hash, card)
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

  _rebuildIndex() {
    this._bandIndex = BAND_SPECS.map(() => new Map())
    this._hashes.forEach((card, idx) => {
      BAND_SPECS.forEach(([part, shift], bandIdx) => {
        const key = this._bandKey(card[part], shift)
        const bucket = this._bandIndex[bandIdx].get(key)
        if (bucket) bucket.push(idx)
        else this._bandIndex[bandIdx].set(key, [idx])
      })
    })
  }

  _bandKey(value, shift) {
    return Number((BigInt.asUintN(64, value) >> BigInt(shift)) & BAND_MASK)
  }

  _getCandidates(hash) {
    if (!this._bandIndex.length || this._hashes.length <= 2000) return this._hashes

    const hitCounts = new Map()
    BAND_SPECS.forEach(([part, shift], bandIdx) => {
      const key = this._bandKey(hash[part], shift)
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

  get cardCount()   { return this._hashes.length }
  get isReady()     { return this._initialized }
  get isSyncing()   { return this._syncing }
  get isFullyLoaded() { return this._fullyLoaded }
  waitUntilFullyLoaded() { return this._loadPromise }
}

export const databaseService = new DatabaseService()

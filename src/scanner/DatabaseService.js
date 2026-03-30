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

// ── Service ───────────────────────────────────────────────────────────────────

class DatabaseService {
  _hashes      = []    // { id, name, setCode, collNum, p1..p4 BigInt, imageUri }
  _sqlite      = null
  _db          = null
  _isNative    = false
  _initialized = false
  _syncing     = false

  async init() {
    this._isNative = Capacitor.isNativePlatform()
    if (this._isNative) await this._initSQLite()
    await this._loadCache()
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

  async _loadCache() {
    let rows = []
    if (this._isNative && this._db) {
      const res = await this._db.query(
        'SELECT scryfall_id,name,set_code,collector_number,phash_hex,image_uri FROM card_hashes WHERE phash_hex IS NOT NULL'
      )
      rows = res.values ?? []
    } else {
      // Web fallback — query Supabase directly
      const { data } = await sb
        .from('card_hashes')
        .select('scryfall_id,name,set_code,collector_number,phash_hex,image_uri')
        .not('phash_hex', 'is', null)
        .limit(10000)
      rows = data ?? []
    }

    this._hashes = rows
      .map(r => {
        const parts = hexToHashParts(r.phash_hex)
        if (!parts) return null
        return {
          id:      r.scryfall_id,
          name:    r.name,
          setCode: r.set_code,
          collNum: r.collector_number,
          imageUri: r.image_uri,
          ...parts,
        }
      })
      .filter(Boolean)
  }

  // ── Match ──────────────────────────────────────────────────────────────────

  findMatch(hash, threshold = 20) {
    if (!this._hashes.length) return null
    let best     = null
    let bestDist = Infinity
    for (const card of this._hashes) {
      const d = hammingDistance(hash, card)
      if (d < bestDist) { bestDist = d; best = card }
    }
    return bestDist <= threshold ? { ...best, distance: bestDist } : null
  }

  get cardCount()   { return this._hashes.length }
  get isReady()     { return this._initialized }
  get isSyncing()   { return this._syncing }
}

export const databaseService = new DatabaseService()

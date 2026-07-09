/**
 * hashPack.js — binary hash-pack format for the card scanner
 *
 * Replaces the old per-row JSON delivery (106k rows over ~107 PostgREST pages)
 * with a small number of static binary chunks served from public/scanner/hashpack/.
 * Chunks live in the repo, so they deploy with the web app (same origin, edge
 * cached) AND ship inside the Android APK (Capacitor serves public/ locally),
 * which makes native first-run fully offline. Since format v2 the pack is also
 * the seed pipeline's source of truth — card_hashes in Supabase is retired.
 *
 * Pure JS — no DOM, no OpenCV. Shared by the browser scanner, the match
 * worker, and the Node seed script (scripts/generate-card-hashes.js).
 *
 * ── Chunk layout (little-endian) ─────────────────────────────────────────────
 *
 *  Header (32 bytes):
 *    0  u32  magic 'AVH1' (bytes 41 56 48 31)
 *    4  u16  formatVersion (1, 2, or 3 — v2 adds full-card hashes, face
 *            flags, and flavor names; v3 adds per-tile art hashes; the
 *            decoder reads all three)
 *    6  u16  hashVersion — scanner hash pipeline version; the client accepts
 *            any supported version and enables features per chunk
 *    8  u32  count — number of rows (a double-faced card contributes TWO
 *            rows in v2: face 0 = front, face 1 = back, same scryfall id)
 *   12  u32  metaBytesLen — byte length of the meta section
 *   16  u16  setCount — entries in the set table
 *   18  u16  tileGrid — tiles per side for the B3 section (v3; 0 = none)
 *   20  u32  setTableLen — byte length of the set table
 *   24  u64  (reserved)
 *
 *  Sections (u32-aligned where typed views need it):
 *   A   luma pHashes    count × 32 B  (8 × u32 per row) — art crop
 *   B   color pHashes   count × 32 B  — art-crop saturation channel
 *   B2  full pHashes    count × 32 B  — whole 500×700 card   [v2+]
 *   B3  tile pHashes    count × tileGrid² × 32 B — row-major art tiles [v3]
 *   C   scryfall UUIDs  count × 16 B  (raw bytes, no dashes)
 *   FC  face flags      count × 1 B (0 front / 1 back), pad ×4 [v2+]
 *   D   set indices     count × 2 B   (u16 into set table), padded to ×4
 *   E   meta offsets    (count+1) × 4 B (u32 byte offsets into meta)
 *   F   meta bytes      UTF-8 per row:
 *                         v1: name \x1F collector_number
 *                         v2+: name \x1F collector_number \x1F flavor_name
 *   G   set table       setCount × [u8 len][len bytes] lowercase set codes
 *
 * Hashes are stored in the same Uint32Array(8) word order produced by
 * hashCore.hexToHash, so hamming distance runs directly on the stored words.
 */

// Explicit .js extension: this module is also imported by the Node seed
// script, where extensionless ESM imports fail.
import { hexToHash, hashToHex } from './hashCore.js'

export const PACK_MAGIC = 0x31485641 // 'AVH1' read as LE u32
export const PACK_FORMAT_VERSION = 3
const HEADER_BYTES = 32
const META_SEP = '\x1F'

const pad4 = n => (n + 3) & ~3

// ── UUID helpers ─────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export function uuidToBytes(uuid, out, offset = 0) {
  if (!UUID_RE.test(uuid)) return false
  const hex = uuid.replace(/-/g, '')
  for (let i = 0; i < 16; i++) {
    out[offset + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return true
}

const HEX_LUT = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

export function bytesToUuid(bytes, offset = 0) {
  let s = ''
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) s += '-'
    s += HEX_LUT[bytes[offset + i]]
  }
  return s
}

/**
 * Scryfall serves card images from a stable CDN path derived from the card id
 * (verified against 106k live rows; the 3 exceptions are Secret Lair
 * reversible cards — cosmetic only). Back-face rows still return the FRONT
 * image: the basket entry represents the card, not the side that was scanned.
 */
export function deriveImageUri(scryfallId) {
  return `https://cards.scryfall.io/normal/front/${scryfallId[0]}/${scryfallId[1]}/${scryfallId}.jpg`
}

// ── Encoding (Node seed script + tests) ──────────────────────────────────────

/**
 * Encode rows into a single pack chunk (format v2, or v3 when tileGrid > 0).
 * @param {Array<{scryfall_id, name, set_code, collector_number, flavor_name?,
 *                face?, phash_hex, phash_hex2, phash_full_hex,
 *                phash_tiles_hex?}>} rows — phash_tiles_hex is an array of
 *                tileGrid² 64-char hex hashes (row-major tiles)
 * @param {number} hashVersion — scanner hash pipeline version stamp
 * @param {{tileGrid?: number}} [opts] — tiles per side; 0/absent = v2 chunk
 * @returns {ArrayBuffer}
 */
export function encodeHashPack(rows, hashVersion, { tileGrid = 0 } = {}) {
  const count = rows.length
  const encoder = new TextEncoder()
  const tileCount = tileGrid > 0 ? tileGrid * tileGrid : 0
  const formatVersion = tileGrid > 0 ? 3 : 2

  const setIndexByCode = new Map()
  const setCodes = []
  const setIdxPerRow = new Uint16Array(count)

  const parsedLuma = []
  const parsedColor = []
  const parsedFull = []
  const parsedTiles = []
  const metaParts = []
  let metaBytesLen = 0

  for (let i = 0; i < count; i++) {
    const r = rows[i]
    const luma = hexToHash(r.phash_hex)
    const color = hexToHash(r.phash_hex2)
    const full = hexToHash(r.phash_full_hex)
    if (!luma) throw new Error(`Invalid phash_hex for ${r.scryfall_id}`)
    if (!color) throw new Error(`Invalid phash_hex2 for ${r.scryfall_id}`)
    if (!full) throw new Error(`Invalid phash_full_hex for ${r.scryfall_id}`)
    parsedLuma.push(luma)
    parsedColor.push(color)
    parsedFull.push(full)
    if (tileCount) {
      const tiles = r.phash_tiles_hex
      if (!Array.isArray(tiles) || tiles.length !== tileCount) {
        throw new Error(`Expected ${tileCount} tile hashes for ${r.scryfall_id}`)
      }
      const parsed = tiles.map(hex => hexToHash(hex))
      if (parsed.some(t => !t)) throw new Error(`Invalid phash_tiles_hex for ${r.scryfall_id}`)
      parsedTiles.push(parsed)
    }

    const code = String(r.set_code || '').toLowerCase()
    let setIdx = setIndexByCode.get(code)
    if (setIdx === undefined) {
      setIdx = setCodes.length
      if (setIdx > 0xFFFF) throw new Error('Set table overflow (u16)')
      setIndexByCode.set(code, setIdx)
      setCodes.push(code)
    }
    setIdxPerRow[i] = setIdx

    const clean = v => String(v ?? '').replaceAll(META_SEP, ' ')
    const meta = `${clean(r.name)}${META_SEP}${clean(r.collector_number)}${META_SEP}${clean(r.flavor_name)}`
    const bytes = encoder.encode(meta)
    metaParts.push(bytes)
    metaBytesLen += bytes.length
  }

  const setTableParts = setCodes.map(code => encoder.encode(code))
  let setTableLen = 0
  for (const p of setTableParts) {
    if (p.length > 255) throw new Error(`Set code too long: ${p.length} bytes`)
    setTableLen += 1 + p.length
  }

  const offA = HEADER_BYTES
  const offB = offA + count * 32
  const offB2 = offB + count * 32
  const offB3 = offB2 + count * 32
  const offC = offB3 + count * tileCount * 32
  const offFC = offC + count * 16
  const offD = offFC + pad4(count)
  const offE = offD + pad4(count * 2)
  const offF = offE + (count + 1) * 4
  const offG = offF + metaBytesLen
  const totalBytes = offG + setTableLen

  const buf = new ArrayBuffer(totalBytes)
  const view = new DataView(buf)
  const u8 = new Uint8Array(buf)

  view.setUint32(0, PACK_MAGIC, true)
  view.setUint16(4, formatVersion, true)
  view.setUint16(6, hashVersion, true)
  view.setUint32(8, count, true)
  view.setUint32(12, metaBytesLen, true)
  view.setUint16(16, setCodes.length, true)
  view.setUint16(18, tileGrid, true)
  view.setUint32(20, setTableLen, true)

  const luma = new Uint32Array(buf, offA, count * 8)
  const color = new Uint32Array(buf, offB, count * 8)
  const full = new Uint32Array(buf, offB2, count * 8)
  const tilesArr = tileCount ? new Uint32Array(buf, offB3, count * tileCount * 8) : null
  const faces = new Uint8Array(buf, offFC, count)
  const setIdxArr = new Uint16Array(buf, offD, count)
  const metaOffsets = new Uint32Array(buf, offE, count + 1)

  let metaCursor = 0
  for (let i = 0; i < count; i++) {
    luma.set(parsedLuma[i], i * 8)
    color.set(parsedColor[i], i * 8)
    full.set(parsedFull[i], i * 8)
    if (tilesArr) {
      for (let t = 0; t < tileCount; t++) {
        tilesArr.set(parsedTiles[i][t], (i * tileCount + t) * 8)
      }
    }
    if (!uuidToBytes(rows[i].scryfall_id, u8, offC + i * 16)) {
      throw new Error(`Non-UUID scryfall_id: ${rows[i].scryfall_id}`)
    }
    faces[i] = rows[i].face ? 1 : 0
    setIdxArr[i] = setIdxPerRow[i]
    metaOffsets[i] = metaCursor
    u8.set(metaParts[i], offF + metaCursor)
    metaCursor += metaParts[i].length
  }
  metaOffsets[count] = metaCursor

  let setCursor = offG
  for (const p of setTableParts) {
    u8[setCursor++] = p.length
    u8.set(p, setCursor)
    setCursor += p.length
  }

  return buf
}

// ── Decoding ─────────────────────────────────────────────────────────────────

/**
 * Decode a chunk buffer (format v1, v2, or v3) into typed-array views (zero
 * copy over `buf`). v1 chunks decode with `full`/`faces` = null and no flavor
 * names; pre-v3 chunks decode with `tiles` = null / `tileGrid` = 0. Throws on
 * malformed input.
 */
export function decodeHashPack(buf) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < HEADER_BYTES) {
    throw new Error('Hash pack: buffer too small')
  }
  const view = new DataView(buf)
  if (view.getUint32(0, true) !== PACK_MAGIC) throw new Error('Hash pack: bad magic')
  const formatVersion = view.getUint16(4, true)
  if (formatVersion !== 1 && formatVersion !== 2 && formatVersion !== 3) {
    throw new Error(`Hash pack: unsupported format v${formatVersion}`)
  }
  const hashVersion = view.getUint16(6, true)
  const count = view.getUint32(8, true)
  const metaBytesLen = view.getUint32(12, true)
  const setCount = view.getUint16(16, true)
  const tileGrid = formatVersion >= 3 ? view.getUint16(18, true) : 0
  const setTableLen = view.getUint32(20, true)

  const v2 = formatVersion >= 2
  const tileCount = tileGrid * tileGrid
  const offA = HEADER_BYTES
  const offB = offA + count * 32
  const offB2 = offB + count * 32
  const offB3 = (v2 ? offB2 + count * 32 : offB2)
  const offC = offB3 + count * tileCount * 32
  const offFC = offC + count * 16
  const offD = v2 ? offFC + pad4(count) : offFC
  const offE = offD + pad4(count * 2)
  const offF = offE + (count + 1) * 4
  const offG = offF + metaBytesLen
  if (buf.byteLength < offG + setTableLen) throw new Error('Hash pack: truncated buffer')

  const u8 = new Uint8Array(buf)
  const decoder = new TextDecoder()
  const sets = []
  let cursor = offG
  for (let i = 0; i < setCount; i++) {
    const len = u8[cursor++]
    sets.push(decoder.decode(u8.subarray(cursor, cursor + len)))
    cursor += len
  }

  return {
    formatVersion,
    hashVersion,
    count,
    tileGrid,
    luma: new Uint32Array(buf, offA, count * 8),
    color: new Uint32Array(buf, offB, count * 8),
    full: v2 ? new Uint32Array(buf, offB2, count * 8) : null,
    tiles: tileCount ? new Uint32Array(buf, offB3, count * tileCount * 8) : null,
    uuids: new Uint8Array(buf, offC, count * 16),
    faces: v2 ? new Uint8Array(buf, offFC, count) : null,
    setIdx: new Uint16Array(buf, offD, count),
    metaOffsets: new Uint32Array(buf, offE, count + 1),
    metaBytes: new Uint8Array(buf, offF, metaBytesLen),
    sets,
  }
}

// ── Store — appendable multi-chunk view with global row indices ──────────────

export class HashPackStore {
  constructor() {
    this.chunks = []
    this.starts = [0]  // starts[i] = global index of chunk i's first row
    this.count = 0
    this.hashVersion = null
    this._decoder = new TextDecoder()
  }

  /**
   * Decode and append a chunk buffer. Returns the decoded chunk.
   * All appended chunks must agree on hashVersion.
   */
  appendChunkBuffer(buf) {
    const chunk = decodeHashPack(buf)
    if (this.hashVersion == null) this.hashVersion = chunk.hashVersion
    else if (chunk.hashVersion !== this.hashVersion) {
      throw new Error(`Hash pack: version mismatch (${chunk.hashVersion} vs ${this.hashVersion})`)
    }
    chunk.buffer = buf   // raw buffer kept for worker replay
    this.chunks.push(chunk)
    this.count += chunk.count
    this.starts.push(this.count)
    return chunk
  }

  /** True when every chunk carries full-card hashes (format v2). */
  get hasFullHashes() {
    return this.chunks.length > 0 && this.chunks.every(c => !!c.full)
  }

  /**
   * Tile grid shared by every chunk (format v3), or 0 when any chunk lacks
   * tiles / grids disagree — matching then falls back to whole-art distance.
   */
  get tileGrid() {
    if (!this.chunks.length) return 0
    const grid = this.chunks[0].tileGrid || 0
    if (!grid) return 0
    return this.chunks.every(c => (c.tileGrid || 0) === grid && !!c.tiles) ? grid : 0
  }

  /** Map a global row index to { chunk, chunkIdx, local }. */
  locate(globalIdx) {
    // Handful of chunks — linear scan beats binary search bookkeeping.
    for (let c = this.chunks.length - 1; c >= 0; c--) {
      if (globalIdx >= this.starts[c]) {
        return { chunk: this.chunks[c], chunkIdx: c, local: globalIdx - this.starts[c] }
      }
    }
    return null
  }

  /** Decoded meta fields for a chunk-local row: [name, collNum, flavorName]. */
  static rowMeta(chunk, local, decoder) {
    const meta = decoder.decode(
      chunk.metaBytes.subarray(chunk.metaOffsets[local], chunk.metaOffsets[local + 1]),
    )
    const parts = meta.split(META_SEP)
    return [parts[0] ?? '', parts[1] ?? '', parts[2] ?? '']
  }

  /** Just the card name for a global row index (hot-path gap logic). */
  rowName(globalIdx) {
    const loc = this.locate(globalIdx)
    if (!loc) return ''
    return HashPackStore.rowMeta(loc.chunk, loc.local, this._decoder)[0]
  }

  /** Public card object for match results. */
  getCardPublic(globalIdx, distance) {
    const loc = this.locate(globalIdx)
    if (!loc) return null
    const { chunk, local } = loc
    const id = bytesToUuid(chunk.uuids, local * 16)
    const [name, collNum, flavorName] = HashPackStore.rowMeta(chunk, local, this._decoder)
    return {
      id,
      name,
      setCode: chunk.sets[chunk.setIdx[local]] || null,
      collNum: collNum || null,
      flavorName: flavorName || null,
      imageUri: deriveImageUri(id),
      distance,
    }
  }

  /** Union of set codes across chunks (OCR set-candidate validation). */
  allSets() {
    const sets = new Set()
    for (const chunk of this.chunks) for (const s of chunk.sets) sets.add(s)
    return sets
  }

  /** All scryfall ids in the store (tests). */
  *ids() {
    for (const chunk of this.chunks) {
      for (let i = 0; i < chunk.count; i++) yield bytesToUuid(chunk.uuids, i * 16)
    }
  }

  /**
   * Seed-state entries: one { id, face } per row — the seed script diffs the
   * Scryfall bulk against this to hash only new cards/faces.
   */
  *entries() {
    for (const chunk of this.chunks) {
      for (let i = 0; i < chunk.count; i++) {
        yield { id: bytesToUuid(chunk.uuids, i * 16), face: chunk.faces ? chunk.faces[i] : 0 }
      }
    }
  }

  /**
   * Find a card by set code + collector number (OCR printing lookup).
   * Tolerates the printed-vs-Scryfall promo set mismatch ('fdn' printed on a
   * card Scryfall codes as 'pfdn'). Returns a global index or -1. Front faces
   * win (first-encoded). The index is built lazily on first use and rebuilt
   * when chunks were appended since.
   */
  findByPrint(setCode, collNum) {
    if (!setCode || !collNum) return -1
    if (!this._printIndex || this._printIndexCount !== this.count) {
      const index = new Map()
      let globalIdx = 0
      for (const chunk of this.chunks) {
        for (let i = 0; i < chunk.count; i++, globalIdx++) {
          const [, coll] = HashPackStore.rowMeta(chunk, i, this._decoder)
          if (!coll) continue
          const key = `${chunk.sets[chunk.setIdx[i]]}|${coll.toLowerCase()}`
          if (!index.has(key)) index.set(key, globalIdx)
        }
      }
      this._printIndex = index
      this._printIndexCount = this.count
    }
    const set = String(setCode).toLowerCase()
    const coll = String(collNum).toLowerCase()
    for (const key of [`${set}|${coll}`, `p${set}|${coll}`]) {
      const idx = this._printIndex.get(key)
      if (idx !== undefined) return idx
    }
    return -1
  }

  /** Re-hex the stored hashes for a chunk-local row (seed-state diffing). */
  static rowHexes(chunk, local) {
    const tileCount = (chunk.tileGrid || 0) ** 2
    let tiles = null
    if (tileCount && chunk.tiles) {
      tiles = []
      const base = local * tileCount * 8
      for (let t = 0; t < tileCount; t++) {
        tiles.push(hashToHex(chunk.tiles.subarray(base + t * 8, base + (t + 1) * 8)))
      }
    }
    return {
      phash_hex: hashToHex(chunk.luma.subarray(local * 8, local * 8 + 8)),
      phash_hex2: hashToHex(chunk.color.subarray(local * 8, local * 8 + 8)),
      phash_full_hex: chunk.full
        ? hashToHex(chunk.full.subarray(local * 8, local * 8 + 8))
        : null,
      phash_tiles_hex: tiles,
    }
  }
}

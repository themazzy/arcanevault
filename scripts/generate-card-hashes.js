/**
 * generate-card-hashes.js — hash pipeline v7
 *
 * Builds the scanner's hash pack (public/scanner/hashpack/) directly from
 * Scryfall bulk data. The pack itself is the pipeline's state — the old
 * Supabase card_hashes table is retired (see supabase/migrations for the
 * drop, to be applied once a v7 pack is verified).
 *
 * Per card row (front face; plus a second row for the back face of
 * double-faced cards so back-side-up scans can match):
 *   phash_hex        — art-crop luma pHash
 *   phash_hex2       — art-crop saturation pHash
 *   phash_full_hex   — whole-card luma pHash (v7 second signal)
 *   phash_tiles_hex  — per-tile art hashes, only when TILE_GRID > 0 (the v8
 *                      tile experiment; currently OFF — see constants.js)
 * All hashing goes through src/scanner/hashCard.js, which shares the exact
 * 32×32 area-resize with the live scanner (v7 unification — before this the
 * seed used Sharp's mitchell kernel).
 *
 * Incremental by default: rows whose (scryfall_id, face) already exist in a
 * current-version pack are skipped. Progress is checkpointed as delta chunks
 * every CHECKPOINT_ROWS completed rows, so an interrupted overnight run
 * resumes where it left off. A finished run consolidates fragmented chunks
 * back into large newest-first ones (chunk 0 = newest sets — the scanner
 * unlocks after the first chunk).
 *
 * Usage:
 *   node scripts/generate-card-hashes.js [--reseed] [--concurrency N]
 *
 *   --reseed   discard the existing pack and rebuild everything (required
 *              when the hash algorithm changes)
 *
 * Commit public/scanner/hashpack/ afterwards to deploy.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fetch from 'node-fetch'
import sharp from 'sharp'
import { withParserAsStream } from 'stream-json/streamers/stream-array.js'
import { CARD_W, CARD_H, TILE_GRID } from '../src/scanner/constants.js'
import { computeSeedHashes } from '../src/scanner/hashCard.js'
import { encodeHashPack, HashPackStore, bytesToUuid } from '../src/scanner/hashPack.js'

// Stays at 7: the v8 tile experiment measurably REDUCED lookalike margins
// (see scripts/scanner-grid-harness.js + TILE_GRID in constants.js), so the
// shipped pack keeps the v7 pipeline. With TILE_GRID = 0 the encoder emits
// format-v2 chunks — bump both here and TILE_GRID together to ship tiles.
const HASH_PIPELINE_VERSION = 7
const PACK_FORMAT = 2
const CHUNK_SIZE = 24000        // rows per chunk after consolidation
const CHECKPOINT_ROWS = 8000    // flush a delta chunk every N hashed rows
const CONSOLIDATE_ABOVE = 8     // repack when the pack fragments past this many chunks
const FORCE_RESEED = process.argv.includes('--reseed')
const UA = { 'User-Agent': 'DeckLoomHashSeeder/2.0', Accept: '*/*' }

const concurrencyArgIdx = process.argv.indexOf('--concurrency')
const CONCURRENCY = concurrencyArgIdx !== -1
  ? Math.max(1, parseInt(process.argv[concurrencyArgIdx + 1], 10) || 20)
  : 20

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(__dirname, '..', 'public', 'scanner', 'hashpack')

// ── Pack state ────────────────────────────────────────────────────────────────

function readManifest() {
  const p = path.join(OUT_DIR, 'manifest.json')
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

/** Load the existing v8 pack as seed state. Returns null when unusable. */
function loadPackState() {
  const manifest = readManifest()
  if (!manifest || manifest.hashVersion !== HASH_PIPELINE_VERSION) return null
  const store = new HashPackStore()
  try {
    for (const c of manifest.chunks) {
      const bytes = readFileSync(path.join(OUT_DIR, c.file))
      store.appendChunkBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    }
  } catch (e) {
    console.warn(`Existing pack unreadable (${e.message}) — full rebuild.`)
    return null
  }
  return { manifest, store }
}

function writeChunk(rows, seq) {
  const buf = encodeHashPack(rows, HASH_PIPELINE_VERSION, { tileGrid: TILE_GRID })
  const sha = createHash('sha256').update(new Uint8Array(buf)).digest('hex')
  const file = `pack-v${HASH_PIPELINE_VERSION}-${String(seq).padStart(3, '0')}-${sha.slice(0, 10)}.bin`
  writeFileSync(path.join(OUT_DIR, file), new Uint8Array(buf))
  return { file, count: rows.length, bytes: buf.byteLength, sha256: sha }
}

function writeManifest(chunkMetas) {
  const manifest = {
    formatVersion: PACK_FORMAT,
    hashVersion: HASH_PIPELINE_VERSION,
    generatedAt: new Date().toISOString(),
    totalCount: chunkMetas.reduce((s, c) => s + c.count, 0),
    chunks: chunkMetas.map(({ file, count, bytes, sha256 }) => ({ file, count, bytes, sha256 })),
  }
  writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

function pruneUnreferencedChunks(manifest) {
  const valid = new Set(manifest.chunks.map(c => c.file))
  for (const f of readdirSync(OUT_DIR)) {
    if (f.endsWith('.bin') && !valid.has(f)) rmSync(path.join(OUT_DIR, f))
  }
}

// ── Scryfall ─────────────────────────────────────────────────────────────────

async function fetchJsonArrayStream(url) {
  const res = await fetch(url, { headers: UA, timeout: 120000 })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return new Promise((resolve, reject) => {
    const items = []
    const pipeline = withParserAsStream()
    pipeline.on('data', ({ value }) => items.push(value))
    pipeline.on('end', () => resolve(items))
    pipeline.on('error', reject)
    res.body.pipe(pipeline)
  })
}

async function fetchSetReleaseDates() {
  const res = await fetch('https://api.scryfall.com/sets', { headers: UA })
  if (!res.ok) throw new Error(`Scryfall /sets HTTP ${res.status}`)
  const json = await res.json()
  const dates = new Map()
  for (const s of json?.data ?? []) dates.set(s.code, s.released_at ?? '0000-00-00')
  return dates
}

/** One task per face that has its own image. */
function cardFaceTasks(card) {
  if (card.digital || !/^[0-9a-f-]{36}$/.test(card.id ?? '')) return []
  const tasks = []
  const frontUri = card.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.normal ?? null
  if (frontUri) {
    tasks.push({
      card, face: 0, imageUri: frontUri,
      flavorName: card.flavor_name ?? card.card_faces?.[0]?.flavor_name ?? '',
    })
  }
  const backUri = card.card_faces?.[1]?.image_uris?.normal ?? null
  if (backUri) {
    tasks.push({
      card, face: 1, imageUri: backUri,
      flavorName: card.flavor_name ?? card.card_faces?.[1]?.flavor_name ?? '',
    })
  }
  return tasks
}

async function hashTask(task) {
  const res = await fetch(task.imageUri, { headers: UA, timeout: 20000 })
  if (!res.ok) throw new Error(`image HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const { data } = await sharp(buf)
    .resize(CARD_W, CARD_H, { fit: 'fill', kernel: 'lanczos3' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const hashes = computeSeedHashes(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length))
  return {
    scryfall_id: task.card.id,
    name: task.card.name,
    set_code: task.card.set,
    collector_number: task.card.collector_number,
    flavor_name: task.flavorName || '',
    face: task.face,
    ...hashes,
  }
}

async function workerPool(items, concurrency, fn) {
  const iter = items[Symbol.iterator]()
  const worker = async () => {
    for (let cur = iter.next(); !cur.done; cur = iter.next()) {
      await fn(cur.value)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
}

// ── Consolidation (repack from state, no downloads) ─────────────────────────

function storeToRows(store) {
  const decoder = new TextDecoder()
  const rows = []
  for (const chunk of store.chunks) {
    for (let i = 0; i < chunk.count; i++) {
      const [name, coll, flavor] = HashPackStore.rowMeta(chunk, i, decoder)
      rows.push({
        scryfall_id: bytesToUuid(chunk.uuids, i * 16),
        name,
        set_code: chunk.sets[chunk.setIdx[i]],
        collector_number: coll,
        flavor_name: flavor,
        face: chunk.faces ? chunk.faces[i] : 0,
        ...HashPackStore.rowHexes(chunk, i),
      })
    }
  }
  return rows
}

function collectorSortKey(collNum) {
  const m = String(collNum ?? '').match(/^(\d+)(.*)$/)
  return m ? [parseInt(m[1], 10), m[2]] : [Number.MAX_SAFE_INTEGER, String(collNum ?? '')]
}

function sortNewestFirst(rows, releaseDates) {
  return rows.slice().sort((a, b) => {
    const da = releaseDates.get(a.set_code) ?? '0000-00-00'
    const db = releaseDates.get(b.set_code) ?? '0000-00-00'
    if (da !== db) return db.localeCompare(da)               // newest set first
    if (a.set_code !== b.set_code) return String(a.set_code).localeCompare(String(b.set_code))
    const [na, sa] = collectorSortKey(a.collector_number)
    const [nb, sb] = collectorSortKey(b.collector_number)
    if (na !== nb) return na - nb
    if (sa !== sb) return sa.localeCompare(sb)
    if (a.scryfall_id !== b.scryfall_id) return String(a.scryfall_id).localeCompare(String(b.scryfall_id))
    return (a.face ?? 0) - (b.face ?? 0)
  })
}

function repackAll(rows, releaseDates) {
  for (const f of readdirSync(OUT_DIR)) {
    if (f.endsWith('.bin')) rmSync(path.join(OUT_DIR, f))
  }
  const sorted = sortNewestFirst(rows, releaseDates)
  const metas = []
  for (let i = 0; i < sorted.length; i += CHUNK_SIZE) {
    metas.push(writeChunk(sorted.slice(i, i + CHUNK_SIZE), metas.length))
  }
  return writeManifest(metas)
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Hash pack seeder — pipeline v${HASH_PIPELINE_VERSION}${FORCE_RESEED ? ' (forced reseed)' : ''}`)
  mkdirSync(OUT_DIR, { recursive: true })

  const state = FORCE_RESEED ? null : loadPackState()
  const have = new Set()
  if (state) {
    for (const { id, face } of state.store.entries()) have.add(`${id}|${face}`)
    console.log(`Existing v${HASH_PIPELINE_VERSION} pack: ${have.size} rows — hashing only what's missing.`)
  } else {
    console.log(`No usable v${HASH_PIPELINE_VERSION} pack state — full build (an older pack is superseded).`)
  }

  console.log('Downloading Scryfall bulk data…')
  const bulkMeta = await (await fetch('https://api.scryfall.com/bulk-data/default-cards', { headers: UA })).json()
  const cards = await fetchJsonArrayStream(bulkMeta.download_uri)
  const releaseDates = await fetchSetReleaseDates()
  console.log(`${cards.length} cards in bulk data.`)

  const tasks = cards
    .flatMap(cardFaceTasks)
    .filter(t => !have.has(`${t.card.id}|${t.face}`))
  console.log(`${tasks.length} faces to hash (concurrency ${CONCURRENCY}). Estimated download ~${(tasks.length * 0.13 / 1024).toFixed(1)} GB.`)

  let chunkMetas = state ? [...state.manifest.chunks] : []
  let pending = []
  let done = 0, errors = 0, lastLog = 0

  const flushCheckpoint = () => {
    if (!pending.length) return
    const meta = writeChunk(pending, chunkMetas.length)
    chunkMetas = [meta, ...chunkMetas]   // newest work first in load order
    writeManifest(chunkMetas)
    console.log(`  checkpoint: +${pending.length} rows → ${meta.file}`)
    pending = []
  }

  await workerPool(tasks, CONCURRENCY, async task => {
    try {
      pending.push(await hashTask(task))
      done++
      if (pending.length >= CHECKPOINT_ROWS) flushCheckpoint()
    } catch (e) {
      errors++
      if (errors <= 50) console.warn(`  x ${task.card.name}${task.face ? ' (back)' : ''}: ${e.message}`)
    }
    const total = done + errors
    if (total - lastLog >= 500) {
      lastLog = total
      console.log(`  ${total}/${tasks.length} (${Math.round(total / tasks.length * 100)}%) — ${done} ok, ${errors} errors`)
    }
  })
  flushCheckpoint()

  if (!chunkMetas.length) {
    console.log('Nothing hashed and no existing pack — aborting without a manifest.')
    process.exit(1)
  }

  // Consolidate fragmented packs into large newest-first chunks.
  let manifest = writeManifest(chunkMetas)
  if (manifest.chunks.length > CONSOLIDATE_ABOVE) {
    console.log(`Consolidating ${manifest.chunks.length} chunks…`)
    const store = new HashPackStore()
    for (const c of manifest.chunks) {
      const bytes = readFileSync(path.join(OUT_DIR, c.file))
      store.appendChunkBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    }
    manifest = repackAll(storeToRows(store), releaseDates)
  }
  pruneUnreferencedChunks(manifest)

  const mb = manifest.chunks.reduce((s, c) => s + c.bytes, 0) / 1024 / 1024
  console.log(`\nDone: ${done} hashed, ${errors} errors. Pack: ${manifest.totalCount} rows in ${manifest.chunks.length} chunk(s), ${mb.toFixed(1)} MB.`)
  if (errors) console.log('Failed faces are retried automatically on the next run.')
  console.log('Commit public/scanner/hashpack/ to deploy.')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})

/**
 * generate-card-hashes.js
 *
 * Pre-computes 256-bit perceptual hashes for MTG cards and uploads them to
 * Supabase `card_hashes`.
 *
 * The important detail: hashes are computed from the same full-card -> fixed
 * size -> art-box crop geometry used by the live scanner. Do not seed from
 * Scryfall `art_crop` unless the scanner pipeline changes too.
 *
 * Setup:
 *   npm install node-fetch sharp @supabase/supabase-js dotenv stream-json
 *
 * Usage:
 *   VITE_SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_KEY=your-service-key \
 *   node scripts/generate-card-hashes.js
 *
 * Flags:
 *   --reseed      Reprocess all cards (ignore existing rows). Required when
 *                 the hash algorithm changes.
 *   --concurrency N  Override parallel download count (default: 20).
 */

import 'dotenv/config'
import fetch from 'node-fetch'
import sharp from 'sharp'
import { createClient } from '@supabase/supabase-js'
import { parser } from 'stream-json'
import { streamArray } from 'stream-json/streamers/StreamArray.js'
import { ART_H, ART_W, ART_X, ART_Y, CARD_H, CARD_W } from '../src/scanner/constants.js'
import { computeHashFromGray, hashToHex, rgbToGray32x32, rgbToSaturation32x32 } from '../src/scanner/hashCore.js'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_ANON_KEY
const BATCH_SIZE   = 100
const FORCE_RESEED = process.argv.includes('--reseed')
const HASH_PIPELINE_VERSION = 6

// Parse --concurrency N from argv, default 20
const concurrencyArgIdx = process.argv.indexOf('--concurrency')
const CONCURRENCY = concurrencyArgIdx !== -1
  ? Math.max(1, parseInt(process.argv[concurrencyArgIdx + 1], 10) || 20)
  : 20

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Set VITE_SUPABASE_URL and SUPABASE_SERVICE_KEY (service role key required to write card_hashes)')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

/**
 * Two Sharp passes connected via raw pixel buffer (no intermediate PNG encode/decode).
 * Sharp does not support two resize() calls in one pipeline — the second overrides
 * the first, making the extract coordinates invalid. Raw transfer avoids the codec cost.
 *
 * Pipeline v6: removed pre-blur before 32×32 downscale (redundant at 13× reduction;
 * area-averaging inherently low-passes). Browser uses INTER_AREA; seed uses mitchell
 * (closest Sharp equivalent for large downsamples). Reseed required when either changes.
 */
async function computePHashHex(imageBuffer) {
  // Pass 1: resize to card dims → extract art region → raw pixels
  const { data: artRaw, info: artInfo } = await sharp(imageBuffer)
    .resize(CARD_W, CARD_H, { fit: 'fill', kernel: 'lanczos3' })
    .extract({ left: ART_X, top: ART_Y, width: ART_W, height: ART_H })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  // Pass 2: resize to 32×32 (no pre-blur — redundant for large downscales)
  const { data } = await sharp(artRaw, {
    raw: { width: artInfo.width, height: artInfo.height, channels: artInfo.channels },
  })
    .resize(32, 32, { fit: 'fill', kernel: 'mitchell' })
    .raw()
    .toBuffer({ resolveWithObject: true })

  const grayU8 = rgbToGray32x32(data, artInfo.channels)
  const hash   = computeHashFromGray(grayU8)
  const hex    = hashToHex(hash)

  const satU8     = rgbToSaturation32x32(data, artInfo.channels)
  const colorHash = computeHashFromGray(satU8)
  const hex2      = hashToHex(colorHash)

  const bigints = []
  for (let i = 0; i < 8; i += 2) {
    bigints.push((BigInt(hash[i + 1] >>> 0) << 32n) | BigInt(hash[i] >>> 0))
  }

  return { hex, hex2, p1: bigints[0], p2: bigints[1], p3: bigints[2], p4: bigints[3] }
}

// Stream-parse a large JSON array from a URL to avoid Node's string-length limit (~512 MB).
async function fetchJsonArray(url) {
  const res = await fetch(url, { timeout: 120000 })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return new Promise((resolve, reject) => {
    const items = []
    const jsonParser = parser()
    const arrStreamer = streamArray()
    arrStreamer.on('data', ({ value }) => items.push(value))
    arrStreamer.on('end', () => resolve(items))
    arrStreamer.on('error', reject)
    jsonParser.on('error', reject)
    res.body.pipe(jsonParser).pipe(arrStreamer)
  })
}

async function fetchImage(url) {
  const res = await fetch(url, { timeout: 20000 })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

function getCardImageUri(card) {
  const face = card.card_faces?.find(f => f.image_uris?.normal) ?? card.card_faces?.[0] ?? null
  return {
    imageUri:   card.image_uris?.normal   ?? face?.image_uris?.normal   ?? null,
    artCropUri: card.image_uris?.art_crop ?? face?.image_uris?.art_crop ?? null,
  }
}

function toInt64(n) {
  const signed = BigInt.asIntN(64, n)
  return signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)
    ? String(signed)
    : Number(signed)
}

/**
 * Worker-pool: keeps CONCURRENCY tasks always in flight rather than waiting
 * for the slowest card in each fixed-size chunk before starting the next batch.
 */
async function workerPool(items, concurrency, fn) {
  const iter = items[Symbol.iterator]()
  const worker = async () => {
    for (let cur = iter.next(); !cur.done; cur = iter.next()) {
      await fn(cur.value)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
}

async function main() {
  console.log(`Hash pipeline v${HASH_PIPELINE_VERSION}; use --reseed after scanner hash changes.`)
  console.log('Downloading Scryfall default_cards bulk data...')
  const bulkRes  = await fetch('https://api.scryfall.com/bulk-data/default-cards')
  const bulkMeta = await bulkRes.json()
  console.log('Streaming bulk card data (this may take a minute)...')
  const cards = await fetchJsonArray(bulkMeta.download_uri)
  console.log(`Loaded ${cards.length} cards from Scryfall.`)

  let existing = new Set()
  if (!FORCE_RESEED) {
    console.log('Fetching existing hashes from Supabase...')
    let page = 0
    while (true) {
      const { data } = await sb
        .from('card_hashes')
        .select('scryfall_id')
        .range(page * 1000, page * 1000 + 999)
      if (!data?.length) break
      data.forEach(r => existing.add(r.scryfall_id))
      page++
      if (data.length < 1000) break
    }
    console.log(`${existing.size} cards already in Supabase — will skip.`)
  } else {
    console.log('--reseed: processing all cards (ignoring existing rows).')
    console.log('--reseed: clearing existing card_hashes rows before upload...')
    const { error } = await sb
      .from('card_hashes')
      .delete()
      .not('scryfall_id', 'is', null)
    if (error) throw new Error(`Could not clear card_hashes before reseed: ${error.message}`)
  }

  const todo = cards.filter(card => {
    const { imageUri } = getCardImageUri(card)
    return imageUri && !card.digital && !existing.has(card.id)
  })
  console.log(`Processing ${todo.length} new cards with concurrency=${CONCURRENCY}...`)

  let done   = 0
  let errors = 0
  let lastLog = 0
  const batch = []

  const flush = async () => {
    if (!batch.length) return
    const rows = batch.splice(0)
    const { error } = await sb.from('card_hashes').upsert(rows, { onConflict: 'scryfall_id' })
    if (error) console.error('Upsert error:', error.message)
  }

  const processCard = async (card) => {
    try {
      const { imageUri, artCropUri } = getCardImageUri(card)
      if (!imageUri) throw new Error('No usable full-card image')

      const imageBuffer = await fetchImage(imageUri)
      const { hex, hex2, p1, p2, p3, p4 } = await computePHashHex(imageBuffer)

      batch.push({
        scryfall_id:      card.id,
        oracle_id:        card.oracle_id ?? null,
        name:             card.name,
        set_code:         card.set,
        collector_number: card.collector_number,
        hash_part_1:      toInt64(p1),
        hash_part_2:      toInt64(p2),
        hash_part_3:      toInt64(p3),
        hash_part_4:      toInt64(p4),
        phash_hex:        hex,
        phash_hex2:       hex2,
        image_uri:        imageUri,
        art_crop_uri:     artCropUri,
      })
      done++

      if (batch.length >= BATCH_SIZE) await flush()
    } catch (e) {
      errors++
      console.warn(`  x ${card.name} (${card.id}): ${e.message}`)
    }

    const total = done + errors
    if (total - lastLog >= 200 || total === todo.length) {
      lastLog = total
      const pct = Math.round((total / todo.length) * 100)
      console.log(`  ${total}/${todo.length} (${pct}%) — ${done} ok, ${errors} errors`)
    }
  }

  await workerPool(todo, CONCURRENCY, processCard)
  await flush()

  console.log(`\nDone. ${done} hashes uploaded, ${errors} errors.`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})

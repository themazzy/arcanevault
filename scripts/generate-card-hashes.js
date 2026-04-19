/**
 * generate-card-hashes.js
 *
 * Pre-computes perceptual hashes for MTG cards and uploads them to
 * Supabase `card_hashes`.
 *
 * The important detail: hashes are computed from the same full-card -> fixed
 * size -> art-box crop geometry used by the live scanner. Do not seed from
 * Scryfall `art_crop` unless the scanner pipeline changes too.
 *
 * Setup:
 *   npm install node-fetch sharp @supabase/supabase-js dotenv
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
import { ART_X, ART_Y, CARD_H, CARD_W, ART_W, ART_H } from '../src/scanner/constants.js'
import {
  computeHashFromGray,
  hashToHex,
  preprocessArtTo32x32Gray,
  preprocessArtTo32x32Sat,
} from '../src/scanner/hashCore.js'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_ANON_KEY
const BATCH_SIZE   = 100
const FORCE_RESEED = process.argv.includes('--reseed')

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
 * Sharp still handles the 500x700 full-card warp and fixed art-box extraction.
 * After that, the shared pure-JS preprocess pipeline takes over so the seed
 * script and live scanner produce identical pixels before hashing.
 */
async function computePHashHex(imageBuffer) {
  const { data: artRaw, info: artInfo } = await sharp(imageBuffer)
    .resize(CARD_W, CARD_H, { fit: 'fill' })
    .extract({ left: ART_X, top: ART_Y, width: ART_W, height: ART_H })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const grayU8 = preprocessArtTo32x32Gray(artRaw, artInfo.width, artInfo.height, artInfo.channels)
  const hash = computeHashFromGray(grayU8)
  const hex = hashToHex(hash)

  const satU8 = preprocessArtTo32x32Sat(artRaw, artInfo.width, artInfo.height, artInfo.channels)
  const colorHash = computeHashFromGray(satU8)
  const hex2 = hashToHex(colorHash)

  const { data: fullRaw, info: fullInfo } = await sharp(imageBuffer)
    .resize(CARD_W, CARD_H, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const fullGray = preprocessArtTo32x32Gray(fullRaw, fullInfo.width, fullInfo.height, fullInfo.channels)
  const fullHash = computeHashFromGray(fullGray)
  const hex3 = hashToHex(fullHash)

  return { hex, hex2, hex3 }
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
  console.log('Downloading Scryfall default_cards bulk data...')
  const bulkRes  = await fetch('https://api.scryfall.com/bulk-data/default-cards')
  const bulkMeta = await bulkRes.json()
  const cardsRes = await fetch(bulkMeta.download_uri)
  const cards    = await cardsRes.json()
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
      const { hex, hex2, hex3 } = await computePHashHex(imageBuffer)

      batch.push({
        scryfall_id:      card.id,
        oracle_id:        card.oracle_id ?? null,
        name:             card.name,
        set_code:         card.set,
        collector_number: card.collector_number,
        phash_hex:        hex,
        phash_hex2:       hex2,
        phash_hex_full:   hex3,
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

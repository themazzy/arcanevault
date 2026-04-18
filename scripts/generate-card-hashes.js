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
 *   npm install node-fetch sharp @supabase/supabase-js dotenv
 *
 * Usage:
 *   VITE_SUPABASE_URL=https://xxx.supabase.co \
 *   VITE_SUPABASE_ANON_KEY=your-key \
 *   node scripts/generate-card-hashes.js
 */

import 'dotenv/config'
import fetch from 'node-fetch'
import sharp from 'sharp'
import { createClient } from '@supabase/supabase-js'
import { ART_H, ART_W, ART_X, ART_Y, CARD_H, CARD_W } from '../src/scanner/constants.js'
import { computeHashFromGray, hashToHex, rgbToGray32x32, rgbToSaturation32x32 } from '../src/scanner/hashCore.js'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_ANON_KEY
const BATCH_SIZE = 50
const CONCURRENCY = 4
// Pass --reseed to reprocess all cards (ignores existing rows). Required when
// the hash algorithm changes (e.g. CLAHE tile size, new color hash column).
const FORCE_RESEED = process.argv.includes('--reseed')

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Set VITE_SUPABASE_URL and SUPABASE_SERVICE_KEY (service role key required to write card_hashes)')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

async function computePHashHex(imageBuffer) {
  // Output raw RGB (not sharp's built-in grayscale) so we can apply the
  // exact same BT.709 formula used by the live scanner in the browser.
  // sharp.blur(1.0) is a Gaussian approximation with σ=1.0, which differs slightly
  // from the browser's cv.GaussianBlur 5×5 kernel (σ=1.0, clipped at 2.5σ).
  // After the 32×32 resize the difference is sub-bit and does not affect hash quality.
  const { data } = await sharp(imageBuffer)
    .blur(1.0)
    .resize(32, 32, { fit: 'fill', kernel: 'lanczos3' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const grayU8 = rgbToGray32x32(data, 3)
  const hash = computeHashFromGray(grayU8)
  const hex = hashToHex(hash)

  // Color hash — HSV saturation channel
  const satU8 = rgbToSaturation32x32(data, 3)
  const colorHash = computeHashFromGray(satU8)
  const hex2 = hashToHex(colorHash)

  // Convert Uint32Array(8) back to BigInt for the DB BIGINT columns
  const bigints = []
  for (let i = 0; i < 8; i += 2) {
    bigints.push((BigInt(hash[i + 1] >>> 0) << 32n) | BigInt(hash[i] >>> 0))
  }

  return { hex, hex2, p1: bigints[0], p2: bigints[1], p3: bigints[2], p4: bigints[3] }
}

async function fetchImage(url) {
  const res = await fetch(url, { timeout: 15000 })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

function getCardImageUris(card) {
  const face = card.card_faces?.find(f => f.image_uris?.normal) ?? card.card_faces?.[0] ?? null
  return {
    imageUri: card.image_uris?.normal ?? face?.image_uris?.normal ?? null,
    artCropUri: card.image_uris?.art_crop ?? face?.image_uris?.art_crop ?? null,
  }
}

async function extractScannerArtCrop(fullCardBuffer) {
  return sharp(fullCardBuffer)
    .resize(CARD_W, CARD_H, { fit: 'fill' })
    .extract({ left: ART_X, top: ART_Y, width: ART_W, height: ART_H })
    .png()
    .toBuffer()
}

function toInt64(n) {
  const signed = BigInt.asIntN(64, n)
  return signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)
    ? String(signed)
    : Number(signed)
}

async function main() {
  console.log('Downloading Scryfall default_cards bulk data...')
  const bulkRes = await fetch('https://api.scryfall.com/bulk-data/default-cards')
  const bulkMeta = await bulkRes.json()
  const cardsRes = await fetch(bulkMeta.download_uri)
  const cards = await cardsRes.json()
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
      data.forEach(row => existing.add(row.scryfall_id))
      page++
      if (data.length < 1000) break
    }
    console.log(`${existing.size} cards already in Supabase - will skip.`)
  } else {
    console.log('--reseed: processing all cards (ignoring existing rows).')
  }

  const todo = cards.filter(card => {
    const { imageUri } = getCardImageUris(card)
    return imageUri && !existing.has(card.id)
  })
  console.log(`Processing ${todo.length} new cards...`)

  let done = 0
  let errors = 0
  const batch = []

  const flush = async () => {
    if (!batch.length) return
    const { error } = await sb.from('card_hashes').upsert(batch, { onConflict: 'scryfall_id' })
    if (error) console.error('Upsert error:', error.message)
    batch.length = 0
  }

  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const chunk = todo.slice(i, i + CONCURRENCY)
    await Promise.all(chunk.map(async (card) => {
      try {
        const { imageUri, artCropUri } = getCardImageUris(card)
        if (!imageUri) throw new Error('No usable full-card image')

        const fullCardBuffer = await fetchImage(imageUri)
        const scannerCropBuffer = await extractScannerArtCrop(fullCardBuffer)
        const { hex, hex2, p1, p2, p3, p4 } = await computePHashHex(scannerCropBuffer)

        batch.push({
          scryfall_id: card.id,
          oracle_id: card.oracle_id ?? null,
          name: card.name,
          set_code: card.set,
          collector_number: card.collector_number,
          hash_part_1: toInt64(p1),
          hash_part_2: toInt64(p2),
          hash_part_3: toInt64(p3),
          hash_part_4: toInt64(p4),
          phash_hex: hex,
          phash_hex2: hex2,
          image_uri: imageUri,
          art_crop_uri: artCropUri,
        })
        done++
      } catch (e) {
        errors++
        console.warn(`  x ${card.name} (${card.id}): ${e.message}`)
      }
    }))

    if (batch.length >= BATCH_SIZE) await flush()

    if ((i + CONCURRENCY) % 200 === 0 || i + CONCURRENCY >= todo.length) {
      const pct = Math.round((Math.min(i + CONCURRENCY, todo.length) / todo.length) * 100)
      console.log(`  ${Math.min(i + CONCURRENCY, todo.length)}/${todo.length} (${pct}%) - ${done} ok, ${errors} errors`)
    }
  }

  await flush()
  console.log(`\nDone. ${done} hashes uploaded, ${errors} errors.`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})

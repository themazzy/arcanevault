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

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const BATCH_SIZE = 50
const CONCURRENCY = 4
const DCT_SIZE = 32
const HASH_BANDS = 16

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

function dct2d(matrix, N) {
  const out = new Float64Array(N * N)
  for (let y = 0; y < N; y++) {
    for (let u = 0; u < N; u++) {
      let sum = 0
      for (let x = 0; x < N; x++) {
        sum += matrix[y * N + x] * Math.cos((2 * x + 1) * u * Math.PI / (2 * N))
      }
      const cu = u === 0 ? 1 / Math.sqrt(2) : 1
      out[y * N + u] = (2 / N) * cu * sum / 2
    }
  }

  const tmp = out.slice()
  for (let x = 0; x < N; x++) {
    for (let v = 0; v < N; v++) {
      let sum = 0
      for (let y = 0; y < N; y++) {
        sum += tmp[y * N + x] * Math.cos((2 * y + 1) * v * Math.PI / (2 * N))
      }
      const cv2 = v === 0 ? 1 / Math.sqrt(2) : 1
      out[v * N + x] = (2 / N) * cv2 * sum / 2
    }
  }
  return out
}

function applyCLAHE(u8, width, height, tileGridX = 4, tileGridY = 4, clipLimit = 40.0) {
  const tileW = Math.floor(width / tileGridX)
  const tileH = Math.floor(height / tileGridY)
  const tileArea = tileW * tileH
  const clip = Math.max(1, Math.floor(clipLimit * tileArea / 256))

  const luts = []
  for (let ty = 0; ty < tileGridY; ty++) {
    for (let tx = 0; tx < tileGridX; tx++) {
      const hist = new Int32Array(256)
      for (let y = ty * tileH; y < (ty + 1) * tileH; y++) {
        for (let x = tx * tileW; x < (tx + 1) * tileW; x++) {
          hist[u8[y * width + x]]++
        }
      }

      let excess = 0
      for (let i = 0; i < 256; i++) {
        if (hist[i] > clip) {
          excess += hist[i] - clip
          hist[i] = clip
        }
      }

      const add = Math.floor(excess / 256)
      let rem = excess % 256
      const step = rem > 0 ? Math.floor(256 / rem) : 256
      for (let i = 0; i < 256; i++) {
        hist[i] += add
        if (rem > 0 && i % step === 0) {
          hist[i]++
          rem--
        }
      }

      const lut = new Uint8Array(256)
      let cdf = 0
      for (let i = 0; i < 256; i++) {
        cdf += hist[i]
        lut[i] = Math.min(255, Math.round(cdf * 255.0 / tileArea))
      }
      luts.push(lut)
    }
  }

  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = u8[y * width + x]
      const gx = (x + 0.5) / tileW - 0.5
      const gy = (y + 0.5) / tileH - 0.5
      const tx0 = Math.max(0, Math.min(tileGridX - 2, Math.floor(gx)))
      const ty0 = Math.max(0, Math.min(tileGridY - 2, Math.floor(gy)))
      const ax = Math.max(0, Math.min(1, gx - tx0))
      const ay = Math.max(0, Math.min(1, gy - ty0))
      out[y * width + x] = Math.round(
        luts[ty0 * tileGridX + tx0][v] * (1 - ax) * (1 - ay) +
        luts[ty0 * tileGridX + tx0 + 1][v] * ax * (1 - ay) +
        luts[(ty0 + 1) * tileGridX + tx0][v] * (1 - ax) * ay +
        luts[(ty0 + 1) * tileGridX + tx0 + 1][v] * ax * ay
      )
    }
  }
  return out
}

async function computePHashHex(imageBuffer) {
  const { data } = await sharp(imageBuffer)
    .blur(1.0)
    .resize(DCT_SIZE, DCT_SIZE, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const equalized = applyCLAHE(data, DCT_SIZE, DCT_SIZE)
  const pixels = new Float64Array(DCT_SIZE * DCT_SIZE)
  for (let i = 0; i < pixels.length; i++) pixels[i] = equalized[i]

  const dct = dct2d(pixels, DCT_SIZE)
  const coeffs = []
  for (let y = 0; y < HASH_BANDS; y++) {
    for (let x = 0; x < HASH_BANDS; x++) {
      coeffs.push(dct[y * DCT_SIZE + x])
    }
  }

  const mean = coeffs.slice(1).reduce((a, b) => a + b, 0) / (coeffs.length - 1)
  const bits = coeffs.map(c => c > mean ? 1 : 0)

  const pack64 = (start) => {
    let value = 0n
    for (let i = 0; i < 64; i++) {
      if (bits[start + i]) value |= (1n << BigInt(i))
    }
    return value
  }

  const p1 = pack64(0)
  const p2 = pack64(64)
  const p3 = pack64(128)
  const p4 = pack64(192)
  const hex = [p1, p2, p3, p4].map(n => n.toString(16).padStart(16, '0')).join('')

  return { hex, p1, p2, p3, p4 }
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

  console.log('Fetching existing hashes from Supabase...')
  const existing = new Set()
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
        const { hex, p1, p2, p3, p4 } = await computePHashHex(scannerCropBuffer)

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

/**
 * generate-card-hashes.js
 *
 * Pre-computes 256-bit perceptual hashes for every MTG card's art_crop image
 * from Scryfall bulk data and uploads them to the Supabase `card_hashes` table.
 *
 * Setup (run once):
 *   npm install node-fetch sharp @supabase/supabase-js dotenv
 *
 * Usage:
 *   VITE_SUPABASE_URL=https://xxx.supabase.co \
 *   VITE_SUPABASE_ANON_KEY=your-key \
 *   node scripts/generate-card-hashes.js
 *
 * The script is resumable: cards already present in Supabase are skipped.
 *
 * ── Supabase SQL (run once in SQL editor) ─────────────────────────────────────
 *
 *   create table if not exists card_hashes (
 *     scryfall_id      text primary key,
 *     oracle_id        text,
 *     name             text not null,
 *     set_code         text,
 *     collector_number text,
 *     hash_part_1      bigint,
 *     hash_part_2      bigint,
 *     hash_part_3      bigint,
 *     hash_part_4      bigint,
 *     phash_hex        text,   -- 64 hex chars, used by JS client
 *     image_uri        text,
 *     art_crop_uri     text,
 *     updated_at       timestamptz default now()
 *   );
 *   create index if not exists idx_card_hashes_phash
 *     on card_hashes (phash_hex) where phash_hex is not null;
 *
 *   alter table card_hashes enable row level security;
 *   create policy "public read" on card_hashes for select using (true);
 *   create policy "service insert" on card_hashes for insert
 *     with check (true);  -- tighten with service role key in prod
 */

import 'dotenv/config'
import fetch from 'node-fetch'
import sharp from 'sharp'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY
const BATCH_SIZE   = 50     // rows per Supabase upsert
const CONCURRENCY  = 4      // parallel image downloads
const DCT_SIZE     = 32     // resize target (32×32)
const HASH_BANDS   = 16     // take top-left 16×16 DCT coefficients → 256 bits

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

// ── 2D DCT (pure JS, operates on Float64Array row-major NxN) ─────────────────
function dct2d(matrix, N) {
  const out = new Float64Array(N * N)
  // Row DCT
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
  // Column DCT on row-dct result
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

// ── Histogram equalisation (pure JS, matches cv.equalizeHist exactly) ────────
function equalizeHistogram(u8, N) {
  // Build histogram
  const hist = new Int32Array(256)
  for (let i = 0; i < N; i++) hist[u8[i]]++

  // Cumulative distribution function
  const cdf = new Int32Array(256)
  cdf[0] = hist[0]
  for (let i = 1; i < 256; i++) cdf[i] = cdf[i-1] + hist[i]

  // Find first non-zero CDF value
  let cdfMin = 0
  for (let i = 0; i < 256; i++) { if (cdf[i] > 0) { cdfMin = cdf[i]; break } }

  // Map each pixel: equalised = round((cdf[v] - cdfMin) / (N - cdfMin) * 255)
  const out = new Uint8Array(N)
  const denom = N - cdfMin
  for (let i = 0; i < N; i++) {
    out[i] = denom > 0 ? Math.round((cdf[u8[i]] - cdfMin) / denom * 255) : 0
  }
  return out
}

// ── pHash: returns 64-char hex string ────────────────────────────────────────
async function computePHashHex(imageBuffer) {
  // 1. Resize to 32×32 with Lanczos (sharp default), then grayscale with BT.709
  const { data } = await sharp(imageBuffer)
    .resize(DCT_SIZE, DCT_SIZE, { fit: 'fill' })
    .grayscale()   // sharp uses BT.709 (Rec.709) by default
    .raw()
    .toBuffer({ resolveWithObject: true })

  // 2. Histogram equalisation — normalises exposure so the same card in
  //    different lighting conditions hashes similarly (must match client)
  const equalized = equalizeHistogram(data, DCT_SIZE * DCT_SIZE)

  // 3. 2D DCT on equalised pixels
  const pixels = new Float64Array(DCT_SIZE * DCT_SIZE)
  for (let i = 0; i < pixels.length; i++) pixels[i] = equalized[i]
  const dct = dct2d(pixels, DCT_SIZE)

  // 3. Extract top-left HASH_BANDS × HASH_BANDS (256 values)
  const coeffs = []
  for (let y = 0; y < HASH_BANDS; y++) {
    for (let x = 0; x < HASH_BANDS; x++) {
      coeffs.push(dct[y * DCT_SIZE + x])
    }
  }

  // 4. Mean (skip DC at index 0)
  const mean = coeffs.slice(1).reduce((a, b) => a + b, 0) / (coeffs.length - 1)

  // 5. Bit array → 4 × BigInt64
  const bits = coeffs.map(c => c > mean ? 1 : 0)
  const pack64 = (start) => {
    let r = 0n
    for (let i = 0; i < 64; i++) {
      if (bits[start + i]) r |= (1n << BigInt(i))
    }
    return r
  }
  const p1 = pack64(0), p2 = pack64(64), p3 = pack64(128), p4 = pack64(192)
  const hex = [p1, p2, p3, p4].map(n => n.toString(16).padStart(16, '0')).join('')
  return { hex, p1, p2, p3, p4 }
}

// ── Fetch image buffer ────────────────────────────────────────────────────────
async function fetchImage(url) {
  const res = await fetch(url, { timeout: 15000 })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Downloading Scryfall default_cards bulk data…')
  const bulkRes  = await fetch('https://api.scryfall.com/bulk-data/default-cards')
  const bulkMeta = await bulkRes.json()
  const cardsRes = await fetch(bulkMeta.download_uri)
  const cards    = await cardsRes.json()
  console.log(`Loaded ${cards.length} cards from Scryfall.`)

  // Fetch existing scryfall_ids from Supabase to skip already-processed cards
  console.log('Fetching existing hashes from Supabase…')
  const existing = new Set()
  let page = 0
  while (true) {
    const { data } = await sb.from('card_hashes')
      .select('scryfall_id')
      .range(page * 1000, page * 1000 + 999)
    if (!data?.length) break
    data.forEach(r => existing.add(r.scryfall_id))
    page++
    if (data.length < 1000) break
  }
  console.log(`${existing.size} cards already in Supabase — will skip.`)

  // Filter cards that have art_crop and are not yet processed
  const todo = cards.filter(c =>
    c.image_uris?.art_crop &&
    !existing.has(c.id)
  )
  console.log(`Processing ${todo.length} new cards…`)

  let done = 0, errors = 0
  const batch = []

  const flush = async () => {
    if (!batch.length) return
    const { error } = await sb.from('card_hashes').upsert(batch, { onConflict: 'scryfall_id' })
    if (error) console.error('Upsert error:', error.message)
    batch.length = 0
  }

  // Process in chunks with limited concurrency
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const chunk = todo.slice(i, i + CONCURRENCY)
    await Promise.all(chunk.map(async (card) => {
      try {
        const buf = await fetchImage(card.image_uris.art_crop)
        const { hex, p1, p2, p3, p4 } = await computePHashHex(buf)

        // Convert BigInt to signed int64 for Supabase BIGINT columns
        const toInt64 = n => {
          const signed = BigInt.asIntN(64, n)
          return signed > BigInt(Number.MAX_SAFE_INTEGER)
            ? String(signed)   // Return as string if too large for JS number
            : Number(signed)
        }

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
          image_uri:        card.image_uris?.normal ?? null,
          art_crop_uri:     card.image_uris?.art_crop ?? null,
        })
        done++
      } catch (e) {
        errors++
        console.warn(`  ✕ ${card.name} (${card.id}): ${e.message}`)
      }
    }))

    if (batch.length >= BATCH_SIZE) await flush()

    if ((i + CONCURRENCY) % 200 === 0 || i + CONCURRENCY >= todo.length) {
      const pct = Math.round(((i + CONCURRENCY) / todo.length) * 100)
      console.log(`  ${Math.min(i + CONCURRENCY, todo.length)}/${todo.length} (${pct}%) — ${done} ok, ${errors} errors`)
    }
  }

  await flush()
  console.log(`\nDone. ${done} hashes uploaded, ${errors} errors.`)
}

main().catch(e => { console.error(e); process.exit(1) })

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createClient } from '@supabase/supabase-js'
import { streamArray } from 'stream-json/streamers/stream-array.js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const BULK_DATA_TYPE = 'all_cards'
const UPSERT_BATCH_SIZE = 500
const FETCH_BATCH_SIZE = 1000
const BULK_DOWNLOAD_PATH = path.join(process.cwd(), '.tmp', 'scryfall-all-cards.json')

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

function pickImage(card, size) {
  if (card?.image_uris?.[size]) return card.image_uris[size]
  if (card?.card_faces?.[0]?.image_uris?.[size]) return card.card_faces[0].image_uris[size]
  return null
}

function slimFaces(faces) {
  if (!Array.isArray(faces) || !faces.length) return null
  return faces.map(f => ({
    name: f.name || null,
    mana_cost: f.mana_cost || null,
    type_line: f.type_line || null,
    oracle_text: f.oracle_text || null,
    power: f.power ?? null,
    toughness: f.toughness ?? null,
    image_uris: f.image_uris ? {
      small:  f.image_uris.small  || null,
      normal: f.image_uris.normal || null,
      large:  f.image_uris.large  || null,
    } : null,
  }))
}

function buildPayload(card) {
  return {
    scryfall_id: card.id,
    name: card.name,
    set_code: card.set,
    collector_number: card.collector_number,
    oracle_id: card.oracle_id || null,
    type_line: card.type_line || null,
    mana_cost: card.mana_cost || card.card_faces?.[0]?.mana_cost || null,
    cmc: card.cmc ?? null,
    color_identity: card.color_identity || [],
    image_uri: pickImage(card, 'normal'),
    art_crop_uri: pickImage(card, 'art_crop'),
    rarity: card.rarity || null,
    set_name: card.set_name || null,
    legalities: card.legalities || {},
    artist: card.artist || null,
    oracle_text: card.oracle_text || card.card_faces?.[0]?.oracle_text || null,
    power: card.power ?? null,
    toughness: card.toughness ?? null,
    produced_mana: card.produced_mana || [],
    keywords: card.keywords || [],
    colors: card.colors || [],
    image_uri_small: pickImage(card, 'small'),
    image_uri_large: pickImage(card, 'large'),
    card_faces: slimFaces(card.card_faces),
  }
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'DeckLoomPrintsBackfill/1.0' },
  })
  if (!res.ok) throw new Error(`Request failed (${res.status}) for ${url}`)
  return res.json()
}

async function getBulkDownloadUrl() {
  const manifest = await fetchJson('https://api.scryfall.com/bulk-data')
  const file = (manifest.data || []).find(item => item.type === BULK_DATA_TYPE)
  if (!file?.download_uri) throw new Error(`Could not find Scryfall bulk data type "${BULK_DATA_TYPE}".`)
  return file.download_uri
}

async function downloadBulkFile(url, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json, application/octet-stream;q=0.9, */*;q=0.8',
      'User-Agent': 'DeckLoomPrintsBackfill/1.0',
    },
  })
  if (!res.ok || !res.body) throw new Error(`Bulk download failed (${res.status})`)
  const fileStream = fs.createWriteStream(destination)
  const bodyStream = Readable.fromWeb(res.body)
  await new Promise((resolve, reject) => {
    bodyStream.pipe(fileStream)
    bodyStream.on('error', reject)
    fileStream.on('finish', resolve)
    fileStream.on('error', reject)
  })
}

async function loadExistingScryfallIds() {
  const ids = new Set()
  let from = 0
  while (true) {
    const { data, error } = await sb
      .from('card_prints')
      .select('scryfall_id')
      .not('scryfall_id', 'is', null)
      .order('scryfall_id', { ascending: true })
      .range(from, from + FETCH_BATCH_SIZE - 1)
    if (error) throw error
    if (!data?.length) break
    for (const row of data) ids.add(row.scryfall_id)
    if (data.length < FETCH_BATCH_SIZE) break
    from += FETCH_BATCH_SIZE
  }
  return ids
}

async function flushBatch(batch) {
  if (!batch.length) return
  const { error } = await sb
    .from('card_prints')
    .upsert(batch, { onConflict: 'scryfall_id', ignoreDuplicates: false })
  if (error) throw error
}

async function processBulkFile(existingIds) {
  let processed = 0
  let skipped = 0
  let pending = []
  const seen = new Set()

  const pipeline = fs.createReadStream(BULK_DOWNLOAD_PATH).pipe(streamArray.withParserAsStream())
  for await (const { value: card } of pipeline) {
    if (!card?.id || !existingIds.has(card.id)) { skipped++; continue }
    if (seen.has(card.id)) continue
    seen.add(card.id)
    pending.push(buildPayload(card))
    if (pending.length >= UPSERT_BATCH_SIZE) {
      await flushBatch(pending)
      processed += pending.length
      pending = []
      if (processed % 5000 === 0) {
        console.log(`[Prints Backfill] Upserted ${processed.toLocaleString()} rows so far.`)
      }
    }
  }
  if (pending.length) {
    await flushBatch(pending)
    processed += pending.length
  }
  return { processed, skipped }
}

async function main() {
  console.log('[Prints Backfill] Loading existing card_prints scryfall_ids…')
  const existing = await loadExistingScryfallIds()
  console.log(`[Prints Backfill] ${existing.size.toLocaleString()} rows currently in card_prints.`)

  try {
    console.log('[Prints Backfill] Fetching Scryfall bulk manifest…')
    const url = await getBulkDownloadUrl()
    console.log('[Prints Backfill] Downloading bulk file…')
    await downloadBulkFile(url, BULK_DOWNLOAD_PATH)
    console.log('[Prints Backfill] Streaming and upserting…')
    const { processed, skipped } = await processBulkFile(existing)
    console.log(`[Prints Backfill] Done. Updated ${processed.toLocaleString()} rows, skipped ${skipped.toLocaleString()} (not in collection).`)
  } finally {
    try {
      fs.rmSync(BULK_DOWNLOAD_PATH, { force: true })
      fs.rmSync(path.dirname(BULK_DOWNLOAD_PATH), { recursive: true, force: true })
    } catch {}
  }
}

main().catch(err => {
  console.error('[Prints Backfill] Failed:', err.message)
  process.exit(1)
})

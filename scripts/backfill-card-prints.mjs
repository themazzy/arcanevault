import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { downloadBulkData, streamBulkCardsFromFile } from './lib/scryfall-bulk.mjs'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const BULK_DATA_TYPE = 'all_cards'
const USER_AGENT = 'DeckLoomPrintsBackfill/1.0'
const UPSERT_BATCH_SIZE = 100
const FETCH_BATCH_SIZE = 1000
const BULK_DOWNLOAD_DIR = path.join(process.cwd(), '.tmp')

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
    lang: card.lang || null,
    oracle_id: card.oracle_id || null,
    type_line: card.type_line || null,
    mana_cost: card.mana_cost || card.card_faces?.[0]?.mana_cost || null,
    cmc: card.cmc ?? null,
    color_identity: card.color_identity || [],
    image_uri: pickImage(card, 'normal'),
    art_crop_uri: pickImage(card, 'art_crop'),
    rarity: card.rarity || null,
    set_name: card.set_name || null,
    artist: card.artist || null,
    power: card.power ?? null,
    toughness: card.toughness ?? null,
    produced_mana: card.produced_mana || [],
    keywords: card.keywords || [],
    colors: card.colors || [],
    card_faces: slimFaces(card.card_faces),
  }
}

// Only target rows that still need metadata or language backfilling. This
// avoids rewriting already-populated rows, which would create dead tuples and
// inflate the table until VACUUM FULL.
async function loadExistingScryfallIds() {
  const ids = new Set()
  let from = 0
  while (true) {
    const { data, error } = await sb
      .from('card_prints')
      .select('scryfall_id')
      .not('scryfall_id', 'is', null)
      .or('rarity.is.null,lang.is.null')
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

async function processBulkFile(bulk, existingIds) {
  let processed = 0
  let skipped = 0
  let pending = []
  const seen = new Set()

  for await (const card of streamBulkCardsFromFile(bulk.path, bulk.format)) {
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

  let bulk = null
  try {
    console.log('[Prints Backfill] Fetching Scryfall bulk manifest…')
    console.log('[Prints Backfill] Downloading bulk file…')
    bulk = await downloadBulkData(BULK_DATA_TYPE, { dir: BULK_DOWNLOAD_DIR, userAgent: USER_AGENT })
    console.log('[Prints Backfill] Streaming and upserting…')
    const { processed, skipped } = await processBulkFile(bulk, existing)
    console.log(`[Prints Backfill] Done. Updated ${processed.toLocaleString()} rows, skipped ${skipped.toLocaleString()} (not in collection).`)
  } finally {
    try {
      if (bulk?.path) fs.rmSync(bulk.path, { force: true })
      fs.rmSync(BULK_DOWNLOAD_DIR, { recursive: true, force: true })
    } catch {}
  }
}

main().catch(err => {
  console.error('[Prints Backfill] Failed:', err.message)
  process.exit(1)
})

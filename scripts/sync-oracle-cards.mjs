import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { streamArray } from 'stream-json/streamers/stream-array.js'

// Refreshes shared oracle-level recommendation metadata from Scryfall's bulk
// export. This is an administrative sync, not a runtime card-API dependency.

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const BULK_DATA_TYPE = 'oracle_cards'
const UPSERT_BATCH = 500
const DOWNLOAD_PATH = path.join(process.cwd(), '.tmp', 'scryfall-oracle-cards.json')
const SYNCED_AT = new Date().toISOString()
const ORACLE_TEXT_CAP = 600

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'DeckLoomOracleSync/1.0' },
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

async function downloadBulkFile(url) {
  fs.mkdirSync(path.dirname(DOWNLOAD_PATH), { recursive: true })
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json, application/octet-stream;q=0.9, */*;q=0.8',
      'User-Agent': 'DeckLoomOracleSync/1.0',
    },
  })
  if (!res.ok || !res.body) throw new Error(`Bulk download failed (${res.status})`)

  const output = fs.createWriteStream(DOWNLOAD_PATH)
  const input = Readable.fromWeb(res.body)
  await new Promise((resolve, reject) => {
    input.pipe(output)
    input.on('error', reject)
    output.on('finish', resolve)
    output.on('error', reject)
  })
}

function cardImage(card, size) {
  return card?.image_uris?.[size] || card?.card_faces?.[0]?.image_uris?.[size] || null
}

function oracleTextOf(card) {
  if (card?.oracle_text) return card.oracle_text.slice(0, ORACLE_TEXT_CAP)
  const faces = Array.isArray(card?.card_faces)
    ? card.card_faces.map(face => face.oracle_text).filter(Boolean)
    : []
  return faces.length ? faces.join('\n//\n').slice(0, ORACLE_TEXT_CAP) : ''
}

function slimCardFaces(faces) {
  if (!Array.isArray(faces) || !faces.length) return null
  return faces.map(face => ({
    name: face.name || null,
    mana_cost: face.mana_cost || null,
    type_line: face.type_line || null,
    oracle_text: face.oracle_text || null,
    power: face.power ?? null,
    toughness: face.toughness ?? null,
    image_uris: face.image_uris ? {
      small: face.image_uris.small || null,
      normal: face.image_uris.normal || null,
      large: face.image_uris.large || null,
      art_crop: face.image_uris.art_crop || null,
    } : null,
  }))
}

export function oracleCardRow(card) {
  if (!card?.oracle_id || !card?.name) return null
  return {
    oracle_id: card.oracle_id,
    name: card.name,
    legalities: card.legalities && typeof card.legalities === 'object' ? card.legalities : {},
    scryfall_id: card.id || null,
    set_code: card.set || null,
    collector_number: card.collector_number || null,
    type_line: card.type_line || null,
    mana_cost: card.mana_cost || card.card_faces?.[0]?.mana_cost || null,
    cmc: card.cmc ?? null,
    color_identity: card.color_identity || [],
    image_uri: cardImage(card, 'normal'),
    art_crop_uri: cardImage(card, 'art_crop'),
    oracle_text: oracleTextOf(card),
    rarity: card.rarity || null,
    set_name: card.set_name || null,
    artist: card.artist || null,
    power: card.power ?? null,
    toughness: card.toughness ?? null,
    produced_mana: card.produced_mana || [],
    keywords: card.keywords || [],
    colors: card.colors || [],
    card_faces: slimCardFaces(card.card_faces),
    face_names: [...new Set((card.card_faces || []).map(face => face?.name).filter(Boolean))],
    source_updated_at: card.updated_at || null,
    synced_at: SYNCED_AT,
  }
}

async function flush(rows) {
  if (!rows.length) return
  const { error } = await sb
    .from('oracle_cards')
    .upsert(rows, { onConflict: 'oracle_id', ignoreDuplicates: false })
  if (error) throw error
}

async function processBulkFile() {
  let scanned = 0
  let upserted = 0
  let pending = []
  const seen = new Set()
  const pipeline = fs.createReadStream(DOWNLOAD_PATH).pipe(streamArray.withParserAsStream())

  for await (const { value: card } of pipeline) {
    scanned++
    const row = oracleCardRow(card)
    if (!row || seen.has(row.oracle_id)) continue
    seen.add(row.oracle_id)
    pending.push(row)

    if (pending.length >= UPSERT_BATCH) {
      await flush(pending)
      upserted += pending.length
      pending = []
      if (upserted % 5000 === 0) {
        console.log(`[Oracle Sync] upserted ${upserted.toLocaleString()} oracle cards.`)
      }
    }
  }

  if (pending.length) {
    await flush(pending)
    upserted += pending.length
  }
  return { scanned, upserted }
}

async function main() {
  try {
    console.log('[Oracle Sync] Fetching Scryfall bulk manifest…')
    const url = await getBulkDownloadUrl()
    console.log('[Oracle Sync] Downloading oracle_cards bulk file…')
    await downloadBulkFile(url)
    console.log('[Oracle Sync] Streaming rows into Supabase…')
    const { scanned, upserted } = await processBulkFile()
    console.log(`[Oracle Sync] Done. Scanned ${scanned.toLocaleString()}, upserted ${upserted.toLocaleString()}.`)
  } finally {
    try { fs.rmSync(DOWNLOAD_PATH, { force: true }) } catch {}
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(err => {
    console.error('[Oracle Sync] Failed:', err.message)
    process.exitCode = 1
  })
}

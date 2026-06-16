import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createClient } from '@supabase/supabase-js'
import { streamArray } from 'stream-json/streamers/stream-array.js'

// One-off (and re-runnable) seed for card_prints.oracle_text.
//
// Oracle text is identical across every printing of a card, so we pull from
// Scryfall's small `oracle_cards` bulk (~37k entries, one per oracle_id) rather
// than the multi-GB all_cards file, and fan it out to all matching printings by
// oracle_id via the apply_card_oracle_text RPC. The RPC only fills rows still
// NULL, so this is idempotent and cheap to re-run.

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY // scripts/.env stores a service_role token here
const BULK_DATA_TYPE = 'oracle_cards'
const ORACLE_TEXT_CAP = 600 // matches the client cap in scryfall.js / cardPrints.js
const RPC_CHUNK = 1000
const BULK_DOWNLOAD_PATH = path.join(process.cwd(), '.tmp', 'scryfall-oracle-cards.json')

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL and/or a service-role key (SUPABASE_SERVICE_ROLE_KEY / VITE_SUPABASE_ANON_KEY).')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// Full rules text for classification. Prefer the card's own oracle_text; for
// double-faced cards with no top-level text, join the faces. Vanilla cards
// resolve to '' (stored non-null so the RPC's NULL canary skips them next run).
function oracleTextOf(card) {
  if (card?.oracle_text) return card.oracle_text.slice(0, ORACLE_TEXT_CAP)
  const faces = Array.isArray(card?.card_faces)
    ? card.card_faces.map(f => f.oracle_text).filter(Boolean)
    : []
  if (faces.length) return faces.join('\n//\n').slice(0, ORACLE_TEXT_CAP)
  return ''
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'DeckLoomOracleBackfill/1.0' },
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
      'User-Agent': 'DeckLoomOracleBackfill/1.0',
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

async function flushChunk(rows) {
  if (!rows.length) return 0
  const { data, error } = await sb.rpc('apply_card_oracle_text', { payload: rows })
  if (error) throw error
  return typeof data === 'number' ? data : 0
}

async function processBulkFile() {
  let updated = 0
  let scanned = 0
  let pending = []
  const seen = new Set() // de-dupe oracle_ids (oracle_cards is already unique, but be safe)

  const pipeline = fs.createReadStream(BULK_DOWNLOAD_PATH).pipe(streamArray.withParserAsStream())
  for await (const { value: card } of pipeline) {
    scanned++
    const oid = card?.oracle_id
    if (!oid || seen.has(oid)) continue
    seen.add(oid)
    pending.push({ oid, txt: oracleTextOf(card) })
    if (pending.length >= RPC_CHUNK) {
      updated += await flushChunk(pending)
      pending = []
      if (seen.size % 5000 === 0) {
        console.log(`[Oracle Backfill] processed ${seen.size.toLocaleString()} oracle cards, ${updated.toLocaleString()} rows filled.`)
      }
    }
  }
  if (pending.length) updated += await flushChunk(pending)
  return { updated, scanned, oracleCards: seen.size }
}

async function main() {
  try {
    console.log('[Oracle Backfill] Fetching Scryfall bulk manifest…')
    const url = await getBulkDownloadUrl()
    console.log('[Oracle Backfill] Downloading oracle_cards bulk…')
    await downloadBulkFile(url, BULK_DOWNLOAD_PATH)
    console.log('[Oracle Backfill] Streaming and applying via RPC…')
    const { updated, oracleCards } = await processBulkFile()
    console.log(`[Oracle Backfill] Done. ${oracleCards.toLocaleString()} oracle cards seen, ${updated.toLocaleString()} card_prints rows filled.`)
  } finally {
    try {
      fs.rmSync(BULK_DOWNLOAD_PATH, { force: true })
      fs.rmSync(path.dirname(BULK_DOWNLOAD_PATH), { recursive: true, force: true })
    } catch {}
  }
}

main().catch(err => {
  console.error('[Oracle Backfill] Failed:', err.message)
  process.exit(1)
})

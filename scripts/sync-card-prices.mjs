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
const DELETE_BATCH_SIZE = 500
const BULK_DOWNLOAD_PATH = path.join(process.cwd(), '.tmp', 'scryfall-all-cards.json')
const PRICE_COLUMNS = `
  scryfall_id,
  set_code,
  collector_number,
  snapshot_date,
  price_regular_eur,
  price_foil_eur,
  price_regular_usd,
  price_foil_usd,
  updated_at
`

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

function isoDateUtc(daysOffset = 0) {
  const date = new Date()
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() + daysOffset)
  return date.toISOString().slice(0, 10)
}

function normalizePrice(value) {
  if (value == null || value === '') return null
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return null
  return Number(parsed.toFixed(2))
}

function hasSupportedPrice(card) {
  return [
    card?.prices?.eur,
    card?.prices?.eur_foil,
    card?.prices?.usd,
    card?.prices?.usd_foil,
  ].some(value => normalizePrice(value) != null)
}

function shouldKeepCard(card) {
  if (!card?.id || !card?.set || !card?.collector_number) return false
  if (card.object !== 'card') return false
  if (card.digital) return false
  if (Array.isArray(card.games) && !card.games.includes('paper')) return false
  if (!hasSupportedPrice(card)) return false

  const excludedLayouts = new Set([
    'token',
    'double_faced_token',
    'emblem',
    'art_series',
    'vanguard',
    'scheme',
    'planar',
  ])
  if (excludedLayouts.has(card.layout)) return false

  const excludedSetTypes = new Set([
    'token',
    'memorabilia',
    'minigame',
    'treasure_chest',
    'alchemy',
  ])
  if (excludedSetTypes.has(card.set_type)) return false

  return true
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'ArcaneVaultPriceSync/1.0',
    },
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
      'User-Agent': 'ArcaneVaultPriceSync/1.0',
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

async function processBulkFile(snapshotDate) {
  let skipped = 0
  let processed = 0
  let pendingRows = []

  const pipeline = fs
    .createReadStream(BULK_DOWNLOAD_PATH)
    .pipe(streamArray.withParserAsStream())

  for await (const { value: card } of pipeline) {
    if (!shouldKeepCard(card)) {
      skipped++
      continue
    }

    pendingRows.push({
      scryfall_id: card.id,
      set_code: card.set,
      collector_number: card.collector_number,
      snapshot_date: snapshotDate,
      price_regular_eur: normalizePrice(card.prices?.eur),
      price_foil_eur: normalizePrice(card.prices?.eur_foil),
      price_regular_usd: normalizePrice(card.prices?.usd),
      price_foil_usd: normalizePrice(card.prices?.usd_foil),
      updated_at: new Date().toISOString(),
    })

    if (pendingRows.length >= UPSERT_BATCH_SIZE) {
      await upsertRows(pendingRows)
      processed += pendingRows.length
      pendingRows = []
      if (processed % 5000 === 0) {
        console.log(`[Price Sync] Upserted ${processed.toLocaleString()} rows so far.`)
      }
    }
  }

  if (pendingRows.length) {
    await upsertRows(pendingRows)
    processed += pendingRows.length
  }

  return { processed, skipped }
}

async function upsertRows(rows) {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE)
    const { error } = await sb
      .from('card_prices_stage')
      .upsert(batch, { onConflict: 'scryfall_id,snapshot_date' })
    if (error) throw error
  }
}

async function upsertLiveRows(rows) {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE)
    const { error } = await sb
      .from('card_prices')
      .upsert(batch, { onConflict: 'scryfall_id,snapshot_date' })
    if (error) throw error
  }
}

async function clearRows(table, label, applyFilter) {
  let cleared = 0

  while (true) {
    const selectQuery = applyFilter(
      sb
        .from(table)
        .select('scryfall_id')
        .order('scryfall_id', { ascending: true })
        .limit(DELETE_BATCH_SIZE)
    )
    const { data, error: selectError } = await selectQuery
    if (selectError) throw selectError
    if (!data?.length) break

    const ids = data.map(row => row.scryfall_id)
    const deleteQuery = applyFilter(sb.from(table).delete().in('scryfall_id', ids))
    const { error: deleteError } = await deleteQuery
    if (deleteError) throw deleteError

    cleared += data.length
    if (cleared % 5000 === 0) {
      console.log(`[Price Sync] Cleared ${cleared.toLocaleString()} ${label} rows so far.`)
    }
  }

  console.log(`[Price Sync] Cleared ${cleared.toLocaleString()} ${label} rows.`)
}

async function clearStageRows(label, applyFilter) {
  await clearRows('card_prices_stage', `${label} staging`, applyFilter)
}

async function clearStageRowsBestEffort(label, applyFilter) {
  try {
    await clearStageRows(label, applyFilter)
  } catch (error) {
    console.warn(`[Price Sync] Could not clear ${label} staging rows:`, error.message)
  }
}

async function publishStagedRows(snapshotDate, retentionCutoff) {
  await clearRows(
    'card_prices',
    `rows for ${snapshotDate} live`,
    query => query.eq('snapshot_date', snapshotDate)
  )

  let published = 0
  let offset = 0

  while (true) {
    const { data, error } = await sb
      .from('card_prices_stage')
      .select(PRICE_COLUMNS)
      .eq('snapshot_date', snapshotDate)
      .order('scryfall_id', { ascending: true })
      .range(offset, offset + UPSERT_BATCH_SIZE - 1)

    if (error) throw error
    if (!data?.length) break

    await upsertLiveRows(data)
    published += data.length
    offset += data.length

    if (published % 5000 === 0) {
      console.log(`[Price Sync] Published ${published.toLocaleString()} rows so far.`)
    }
  }

  await clearRows(
    'card_prices',
    `stale live rows before ${retentionCutoff}`,
    query => query.lt('snapshot_date', retentionCutoff)
  )

  console.log(`[Price Sync] Published ${published.toLocaleString()} staged rows for ${snapshotDate}.`)
}

async function main() {
  const snapshotDate = isoDateUtc(0)
  const retentionCutoff = isoDateUtc(-1)

  try {
    await clearStageRows(`stale rows before ${snapshotDate}`, query => query.lt('snapshot_date', snapshotDate))
    await clearStageRows(`rows for ${snapshotDate}`, query => query.eq('snapshot_date', snapshotDate))

    console.log(`[Price Sync] Fetching Scryfall ${BULK_DATA_TYPE} manifest...`)
    const downloadUrl = await getBulkDownloadUrl()

    console.log('[Price Sync] Downloading bulk card data to disk...')
    await downloadBulkFile(downloadUrl, BULK_DOWNLOAD_PATH)

    console.log('[Price Sync] Streaming bulk card data...')
    const { processed, skipped } = await processBulkFile(snapshotDate)
    console.log(`[Price Sync] Finished staging ${processed.toLocaleString()} rows (${skipped.toLocaleString()} skipped).`)

    console.log(`[Price Sync] Publishing staged rows for ${snapshotDate}...`)
    await publishStagedRows(snapshotDate, retentionCutoff)
  } finally {
    await clearStageRowsBestEffort(`rows for ${snapshotDate}`, query => query.eq('snapshot_date', snapshotDate))
    try {
      fs.rmSync(BULK_DOWNLOAD_PATH, { force: true })
      fs.rmSync(path.dirname(BULK_DOWNLOAD_PATH), { recursive: true, force: true })
    } catch {}
  }

  console.log('[Price Sync] Complete.')
}

main().catch((error) => {
  console.error('[Price Sync] Failed:', error.message)
  process.exit(1)
})

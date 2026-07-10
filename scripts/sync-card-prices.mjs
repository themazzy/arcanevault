import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createClient } from '@supabase/supabase-js'
import { streamArray } from 'stream-json/streamers/stream-array.js'
import { shouldInsertPrint, buildPrintRow } from './lib/print-sync-core.mjs'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const BULK_DATA_TYPE = 'all_cards'
const UPSERT_BATCH_SIZE = 500
const DELETE_BATCH_SIZE = 500
const FETCH_BATCH_SIZE = 1000
const BULK_DOWNLOAD_PATH = path.join(process.cwd(), '.tmp', 'scryfall-all-cards.json')
// Rows already in card_prints but missing the search-metadata columns
// (released_at etc.) get re-upserted from the same bulk stream, capped per run
// so the one-time backfill of ~119k legacy rows is spread over several days —
// a single full-table update would double the heap with dead tuples and risk
// the 500 MB free-tier cap. Steady state is ~0 backfills per run.
const PRINT_BACKFILL_LIMIT = Number(process.env.PRINT_BACKFILL_LIMIT ?? 20000)
// card_prints upserts write every index including the trigram GIN, so batches
// of 500 can exceed the statement timeout (bit us on the first backfill run —
// the standalone backfill script uses 100 for the same reason).
const PRINT_UPSERT_BATCH_SIZE = 100

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
      'User-Agent': 'DeckLoomPriceSync/1.0',
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
      'User-Agent': 'DeckLoomPriceSync/1.0',
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

// ── card_prints sync (same bulk stream, separate table) ─────────────────────
// The daily bulk pass doubles as the card_prints freshness pipeline: prints
// missing from the table are inserted (new sets become searchable the day
// Scryfall publishes them) and legacy rows missing search metadata are
// re-upserted, capped by PRINT_BACKFILL_LIMIT. Failures here must never break
// the price sync — the whole feature degrades to the client's Scryfall
// fallback.

async function loadCardPrintState() {
  const existingIds = new Set()
  const needsMetadataIds = new Set()
  let from = 0
  while (true) {
    const { data, error } = await sb
      .from('card_prints')
      .select('scryfall_id,released_at')
      .not('scryfall_id', 'is', null)
      .order('scryfall_id', { ascending: true })
      .range(from, from + FETCH_BATCH_SIZE - 1)
    if (error) throw error
    if (!data?.length) break
    for (const row of data) {
      existingIds.add(row.scryfall_id)
      if (row.released_at == null) needsMetadataIds.add(row.scryfall_id)
    }
    if (data.length < FETCH_BATCH_SIZE) break
    from += FETCH_BATCH_SIZE
  }
  return { existingIds, needsMetadataIds }
}

function createPrintSync(printState) {
  const state = {
    pending: [],
    inserted: 0,
    backfilled: 0,
    failed: false,
  }

  async function flush() {
    if (!state.pending.length) return
    const rows = state.pending
    state.pending = []
    for (let i = 0; i < rows.length; i += PRINT_UPSERT_BATCH_SIZE) {
      const { error } = await sb
        .from('card_prints')
        .upsert(rows.slice(i, i + PRINT_UPSERT_BATCH_SIZE), { onConflict: 'scryfall_id', ignoreDuplicates: false })
      if (error) throw error
    }
  }

  async function offer(card) {
    if (state.failed || !card?.id || card.object !== 'card') return
    try {
      if (!printState.existingIds.has(card.id)) {
        if (!shouldInsertPrint(card)) return
        printState.existingIds.add(card.id)
        state.pending.push(buildPrintRow(card))
        state.inserted++
      } else if (printState.needsMetadataIds.has(card.id) && state.backfilled < PRINT_BACKFILL_LIMIT) {
        printState.needsMetadataIds.delete(card.id)
        state.pending.push(buildPrintRow(card))
        state.backfilled++
      } else {
        return
      }
      if (state.pending.length >= UPSERT_BATCH_SIZE) await flush()
    } catch (error) {
      state.failed = true
      state.pending = []
      console.error('[Price Sync] card_prints sync failed (prices continue):', error.message)
    }
  }

  async function finish() {
    if (state.failed) return state
    try {
      await flush()
    } catch (error) {
      state.failed = true
      console.error('[Price Sync] card_prints final flush failed:', error.message)
    }
    return state
  }

  return { offer, finish }
}

async function processBulkFile(snapshotDate, printSync) {
  let skipped = 0
  let processed = 0
  let duplicateRows = 0
  let pendingRows = []

  const pipeline = fs
    .createReadStream(BULK_DOWNLOAD_PATH)
    .pipe(streamArray.withParserAsStream())

  for await (const { value: card } of pipeline) {
    if (printSync) await printSync.offer(card)

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
      const result = await upsertRows(pendingRows)
      processed += result.written
      duplicateRows += result.duplicates
      pendingRows = []
      if (processed % 5000 === 0) {
        console.log(`[Price Sync] Upserted ${processed.toLocaleString()} rows so far.`)
      }
    }
  }

  if (pendingRows.length) {
    const result = await upsertRows(pendingRows)
    processed += result.written
    duplicateRows += result.duplicates
  }

  return { processed, skipped, duplicateRows }
}

async function upsertRows(rows) {
  let written = 0
  let duplicates = 0

  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const { batch, duplicateCount } = dedupePriceRows(rows.slice(i, i + UPSERT_BATCH_SIZE))
    const { error } = await sb
      .from('card_prices')
      .upsert(batch, { onConflict: 'scryfall_id,snapshot_date' })
    if (error) throw error
    written += batch.length
    duplicates += duplicateCount
  }

  return { written, duplicates }
}

function dedupePriceRows(rows) {
  const byConflictKey = new Map()

  for (const row of rows) {
    byConflictKey.set(`${row.scryfall_id}:${row.snapshot_date}`, row)
  }

  return {
    batch: [...byConflictKey.values()],
    duplicateCount: rows.length - byConflictKey.size,
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

async function pruneLiveRows(snapshotDate, retentionCutoff) {
  await clearRows(
    'card_prices',
    `stale live rows before ${retentionCutoff}`,
    query => query.lt('snapshot_date', retentionCutoff)
  )

  console.log(`[Price Sync] Live rows for ${snapshotDate} are up to date.`)
}

async function main() {
  const snapshotDate = isoDateUtc(0)
  const retentionCutoff = isoDateUtc(-1)

  try {
    await clearRows(
      'card_prices',
      `rows for ${snapshotDate} live`,
      query => query.eq('snapshot_date', snapshotDate)
    )

    console.log(`[Price Sync] Fetching Scryfall ${BULK_DATA_TYPE} manifest...`)
    const downloadUrl = await getBulkDownloadUrl()

    console.log('[Price Sync] Downloading bulk card data to disk...')
    await downloadBulkFile(downloadUrl, BULK_DOWNLOAD_PATH)

    let printSync = null
    try {
      console.log('[Price Sync] Loading card_prints state...')
      const printState = await loadCardPrintState()
      console.log(`[Price Sync] card_prints: ${printState.existingIds.size.toLocaleString()} known prints, ${printState.needsMetadataIds.size.toLocaleString()} awaiting metadata backfill.`)
      printSync = createPrintSync(printState)
    } catch (error) {
      console.error('[Price Sync] Could not load card_prints state — skipping print sync:', error.message)
      process.exitCode = 1
    }

    console.log('[Price Sync] Streaming bulk card data...')
    const { processed, skipped, duplicateRows } = await processBulkFile(snapshotDate, printSync)
    console.log(`[Price Sync] Finished writing ${processed.toLocaleString()} live rows (${skipped.toLocaleString()} skipped).`)
    if (duplicateRows) {
      console.log(`[Price Sync] Collapsed ${duplicateRows.toLocaleString()} duplicate rows while staging.`)
    }

    if (printSync) {
      const printResult = await printSync.finish()
      console.log(`[Price Sync] card_prints: inserted ${printResult.inserted.toLocaleString()} new prints, backfilled ${printResult.backfilled.toLocaleString()} rows.`)
      if (printResult.failed) process.exitCode = 1
    }

    await pruneLiveRows(snapshotDate, retentionCutoff)
  } finally {
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

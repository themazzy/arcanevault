import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const BULK_DATA_TYPE = 'all_cards'
const UPSERT_BATCH_SIZE = 500

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

async function upsertRows(rows) {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE)
    const { error } = await sb
      .from('card_prices')
      .upsert(batch, { onConflict: 'scryfall_id,snapshot_date' })
    if (error) throw error
  }
}

async function main() {
  const snapshotDate = isoDateUtc(0)
  const retentionCutoff = isoDateUtc(-1)

  console.log(`[Price Sync] Fetching Scryfall ${BULK_DATA_TYPE} manifest...`)
  const downloadUrl = await getBulkDownloadUrl()

  console.log('[Price Sync] Downloading bulk card data...')
  const cards = await fetchJson(downloadUrl)
  console.log(`[Price Sync] Received ${cards.length.toLocaleString()} bulk card rows.`)

  const rows = []
  let skipped = 0

  for (const card of cards) {
    if (!card?.id || !card?.set || !card?.collector_number) {
      skipped++
      continue
    }
    if (Array.isArray(card.games) && !card.games.includes('paper')) {
      skipped++
      continue
    }

    rows.push({
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
  }

  console.log(`[Price Sync] Upserting ${rows.length.toLocaleString()} card price rows (${skipped.toLocaleString()} skipped).`)
  await upsertRows(rows)

  console.log(`[Price Sync] Deleting rows older than ${retentionCutoff}.`)
  const { error: deleteError } = await sb
    .from('card_prices')
    .delete()
    .lt('snapshot_date', retentionCutoff)
  if (deleteError) throw deleteError

  console.log('[Price Sync] Complete.')
}

main().catch((error) => {
  console.error('[Price Sync] Failed:', error.message)
  process.exit(1)
})

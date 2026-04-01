import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const UPSERT_BATCH_SIZE = 500
const SCRYFALL_PAGE_DELAY_MS = 150
const SCRYFALL_QUERY = 'game:paper'
const SCRYFALL_ORDER = 'set'

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

async function wait(ms) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function* iterateScryfallCards() {
  let nextUrl = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(SCRYFALL_QUERY)}&unique=prints&order=${encodeURIComponent(SCRYFALL_ORDER)}`
  let page = 0

  while (nextUrl) {
    page += 1
    const json = await fetchJson(nextUrl)
    const cards = json.data || []
    console.log(`[Price Sync] Scryfall page ${page}: ${cards.length.toLocaleString()} cards`)
    yield cards
    nextUrl = json.has_more ? json.next_page : null
    if (nextUrl) await wait(SCRYFALL_PAGE_DELAY_MS)
  }
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
  const seen = new Set()
  let skipped = 0
  let processed = 0

  console.log('[Price Sync] Fetching paginated Scryfall printings...')
  for await (const cards of iterateScryfallCards()) {
    const rows = []
    for (const card of cards) {
      if (!card?.id || !card?.set || !card?.collector_number) {
        skipped++
        continue
      }
      if (seen.has(card.id)) continue
      seen.add(card.id)
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

    if (rows.length) {
      await upsertRows(rows)
      processed += rows.length
      console.log(`[Price Sync] Upserted ${processed.toLocaleString()} rows so far.`)
    }
  }

  console.log(`[Price Sync] Finished upserting ${processed.toLocaleString()} rows (${skipped.toLocaleString()} skipped).`)

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

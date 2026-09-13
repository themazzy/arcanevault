import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { streamBulkEntries } from './lib/mtgjson-stream.mjs'
import { upsertWithRetry } from './lib/sync-retry.mjs'
import {
  HISTORY_DAYS,
  latestDateIn,
  priceHistoryRow,
  windowStart,
} from './lib/price-history-core.mjs'

// Fills card_price_history from MTGJSON's rolling ~90-day AllPrices export.
//
// Why MTGJSON and not our own accumulation: Scryfall publishes only today's
// price, so building 90 days ourselves would mean shipping the feature and
// showing an empty chart for three months. MTGJSON hands over the whole window
// on the first run. Its paper.cardmarket.retail numbers were verified identical
// to card_prices.price_regular_eur to the cent (both are Cardmarket trend), so
// the chart ends on the number the rest of the app already shows.
//
// Why bulk and not per-card: there is no per-card endpoint. The only artifact
// is a 143 MB gzip, which is also why both files are STREAMED — AllPrices
// uncompressed exceeds Node's maximum string length and cannot be JSON.parse'd.

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const USER_AGENT = 'DeckLoomPriceHistorySync/1.0'
const PRICES_URL = 'https://mtgjson.com/api/v5/AllPrices.json.gz'
const IDENTIFIERS_URL = 'https://mtgjson.com/api/v5/AllIdentifiers.json.gz'
// card_price_history rows are small (two ~90-element real[] plus a key), but
// the table is 90k rows, so batches stay modest to keep each statement well
// inside the timeout. Same reasoning as the oracle sync's 100.
const UPSERT_BATCH = 250
const LOG_EVERY = 20000

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/**
 * MTGJSON keys everything by its own uuid, so a uuid -> scryfallId map is
 * needed before the prices mean anything.
 *
 * Streamed rather than stored: keeping mtgjson_uuid on card_prints would cost
 * ~4.4 MB of a database that is the scarce resource here, while runner
 * bandwidth is free. It also cannot drift.
 */
async function loadScryfallIdMap() {
  const map = new Map()
  let scanned = 0
  for await (const [uuid, card] of streamBulkEntries(IDENTIFIERS_URL, { userAgent: USER_AGENT })) {
    scanned++
    const sid = card?.identifiers?.scryfallId
    if (sid) map.set(uuid, sid)
  }
  console.log(`[Price History] mapped ${map.size.toLocaleString()} of ${scanned.toLocaleString()} printings to Scryfall ids.`)
  return map
}

async function flush(rows) {
  if (!rows.length) return
  await upsertWithRetry(
    rows,
    batch => sb.from('card_price_history').upsert(batch, { onConflict: 'scryfall_id' }),
    {
      onRetry: ({ reason, size, next, attempt, delay, error }) => {
        const detail = reason === 'split' ? `splitting into ${next}` : `retry ${attempt} in ${delay}ms`
        console.warn(`[Price History] write of ${size} rows failed (${error?.message}) — ${detail}.`)
      },
    },
  )
}

async function main() {
  const started = Date.now()
  console.log('[Price History] Loading MTGJSON identifier map…')
  const idMap = await loadScryfallIdMap()

  // The window origin has to be the same for every row, so the client needs one
  // start_date rather than one per card. It cannot be known before reading the
  // data, so the stream is walked once to collect prices and the newest date,
  // then rows are built. Only cards with a Cardmarket EUR price are retained,
  // which is ~88% of the file.
  console.log('[Price History] Streaming AllPrices…')
  const entries = []
  let latest = null
  let scanned = 0, unmapped = 0

  for await (const [uuid, entry] of streamBulkEntries(PRICES_URL, { userAgent: USER_AGENT })) {
    scanned++
    if (scanned % LOG_EVERY === 0) {
      console.log(`[Price History] scanned ${scanned.toLocaleString()} printings…`)
    }
    const retail = entry?.paper?.cardmarket?.retail
    if (!retail) continue
    const sid = idMap.get(uuid)
    if (!sid) { unmapped++; continue }

    const cardLatest = latestDateIn(entry)
    if (cardLatest && (!latest || cardLatest > latest)) latest = cardLatest
    entries.push([sid, entry])
  }

  if (!latest) throw new Error('No Cardmarket dates found in AllPrices — has the format changed?')

  const startDate = windowStart(latest, HISTORY_DAYS)
  console.log(`[Price History] ${entries.length.toLocaleString()} priced printings; window ${startDate} -> ${latest} (${unmapped.toLocaleString()} unmapped).`)

  let written = 0
  let pending = []
  for (const [sid, entry] of entries) {
    const row = priceHistoryRow(sid, entry, startDate, HISTORY_DAYS)
    if (!row) continue
    pending.push(row)
    if (pending.length >= UPSERT_BATCH) {
      await flush(pending)
      written += pending.length
      pending = []
      if (written % LOG_EVERY === 0) {
        console.log(`[Price History] wrote ${written.toLocaleString()} rows…`)
      }
    }
  }
  if (pending.length) { await flush(pending); written += pending.length }

  const secs = Math.round((Date.now() - started) / 1000)
  console.log(`[Price History] Done. Wrote ${written.toLocaleString()} rows in ${secs}s.`)
}

main().catch(error => {
  console.error(`[Price History] Failed: ${error.message}`)
  process.exit(1)
})

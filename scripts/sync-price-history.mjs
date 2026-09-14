import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { streamBulkEntries } from './lib/mtgjson-stream.mjs'
import { upsertWithRetry } from './lib/sync-retry.mjs'
import {
  HISTORY_DAYS,
  SERIES_COLUMNS,
  STAGING_SPAN,
  daysBetween,
  fillSlots,
  foldEntryInto,
  globallyMissingSlots,
  isoDay,
  mergeAccumulators,
  rowFromAccumulator,
  stagingBase,
  windowStart,
  wireRow,
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
//
// Streaming the file is not on its own enough to stream the JOB: what the
// stream retains decides the peak. Every date map is therefore folded into a
// dense Int32 cent array on arrival (see the staging-window note in
// price-history-core.mjs) and MTGJSON's own objects are dropped immediately.
// Retaining them instead exhausted the heap twice, the second time within one
// commit of the first fix.

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const USER_AGENT = 'DeckLoomPriceHistorySync/1.0'
const PRICES_URL = 'https://mtgjson.com/api/v5/AllPrices.json.gz'
const IDENTIFIERS_URL = 'https://mtgjson.com/api/v5/AllIdentifiers.json.gz'
// card_price_history rows are small (two ~60-element real[] plus a key), but
// the table is 90k rows, so batches stay modest to keep each statement well
// inside the timeout. Same reasoning as the oracle sync's 100.
const UPSERT_BATCH = 250
const LOG_EVERY = 20000
// The derived uuid -> scryfallId pairs, cached between runs by the workflow.
// AllIdentifiers is 219 MB of the ~362 MB this job moves and is the slower half
// to stream, while the mapping only changes when printings are added — so
// re-downloading it every run is the single biggest avoidable cost here.
const CACHE_PATH = process.env.ID_MAP_CACHE || '.cache/mtgjson-scryfall-ids.tsv'
// How wrong a cached map may be before it is discarded. Steady state is ~22
// unmapped of 101k; a new set landing pushes that into the thousands.
const UNMAPPED_RATIO = 0.01
const UNMAPPED_FLOOR = 500

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
 * Not stored in Postgres: an mtgjson_uuid column on card_prints would cost
 * ~4.4 MB of the resource that is actually scarce here, while runner bandwidth
 * is free.
 *
 * It IS cached on the runner, because AllIdentifiers is 219 MB of the ~362 MB
 * this job moves and is the slower half to stream — while the mapping itself
 * only changes when printings are added. The cache holds the derived pairs
 * (~9 MB of TSV) rather than the source file.
 */
async function fetchScryfallIdMap() {
  const map = new Map()
  let scanned = 0
  for await (const [uuid, card] of streamBulkEntries(IDENTIFIERS_URL, { userAgent: USER_AGENT })) {
    scanned++
    const sid = card?.identifiers?.scryfallId
    if (sid) map.set(uuid, sid)
  }
  console.log(`[Price History] mapped ${map.size.toLocaleString()} of ${scanned.toLocaleString()} printings from AllIdentifiers.`)
  return map
}

function readCachedIdMap(cachePath) {
  if (!cachePath || !fs.existsSync(cachePath)) return null
  const map = new Map()
  for (const line of fs.readFileSync(cachePath, 'utf8').split('\n')) {
    if (!line) continue
    const tab = line.indexOf('\t')
    if (tab > 0) map.set(line.slice(0, tab), line.slice(tab + 1))
  }
  if (!map.size) return null
  console.log(`[Price History] reusing cached id map (${map.size.toLocaleString()} printings) — AllIdentifiers not downloaded.`)
  return map
}

function writeCachedIdMap(cachePath, map) {
  if (!cachePath) return
  fs.mkdirSync(path.dirname(cachePath), { recursive: true })
  const out = []
  for (const [uuid, sid] of map) out.push(`${uuid}\t${sid}`)
  fs.writeFileSync(cachePath, out.join('\n'))
}

async function flush(rows) {
  if (!rows.length) return
  await upsertWithRetry(
    rows.map(wireRow),
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

  // Prices are read first and keyed by uuid, so the id map can be validated
  // against what the file actually contains before committing to it.
  console.log('[Price History] Streaming AllPrices…')
  const byUuid = new Map()
  const stats = { latest: null, outOfRange: 0 }
  let scanned = 0
  let buildDate = null
  let baseDate = null

  for await (const [uuid, entry] of streamBulkEntries(PRICES_URL, {
    userAgent: USER_AGENT,
    onMeta: meta => { buildDate = meta?.date || null },
  })) {
    scanned++
    if (scanned % LOG_EVERY === 0) {
      console.log(`[Price History] scanned ${scanned.toLocaleString()} printings…`)
    }
    if (!baseDate) {
      // Today only if the file declined to say — its own build date is both
      // more accurate and immune to the runner's clock.
      baseDate = stagingBase(buildDate || isoDay(Date.now()))
      console.log(`[Price History] AllPrices built ${buildDate || '(no meta)'} — staging ${STAGING_SPAN} days from ${baseDate}.`)
    }
    // Only the days we store survive this line. MTGJSON's own date maps are
    // dropped with the entry: keeping them is what exhausted the heap.
    const acc = foldEntryInto(null, entry, baseDate, STAGING_SPAN, stats)
    if (acc) byUuid.set(uuid, acc)
  }

  if (!stats.latest) throw new Error('No Cardmarket or TCGplayer dates found in AllPrices — has the format changed?')

  const latest = stats.latest
  const startDate = windowStart(latest, HISTORY_DAYS)
  // A window that does not fit the staging span means the anchor was wrong and
  // days have already been dropped on the floor. Fail rather than write a row
  // that is silently short of history.
  if (daysBetween(baseDate, startDate) < 0 || daysBetween(baseDate, latest) >= STAGING_SPAN) {
    throw new Error(
      `AllPrices is dated ${buildDate} but prices run to ${latest}; the ${STAGING_SPAN}-day staging window from ${baseDate} cannot hold ${startDate}..${latest}.`,
    )
  }

  // Cached map first, then a freshness check: a cached map cannot know about
  // printings added since it was built, and a new set release is exactly when
  // it would silently drop a few hundred cards. If too many uuids fail to
  // resolve, the cache is discarded and AllIdentifiers fetched for real — so
  // the saving never costs coverage.
  const countUnmapped = map => {
    let n = 0
    for (const uuid of byUuid.keys()) if (!map.has(uuid)) n++
    return n
  }

  let idMap = readCachedIdMap(CACHE_PATH)
  let unmapped = idMap ? countUnmapped(idMap) : byUuid.size

  if (idMap && unmapped > Math.max(UNMAPPED_FLOOR, byUuid.size * UNMAPPED_RATIO)) {
    console.log(`[Price History] cached map missed ${unmapped.toLocaleString()} printings — refreshing from AllIdentifiers.`)
    idMap = null
  }
  if (!idMap) {
    idMap = await fetchScryfallIdMap()
    writeCachedIdMap(CACHE_PATH, idMap)
    unmapped = countUnmapped(idMap)
  }

  // Keyed by Scryfall id, not uuid: the mapping is many-to-one (MTGJSON gives
  // etched/foil variants their own uuids where Scryfall keeps one id), so the
  // finishes are merged here.
  //
  // Each staged entry is handed over and dropped as it goes, so the two maps
  // are never both fully populated — the peak is one of them, not their sum.
  const byScryfallId = new Map()
  let merged = 0

  for (const [uuid, acc] of byUuid) {
    byUuid.delete(uuid)
    const sid = idMap.get(uuid)
    if (!sid) continue
    const existing = byScryfallId.get(sid)
    if (existing) merged++
    byScryfallId.set(sid, mergeAccumulators(existing, acc))
  }

  const outOfRange = stats.outOfRange
    ? ` ${stats.outOfRange.toLocaleString()} dates outside the staging window,` : ''
  console.log(`[Price History] ${byScryfallId.size.toLocaleString()} printings; window ${startDate} -> ${latest} (${unmapped.toLocaleString()} unmapped,${outOfRange} ${merged.toLocaleString()} variant merges).`)

  // Narrow every staged card to the shared window before writing any, so the
  // days MTGJSON simply failed to publish can be told apart from the days a
  // given card had no listing. Only the former are interpolated — see
  // globallyMissingSlots.
  const rows = []
  for (const [sid, acc] of byScryfallId) {
    byScryfallId.delete(sid)
    const row = rowFromAccumulator(sid, acc, baseDate, startDate, HISTORY_DAYS)
    if (row) rows.push(row)
  }

  // Per column: a day Cardmarket failed to publish is not necessarily a day
  // TCGplayer failed to publish, so the outage sets are computed independently.
  const asDates = slots => [...slots]
    .map(i => isoDay(Date.parse(`${startDate}T00:00:00Z`) + i * 86400000))
    .join(', ')

  for (const column of SERIES_COLUMNS) {
    const missing = globallyMissingSlots(rows.map(r => r[column]), HISTORY_DAYS)
    if (missing.size) {
      console.log(`[Price History] ${column}: source published nothing on ${missing.size} day(s): ${asDates(missing)}. Interpolating for every card.`)
    }
    for (const row of rows) fillSlots(row[column], missing)
  }

  let written = 0
  let pending = []
  for (const row of rows) {
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
  const peakMb = Math.round(process.memoryUsage().heapTotal / 1048576)
  console.log(`[Price History] Done. Wrote ${written.toLocaleString()} rows in ${secs}s (heap ${peakMb} MB).`)
}

main().catch(error => {
  console.error(`[Price History] Failed: ${error.message}`)
  process.exit(1)
})

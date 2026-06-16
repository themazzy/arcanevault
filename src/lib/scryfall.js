/**
 * Scryfall data layer — now backed by IndexedDB instead of localStorage.
 *
 * Two expiry strategies:
 *   - Images (image_uris): never expire — card art never changes
 *   - Prices + metadata: expire per cache_ttl_h user setting
 *
 * In-memory map is rebuilt from IDB on first access per session.
 */

import {
  getAllScryfallEntries, putScryfallEntries,
  clearScryfallStore, getScryfallCacheInfo, setMeta, getMeta
} from './db'
import {
  cardPrintRowToSfEntry,
  fetchCardPrintsByScryfallIds,
  fetchCardPrintsBySetCollector,
  ensureCardPrints,
} from './cardPrints'
import { perfSpan } from './perf'

const BATCH_SIZE = 75
const DELAY_MS   = 80
const SF_CONCURRENCY = 2
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const SF_API_ORIGIN = 'https://api.scryfall.com'
const SF_DEV_PROXY_PREFIX = '/api/scryfall'
const SCRYFALL_METADATA_UPDATED_AT_KEY = 'scryfall_metadata_updated_at'
const LEGACY_SCRYFALL_PRICES_UPDATED_AT_KEY = 'scryfall_prices_updated_at'

async function getMetadataUpdatedAt() {
  const current = await getMeta(SCRYFALL_METADATA_UPDATED_AT_KEY)
  if (current != null) return current

  const legacy = await getMeta(LEGACY_SCRYFALL_PRICES_UPDATED_AT_KEY)
  if (legacy != null) {
    await setMeta(SCRYFALL_METADATA_UPDATED_AT_KEY, legacy)
    return legacy
  }
  return null
}

export function sfUrl(url) {
  const normalizedUrl = url.startsWith('/')
    ? `${SF_API_ORIGIN}${url}`
    : url
  if (!import.meta.env.DEV) return normalizedUrl
  return normalizedUrl.startsWith(SF_API_ORIGIN)
    ? `${SF_DEV_PROXY_PREFIX}${normalizedUrl.slice(SF_API_ORIGIN.length)}`
    : normalizedUrl
}

// ── Shared Scryfall fetch helper ───────────────────────────────────────────────
// Enforces 100ms minimum between requests and adds required Accept header.
// User-Agent cannot be set from browser JS (forbidden header) — browser sends its own.
const SF_HEADERS = { 'Accept': 'application/json' }
let _lastSfCall = 0
let _activeSfCalls = 0
const _sfWaiters = []

function getRetryDelayMs(res) {
  const retryAfter = res.headers?.get?.('Retry-After')
  if (!retryAfter) return 1000
  const seconds = Number.parseFloat(retryAfter)
  if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000)
  const dateMs = Date.parse(retryAfter)
  return Number.isFinite(dateMs) ? Math.max(1000, dateMs - Date.now()) : 1000
}

// Semaphore: up to SF_CONCURRENCY in-flight, with min-gap between request starts.
async function acquireSfSlot(minDelayMs) {
  if (_activeSfCalls >= SF_CONCURRENCY) {
    await new Promise(r => _sfWaiters.push(r))
  }
  _activeSfCalls++
  const wait = Math.max(0, minDelayMs - (Date.now() - _lastSfCall))
  if (wait) await new Promise(r => setTimeout(r, wait))
  _lastSfCall = Date.now()
}

function releaseSfSlot() {
  _activeSfCalls--
  const next = _sfWaiters.shift()
  if (next) next()
}

async function runScryfallRequest(fn, { minDelayMs = DELAY_MS, retries = 3 } = {}) {
  await acquireSfSlot(minDelayMs)
  try {
    let lastErr = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fn()
        // Retry on rate-limit and transient 5xx; everything else returns.
        if (res.status === 429) {
          if (attempt === retries) return res
          await new Promise(r => setTimeout(r, getRetryDelayMs(res)))
          _lastSfCall = Date.now()
          continue
        }
        if (res.status >= 500 && res.status < 600) {
          if (attempt === retries) return res
          const backoff = Math.min(8000, 500 * 2 ** attempt)
          await new Promise(r => setTimeout(r, backoff))
          _lastSfCall = Date.now()
          continue
        }
        return res
      } catch (err) {
        // Network/abort errors — retry with backoff.
        lastErr = err
        if (attempt === retries) throw err
        const backoff = Math.min(8000, 500 * 2 ** attempt)
        await new Promise(r => setTimeout(r, backoff))
        _lastSfCall = Date.now()
      }
    }
    if (lastErr) throw lastErr
  } finally {
    releaseSfSlot()
  }
}

export async function sfGet(url, opts = {}) {
  try {
    const fetchOpts = { headers: SF_HEADERS }
    if (opts.noCache) fetchOpts.cache = 'no-store'
    const res = await runScryfallRequest(() => fetch(sfUrl(url), fetchOpts))
    if (!res?.ok) return null
    return res.json()
  } catch (err) {
    console.warn('[SF] sfGet failed', url, err?.message || err)
    return null
  }
}

// Clear old localStorage keys
;['arcanevault_sfcache','arcanevault_sfcache_v2',
  'arcanevault_prices_v1','arcanevault_prices_v2','arcanevault_prices_v3',
  'arcanevault_images_v1'].forEach(k => { try { localStorage.removeItem(k) } catch {} })

// ── In-memory map ─────────────────────────────────────────────────────────────
// Rebuilt from IDB on first enrichCards call, survives navigation
let _sfMap = null  // { 'set-col': { prices, type_line, image_uris, ... } }

function buildMapFromEntries(entries) {
  const map = {}
  for (const e of entries) map[e.key] = e
  return map
}

// ── Public cache management ───────────────────────────────────────────────────

// Clears fetched metadata while keeping cached images.
export async function clearScryfallCache() {
  _sfMap = null
  const entries = await getAllScryfallEntries()
  // Strip metadata fields that can be re-fetched, keep image fields.
  const stripped = entries.map(e => ({
    ...e,
    prices: null,
    prices_updated_at: null,
    rarity: null, type_line: null, set_name: null,
    color_identity: null, cmc: null, legalities: null,
    artist: null, oracle_text: null, power: null, toughness: null,
  }))
  await putScryfallEntries(stripped)
  await setMeta(SCRYFALL_METADATA_UPDATED_AT_KEY, null)
  await setMeta(LEGACY_SCRYFALL_PRICES_UPDATED_AT_KEY, null)
  console.log('[SF] metadata cache cleared (images kept)')
}

// Clears everything
export async function clearAllScryfallCache() {
  _sfMap = null
  await clearScryfallStore()
  console.log('[SF] all cache cleared')
}

export async function getCacheAge() {
  const ts = await getMetadataUpdatedAt()
  return ts ? Date.now() - ts : null
}

// Synchronous best-effort: return in-memory map if available
// Used to pre-populate sfMap state before async load completes
export function getMemoryMap() {
  return _sfMap
}

// ── Worker-prefetched price rows (Phase 2e) ───────────────────────────────────
// The hydrate worker reads today's+yesterday's card_prices rows off-thread.
// Consumed once by the first price overlay, then cleared so later overlays
// (after price writes) read fresh from IDB.
let _prefetchedPriceRows = null

function stashPrefetchedPriceRows(rows, dates) {
  _prefetchedPriceRows = { rows, dates, at: Date.now() }
}

// Returns the prefetched rows if they cover exactly `snapshotDates` and are
// recent (the worker ran this page load), else null. Single-use.
export function consumePrefetchedPriceRows(snapshotDates) {
  const p = _prefetchedPriceRows
  if (!p) return null
  _prefetchedPriceRows = null
  if (Date.now() - p.at > 30000) return null
  const want = [...snapshotDates].sort().join('|')
  const have = [...(p.dates || [])].sort().join('|')
  return want === have ? p.rows : null
}

// ── Async cache loader ────────────────────────────────────────────────────────
// Load all entries from IDB into memory. Returns map or null if empty.
// Off-main-thread hydration (Phase 2b). Resolves null when workers are
// unavailable or anything goes wrong — callers fall back to the direct path.
function hydrateViaWorker() {
  if (typeof Worker === 'undefined') return Promise.resolve(null)
  return new Promise(resolve => {
    let worker
    try {
      worker = new Worker(new URL('./hydrateWorker.js', import.meta.url), { type: 'module' })
    } catch {
      return resolve(null)
    }
    const finish = (result) => {
      clearTimeout(timer)
      worker.terminate()
      resolve(result)
    }
    const timer = setTimeout(() => finish(null), 10000)
    worker.onmessage = e => finish(e.data?.ok && e.data.count > 0 ? e.data : null)
    worker.onerror = () => finish(null)
    worker.postMessage('hydrate')
  })
}

export async function loadCacheFromIDB(cacheTtlMs = DEFAULT_TTL_MS) {
  if (_sfMap) return _sfMap

  const endHydrate = perfSpan('idb-hydrate')
  const viaWorker = await hydrateViaWorker()
  if (viaWorker) {
    const updatedAt = await getMetadataUpdatedAt()
    const expired = !updatedAt || (Date.now() - updatedAt > cacheTtlMs)
    console.log(`[SF IDB] loaded ${viaWorker.count} cards (worker) — metadata ${expired ? 'EXPIRED' : 'fresh'}`)
    _sfMap = viaWorker.map
    // The worker also pre-read today's+yesterday's price rows off-thread; stash
    // them so the next price overlay skips its own main-thread IDB read.
    if (viaWorker.priceRows) {
      stashPrefetchedPriceRows(viaWorker.priceRows, viaWorker.priceDates)
    }
    endHydrate()
    return { map: _sfMap, pricesExpired: expired }
  }

  // Direct path: workers unavailable (tests, very old WebViews) or empty DB.
  const endRead = perfSpan('idb-hydrate:read')
  const entries = await getAllScryfallEntries()
  endRead()
  if (!entries.length) {
    console.log('[SF IDB] empty')
    return null
  }

  // Check metadata freshness
  const updatedAt = await getMetadataUpdatedAt()
  const expired = !updatedAt || (Date.now() - updatedAt > cacheTtlMs)

  console.log(`[SF IDB] loaded ${entries.length} cards — metadata ${expired ? 'EXPIRED' : 'fresh'}`)

  const endBuild = perfSpan('idb-hydrate:build-map')
  _sfMap = buildMapFromEntries(entries)
  endBuild()
  return { map: _sfMap, pricesExpired: expired }
}

export async function getInstantCache(cacheTtlMs = DEFAULT_TTL_MS) {
  // If already in memory, return directly — loadCacheFromIDB returns the raw map
  // (not wrapped) in the `if (_sfMap) return _sfMap` fast-path, which breaks
  // the result.map accessor. Bypass it entirely when in memory.
  if (_sfMap) return _sfMap
  const result = await loadCacheFromIDB(cacheTtlMs)
  if (!result) return null
  return result.map
}

// ── Fetching ──────────────────────────────────────────────────────────────────

// Returns { data, ok } so callers can distinguish "card not found in Scryfall"
// (ok=true, data=[]) from "request failed" (ok=false). Previously these were
// indistinguishable, which masked network failures as successful empty fetches.
export async function fetchScryfallBatch(identifiers) {
  try {
    const res = await runScryfallRequest(() => fetch(sfUrl(`${SF_API_ORIGIN}/cards/collection`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ identifiers })
    }))
    if (!res?.ok) {
      console.warn('[SF] batch failed', res?.status)
      return { ok: false, data: [] }
    }
    const json = await res.json()
    return { ok: true, data: json.data || [] }
  } catch (err) {
    console.warn('[SF] batch threw', err?.message || err)
    return { ok: false, data: [] }
  }
}

// Merge a new entry into an existing one, preferring non-empty new values
// but falling back to the existing value when the new field is null/empty.
// Critical for the "Clear Local Metadata" flow: clearScryfallCache() strips
// metadata fields but keeps image_uris/card_faces — a naive {...old, ...new}
// would overwrite intact cached images with a partial set from card_prints
// rows that pre-date the migration.
function mergeSfEntry(existing, next) {
  if (!existing) return next
  const out = { ...existing }
  for (const [key, value] of Object.entries(next)) {
    if (value == null) continue
    if (Array.isArray(value) && value.length === 0) continue
    if (typeof value === 'object' && !Array.isArray(value)) {
      // For image_uris: only take the new object if it carries at least as
      // many populated sizes as the existing one. Otherwise we'd downgrade
      // a 4-size IDB image_uris to a partial 2-size card_prints one.
      if (key === 'image_uris' && existing.image_uris) {
        const existingCount = Object.values(existing.image_uris).filter(Boolean).length
        const nextCount = Object.values(value).filter(Boolean).length
        if (nextCount < existingCount) continue
      }
      if (Object.keys(value).length === 0) continue
    }
    out[key] = value
  }
  return out
}

// Resolve as many missing cards as possible from our own card_prints table
// (one batched Supabase call) before falling back to Scryfall. Returns the
// subset of input cards that still need a Scryfall fetch. Entries that come
// from card_prints are merged into _sfMap and persisted to IDB so future
// loads hit the in-memory cache directly.
async function enrichFromCardPrints(cards) {
  if (!cards?.length) return []
  if (!_sfMap) _sfMap = {}

  const scryfallIds = []
  const setColPairs = []
  for (const c of cards) {
    const sid = c.scryfall_id ? String(c.scryfall_id).trim() : null
    if (sid) scryfallIds.push(sid)
    else if (c.set_code && c.collector_number) setColPairs.push({ set_code: c.set_code, collector_number: c.collector_number })
  }

  let rowsByScryfallId = new Map()
  let rowsBySetCol = new Map()
  try {
    if (scryfallIds.length)  rowsByScryfallId = await fetchCardPrintsByScryfallIds(scryfallIds)
    if (setColPairs.length)  rowsBySetCol     = await fetchCardPrintsBySetCollector(setColPairs)
  } catch (err) {
    console.warn('[card_prints] enrich query failed, falling back to Scryfall', err?.message || err)
    return cards
  }

  if (!rowsByScryfallId.size && !rowsBySetCol.size) return cards

  const newEntries = []
  const resolved = new Set()
  for (const c of cards) {
    const sid = c.scryfall_id ? String(c.scryfall_id).trim() : null
    let row = sid ? rowsByScryfallId.get(sid) : null
    if (!row && c.set_code && c.collector_number) {
      row = rowsBySetCol.get(`${c.set_code}|${c.collector_number}`) || null
    }
    if (!row) continue
    const entry = cardPrintRowToSfEntry(row)
    if (!entry) continue
    // Reject rows that pre-date the filter-columns migration — they have
    // NULL type_line/rarity and would break the filter bar. Let Scryfall
    // fetch them and the next ensureCardPrints() upsert will backfill.
    if (!entry.type_line) continue
    _sfMap[entry.key] = mergeSfEntry(_sfMap[entry.key], entry)
    newEntries.push(_sfMap[entry.key])
    resolved.add(c)
  }

  if (newEntries.length) {
    try { await putScryfallEntries(newEntries) }
    catch (err) { console.warn('[card_prints] IDB persist failed', err?.message || err) }
    console.log(`[card_prints] resolved ${newEntries.length}/${cards.length} from Supabase`)
  }

  return cards.filter(c => !resolved.has(c))
}

// True when an entry is absent, was stripped by clearScryfallCache, or still
// lacks oracle text. card_prints now supplies oracle_text for ~99.85% of
// printings, so most entries are complete straight after enrichFromCardPrints;
// only the residual (pre-migration rows, or the ~0.15% of prints with no
// oracle_id) has oracle_text == null and falls through to Scryfall. Vanilla
// cards carry oracle_text === '' (non-null), so they don't perpetually refetch.
function entryNeedsScryfall(entry) {
  return !entry || !entry.type_line || entry.oracle_text == null
}

function cardsNeedingScryfall(cards) {
  return cards.filter(c => entryNeedsScryfall(_sfMap[`${c.set_code}-${c.collector_number}`]))
}

export async function enrichCards(cards, onProgress, cacheTtlMs = DEFAULT_TTL_MS) {
  // Load from IDB if not in memory yet
  if (!_sfMap) {
    const result = await loadCacheFromIDB(cacheTtlMs)
    if (result) {
      _sfMap = result.map
      // If metadata expired, we fall through to fetch fresh metadata below.
      if (!result.pricesExpired) {
        const missing = cardsNeedingScryfall(cards)
        if (missing.length === 0) {
          console.log(`[SF] all ${cards.length} cards cached — skip fetch`)
          onProgress?.(100, '')
          return _sfMap
        }
        // card_prints (Supabase) now supplies oracle_text too, alongside
        // type_line/mana/etc., so this pass completes most cards without any
        // Scryfall call. Re-check who still lacks oracle text (residual /
        // pre-migration rows) and send only those to Scryfall.
        await enrichFromCardPrints(missing)
        const stillMissing = cardsNeedingScryfall(missing)
        if (stillMissing.length) {
          console.log(`[SF] ${stillMissing.length}/${missing.length} cards need Scryfall after card_prints`)
          await fetchAndMerge(stillMissing, null)
        }
        return _sfMap
      }
      // Metadata expired — try card_prints first, Scryfall for the rest.
      await enrichFromCardPrints(cards)
      const stillMissing = cardsNeedingScryfall(cards)
      if (stillMissing.length) {
        console.log(`[SF] metadata expired, refetching ${stillMissing.length}/${cards.length} via Scryfall`)
        await fetchAndMerge(stillMissing, onProgress)
      } else {
        onProgress?.(100, '')
      }
      return _sfMap
    }
  } else {
    const missing = cardsNeedingScryfall(cards)
    if (missing.length === 0) {
      onProgress?.(100, '')
      return _sfMap
    }
    await enrichFromCardPrints(missing)
    const stillMissing = cardsNeedingScryfall(missing)
    if (stillMissing.length) {
      console.log(`[SF] ${stillMissing.length} cards need Scryfall after card_prints`)
      await fetchAndMerge(stillMissing, onProgress)
    } else {
      onProgress?.(100, '')
    }
    return _sfMap
  }

  // Nothing in IDB at all — try card_prints, then Scryfall for the residual.
  await enrichFromCardPrints(cards)
  const stillMissing = cardsNeedingScryfall(cards)
  if (stillMissing.length) {
    console.log(`[SF] cold start: ${stillMissing.length}/${cards.length} cards need Scryfall`)
    await fetchAndMerge(stillMissing, onProgress)
  } else {
    onProgress?.(100, '')
  }
  return _sfMap
}

function buildEntryFromScryfall(r) {
  const key = `${r.set}-${r.collector_number}`
  const existing = _sfMap[key] || {}
  return {
    key,
    set_code:         r.set,
    collector_number: r.collector_number,
    name:             r.name,
    set_name:         r.set_name,
    type_line:        r.type_line,
    rarity:           r.rarity,
    prices:           r.prices,
    prices_prev:      existing.prices || null,
    color_identity:   r.color_identity || [],
    cmc:              r.cmc ?? null,
    legalities:       r.legalities || {},
    artist:           r.artist || null,
    // Preserve empty string for vanilla creatures so we can distinguish
    // "fetched, no rules text" from "never fetched" (null/undefined). The
    // missing-check downstream treats null/undefined as needing Scryfall.
    oracle_text:      (r.oracle_text || r.card_faces?.[0]?.oracle_text || '').slice(0, 600),
    power:            r.power ?? null,
    toughness:        r.toughness ?? null,
    produced_mana:    r.produced_mana || null,
    keywords:         r.keywords || [],
    image_uris: existing.image_uris || (r.image_uris ? {
      small:    r.image_uris.small,
      normal:   r.image_uris.normal,
      large:    r.image_uris.large,
      art_crop: r.image_uris.art_crop || null,
    } : null),
    mana_cost: r.mana_cost || r.card_faces?.[0]?.mana_cost || null,
    card_faces: existing.card_faces || r.card_faces?.map(f => ({
      image_uris: f.image_uris ? {
        small:  f.image_uris.small,
        normal: f.image_uris.normal,
        large:  f.image_uris.large,
      } : null,
      name: f.name,
      mana_cost: f.mana_cost || null,
    })) || null,
  }
}

async function fetchAndMerge(cards, onProgress) {
  if (!_sfMap) _sfMap = {}
  const total = Math.ceil(cards.length / BATCH_SIZE)
  if (!total) return

  // Build batch tasks up front, then drain with a worker pool.
  const tasks = []
  for (let i = 0; i < cards.length; i += BATCH_SIZE) {
    const batch = cards.slice(i, i + BATCH_SIZE)
    tasks.push(batch.map(c =>
      c.collector_number && c.set_code
        ? { set: c.set_code, collector_number: c.collector_number }
        : { name: c.name }
    ))
  }

  let cursor = 0
  let completed = 0
  let savedCount = 0
  let failedBatches = 0
  const allScryfallResults = []

  async function worker() {
    while (cursor < tasks.length) {
      const idx = cursor++
      const ids = tasks[idx]
      const { ok, data: results } = await fetchScryfallBatch(ids)
      if (!ok) failedBatches++

      const batchEntries = []
      for (const r of results) {
        const entry = buildEntryFromScryfall(r)
        _sfMap[entry.key] = entry
        batchEntries.push(entry)
        allScryfallResults.push(r)
      }

      // Persist this batch immediately so progress survives reload/close.
      if (batchEntries.length) {
        try {
          await putScryfallEntries(batchEntries)
          await setMeta(SCRYFALL_METADATA_UPDATED_AT_KEY, Date.now())
          savedCount += batchEntries.length
        } catch (err) {
          console.warn('[SF IDB] batch persist failed', err)
        }
      }

      completed++
      onProgress?.(
        Math.round((completed / total) * 100),
        `Fetching card data… (${Math.min(completed * BATCH_SIZE, cards.length)} / ${cards.length})`
      )
    }
  }

  const poolSize = Math.min(SF_CONCURRENCY, tasks.length)
  await Promise.all(Array.from({ length: poolSize }, () => worker()))

  if (savedCount) console.log(`[SF IDB] saved ${savedCount} entries (incremental)`)
  if (failedBatches) {
    console.warn(`[SF] ${failedBatches}/${total} batches failed — cards will retry on next load`)
    // Surface as a soft error so callers can show a banner; cards left out of
    // _sfMap will naturally re-attempt on the next enrichCards() call since
    // they remain "missing" in the per-key check.
    throw new Error(`Scryfall fetch incomplete: ${failedBatches} of ${total} batches failed`)
  }

  // Push freshly-fetched data into the shared card_prints table so the next
  // user (or this user on next load) gets it from Supabase instead of Scryfall.
  // Fire-and-forget — errors are non-fatal and already logged inside.
  if (allScryfallResults.length) {
    ensureCardPrints(allScryfallResults).catch(err =>
      console.warn('[card_prints] push-back upsert failed', err?.message || err)
    )
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

// ── Price configuration ───────────────────────────────────────────────────────
//
// price_source encodes both marketplace and price type, e.g. 'cardmarket_trend'
// Available sources and what Scryfall field they map to:
//
//   Cardmarket (EUR — official Scryfall/Cardmarket data):
//     cardmarket_trend      → eur / eur_foil        (Cardmarket Trend — default)
//
//   TCGPlayer (USD):
//     tcgplayer_market      → usd / usd_foil         (TCGPlayer Market)
//     tcgplayer_market_etched → usd_etched           (TCGPlayer Etched Foil market)
//
//   MTGO:
//     mtgo_tix              → tix                    (MTGO Ticket price)
//
// Note: Cardmarket Low, Avg, Avg7, Avg30 require the official Cardmarket API
// (OAuth, developer registration). Scryfall only exposes Cardmarket Trend.
// These can be added later via a backend proxy if needed.

export const PRICE_SOURCES = [
  {
    id:          'cardmarket_trend',
    label:       'Cardmarket — Trend',
    description: 'Europe\'s largest MTG marketplace trend price (via Scryfall)',
    currency:    'EUR',
    symbol:      '€',
    field:       'eur',
    foilField:   'eur_foil',
  },
  {
    id:          'tcgplayer_market',
    label:       'TCGPlayer — Market',
    description: 'North American TCGPlayer market price (via Scryfall)',
    currency:    'USD',
    symbol:      '$',
    field:       'usd',
    foilField:   'usd_foil',
  },
]

export function getPriceSource(priceSourceId = 'cardmarket_trend') {
  return PRICE_SOURCES.find(s => s.id === priceSourceId) || PRICE_SOURCES[0]
}

export function getScryfallKey(card) {
  const setCode = String(card?.set_code || '').trim().toLowerCase()
  const collectorNumber = String(card?.collector_number || '').trim()
  return `${setCode}-${collectorNumber}`
}

// ── Manual price overrides (localStorage) ────────────────────────────────────
// Keyed by card DB id (string). Price stored in native source currency.

const MANUAL_PRICES_KEY = 'arcanevault_manual_prices'

export function getManualPrices() {
  try { return JSON.parse(localStorage.getItem(MANUAL_PRICES_KEY) || '{}') } catch { return {} }
}
export function setManualPrice(cardId, price) {
  const map = getManualPrices()
  if (price == null || price === '') delete map[String(cardId)]
  else map[String(cardId)] = parseFloat(price)
  localStorage.setItem(MANUAL_PRICES_KEY, JSON.stringify(map))
}
export function getManualPrice(cardId) {
  if (!cardId) return null
  const v = getManualPrices()[String(cardId)]
  return v != null ? v : null
}

// Returns { value, symbol, suffix, currency, isFallback, pct } in the native price currency.
// Only looks at the user-selected source — no cross-source fallback.
export function getPriceWithMeta(sfCard, foil, { price_source = 'cardmarket_trend' } = {}) {
  if (!sfCard?.prices) return null
  const p    = sfCard.prices
  const prev = sfCard.prices_prev || null
  const source = getPriceSource(price_source)

  const calcPct = (current, field) => {
    if (!prev) return null
    const prevVal = parseFloat(prev[field] || 0)
    if (!prevVal || !current) return null
    return ((current - prevVal) / prevVal) * 100
  }

  const preferredField = foil ? source.foilField : source.field
  const preferred = parseFloat(p[preferredField] || 0)
  if (preferred) return {
    value: preferred,
    symbol: source.symbol,
    suffix: source.suffix || '',
    currency: source.currency || (source.symbol === '€' ? 'EUR' : source.symbol === '$' ? 'USD' : 'TIX'),
    isFallback: false,
    pct: calcPct(preferred, preferredField),
  }

  // Price not available in selected source — return null. User can enter manually.
  return null
}

// Returns numeric price. Checks manual overrides first, then Scryfall data.
export function getPrice(sfCard, foil, { price_source = 'cardmarket_trend', cardId = null } = {}) {
  if (cardId != null) {
    const manual = getManualPrice(cardId)
    if (manual != null) return manual
  }
  return getPriceWithMeta(sfCard, foil, { price_source })?.value ?? null
}

/** Format a price value in its native price source currency. */
export function formatPrice(value, priceSourceId = 'cardmarket_trend') {
  if (value == null) return '—'
  const source = getPriceSource(priceSourceId)
  return `${source.symbol}${value.toFixed(2)}`
}

/** Format a PriceWithMeta object in its native currency. */
export function formatPriceMeta(meta) {
  if (!meta) return '—'
  return `${meta.symbol}${meta.value.toFixed(2)}`
}

export function getImageUri(sfCard, size = 'normal') {
  if (!sfCard) return null
  if (sfCard.image_uris) return sfCard.image_uris[size] || sfCard.image_uris.small || null
  if (sfCard.card_faces?.[0]?.image_uris) return sfCard.card_faces[0].image_uris[size] || sfCard.card_faces[0].image_uris.small || null
  return null
}

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

const BATCH_SIZE = 75
const DELAY_MS   = 120
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
let _sfQueue = Promise.resolve()

function getRetryDelayMs(res) {
  const retryAfter = res.headers?.get?.('Retry-After')
  if (!retryAfter) return 1000
  const seconds = Number.parseFloat(retryAfter)
  if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000)
  const dateMs = Date.parse(retryAfter)
  return Number.isFinite(dateMs) ? Math.max(1000, dateMs - Date.now()) : 1000
}

async function runScryfallRequest(fn, { minDelayMs = DELAY_MS, retries = 2 } = {}) {
  const task = _sfQueue.then(async () => {
    const wait = Math.max(0, minDelayMs - (Date.now() - _lastSfCall))
    if (wait) await new Promise(r => setTimeout(r, wait))
    _lastSfCall = Date.now()

    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await fn()
      if (res.status !== 429 || attempt === retries) return res
      await new Promise(r => setTimeout(r, getRetryDelayMs(res)))
      _lastSfCall = Date.now()
    }
  })
  _sfQueue = task.catch(() => {})
  return task
}

export async function sfGet(url, opts = {}) {
  try {
    const fetchOpts = { headers: SF_HEADERS }
    if (opts.noCache) fetchOpts.cache = 'no-store'
    const res = await runScryfallRequest(() => fetch(sfUrl(url), fetchOpts))
    if (!res.ok) return null
    return res.json()
  } catch {
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

// ── Async cache loader ────────────────────────────────────────────────────────
// Load all entries from IDB into memory. Returns map or null if empty.
export async function loadCacheFromIDB(cacheTtlMs = DEFAULT_TTL_MS) {
  if (_sfMap) return _sfMap

  const entries = await getAllScryfallEntries()
  if (!entries.length) {
    console.log('[SF IDB] empty')
    return null
  }

  // Check metadata freshness
  const updatedAt = await getMetadataUpdatedAt()
  const expired = !updatedAt || (Date.now() - updatedAt > cacheTtlMs)

  console.log(`[SF IDB] loaded ${entries.length} cards — metadata ${expired ? 'EXPIRED' : 'fresh'}`)

  _sfMap = buildMapFromEntries(entries)
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

export async function fetchScryfallBatch(identifiers) {
  try {
    const res = await runScryfallRequest(() => fetch(sfUrl(`${SF_API_ORIGIN}/cards/collection`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ identifiers })
    }))
    if (!res.ok) return []
    return (await res.json()).data || []
  } catch { return [] }
}

export async function enrichCards(cards, onProgress, cacheTtlMs = DEFAULT_TTL_MS) {
  // Load from IDB if not in memory yet
  if (!_sfMap) {
    const result = await loadCacheFromIDB(cacheTtlMs)
    if (result) {
      _sfMap = result.map
      // If metadata expired, we fall through to fetch fresh metadata below.
      if (!result.pricesExpired) {
        const missing = cards.filter(c => !_sfMap[`${c.set_code}-${c.collector_number}`])
        if (missing.length === 0) {
          console.log(`[SF] all ${cards.length} cards cached — skip fetch`)
          onProgress?.(100, '')
          return _sfMap
        }
        // Silently fetch only missing (new cards added since last fetch)
        console.log(`[SF] ${missing.length} new cards missing, fetching silently`)
        await fetchAndMerge(missing, null)
        return _sfMap
      }
      // Metadata expired — re-fetch metadata for the requested cards (images already there).
      console.log(`[SF] metadata expired, re-fetching for ${cards.length} cards`)
      await fetchAndMerge(cards, onProgress)
      return _sfMap
    }
  } else {
    // Already in memory — check for missing cards only
    const missing = cards.filter(c => !_sfMap[`${c.set_code}-${c.collector_number}`])
    if (missing.length === 0) {
      onProgress?.(100, '')
      return _sfMap
    }
    console.log(`[SF] ${missing.length} cards missing from memory, fetching`)
    await fetchAndMerge(missing, onProgress)
    return _sfMap
  }

  // Nothing in IDB at all — full fetch
  console.log(`[SF] full fetch for ${cards.length} cards`)
  await fetchAndMerge(cards, onProgress)
  return _sfMap
}

async function fetchAndMerge(cards, onProgress) {
  if (!_sfMap) _sfMap = {}
  const newEntries = []
  const total = Math.ceil(cards.length / BATCH_SIZE)

  for (let i = 0; i < cards.length; i += BATCH_SIZE) {
    const batch  = cards.slice(i, i + BATCH_SIZE)
    const ids    = batch.map(c =>
      c.collector_number && c.set_code
        ? { set: c.set_code, collector_number: c.collector_number }
        : { name: c.name }
    )
    const results = await fetchScryfallBatch(ids)

    for (const r of results) {
      const key = `${r.set}-${r.collector_number}`
      const existing = _sfMap[key] || {}
      const entry = {
        key,
        set_code:         r.set,
        collector_number: r.collector_number,
        // Metadata fields (refreshed per TTL)
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
        oracle_text:      (r.oracle_text || r.card_faces?.[0]?.oracle_text || '').slice(0, 600) || null,
        power:            r.power ?? null,
        toughness:        r.toughness ?? null,
        produced_mana:    r.produced_mana || null,
        keywords:         r.keywords || [],
        // Image fields (keep existing if present — images never expire)
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
      _sfMap[key] = entry
      newEntries.push(entry)
    }

    onProgress?.(
      Math.round(((Math.floor(i / BATCH_SIZE) + 1) / total) * 100),
      `Fetching card data… (${Math.min(i + BATCH_SIZE, cards.length)} / ${cards.length})`
    )
    if (i + BATCH_SIZE < cards.length) await new Promise(r => setTimeout(r, DELAY_MS))
  }

  // Persist to IDB
  if (newEntries.length) {
    await putScryfallEntries(newEntries)
    await setMeta(SCRYFALL_METADATA_UPDATED_AT_KEY, Date.now())
    console.log(`[SF IDB] saved ${newEntries.length} entries`)
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
  return `${card.set_code}-${card.collector_number}`
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

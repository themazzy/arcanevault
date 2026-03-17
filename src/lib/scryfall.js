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

// Clears prices but keeps images
export async function clearScryfallCache() {
  _sfMap = null
  const entries = await getAllScryfallEntries()
  // Strip price fields, keep image fields
  const stripped = entries.map(e => ({
    ...e,
    prices: null,
    prices_updated_at: null,
    rarity: null, type_line: null, set_name: null,
    color_identity: null, cmc: null, legalities: null,
    artist: null, oracle_text: null, power: null, toughness: null,
  }))
  await putScryfallEntries(stripped)
  await setMeta('scryfall_prices_updated_at', null)
  console.log('[SF] price cache cleared (images kept)')
}

// Clears everything
export async function clearAllScryfallCache() {
  _sfMap = null
  await clearScryfallStore()
  console.log('[SF] all cache cleared')
}

export async function getCacheAge() {
  const ts = await getMeta('scryfall_prices_updated_at')
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

  // Check price freshness
  const updatedAt = await getMeta('scryfall_prices_updated_at')
  const expired = !updatedAt || (Date.now() - updatedAt > cacheTtlMs)

  console.log(`[SF IDB] loaded ${entries.length} cards — prices ${expired ? 'EXPIRED' : 'fresh'}`)

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
    const res = await fetch('https://api.scryfall.com/cards/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifiers })
    })
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
      // If prices expired, we fall through to fetch fresh prices below
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
      // Prices expired — need to re-fetch prices for all cards (images already there)
      console.log(`[SF] prices expired, re-fetching for ${cards.length} cards`)
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
        // Price fields (expire per TTL)
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
      `Fetching prices… (${Math.min(i + BATCH_SIZE, cards.length)} / ${cards.length})`
    )
    if (i + BATCH_SIZE < cards.length) await new Promise(r => setTimeout(r, DELAY_MS))
  }

  // Persist to IDB
  if (newEntries.length) {
    await putScryfallEntries(newEntries)
    await setMeta('scryfall_prices_updated_at', Date.now())
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
  {
    id:          'tcgplayer_etched',
    label:       'TCGPlayer — Etched Foil',
    description: 'TCGPlayer etched foil market price',
    currency:    'USD',
    symbol:      '$',
    field:       'usd_etched',
    foilField:   'usd_etched',
  },
  {
    id:          'mtgo_tix',
    label:       'MTGO — Tickets',
    description: 'Magic Online ticket price',
    currency:    'TIX',
    symbol:      '',
    field:       'tix',
    foilField:   'tix',
    suffix:      ' tix',
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

/**
 * Format a price value using the display currency.
 * If the price is in a different currency, convert it using live FX rates.
 */
export function formatPrice(value, priceSourceId = 'cardmarket_trend', displayCurrency = 'EUR') {
  if (value == null) return '—'
  const source = getPriceSource(priceSourceId)
  const nativeCurrency = source.currency || (source.symbol === '€' ? 'EUR' : 'USD')
  return formatInCurrency(value, nativeCurrency, displayCurrency)
}

/**
 * Format a PriceWithMeta object, converting to display currency.
 */
export function formatPriceMeta(meta, displayCurrency = 'EUR') {
  if (!meta) return '—'
  if (meta.currency === 'TIX') return `${meta.value.toFixed(2)} tix`
  return formatInCurrency(meta.value, meta.currency, displayCurrency)
}

// FX converter — injected at app startup to avoid circular imports
let _convertCurrency = (value, from, to) => {
  // Default passthrough until fx.js injects the real converter
  return value
}
let _fxReady = false

export function injectFxConverter(convertFn) {
  _convertCurrency = convertFn
  _fxReady = true
}

// Convert a raw numeric value between currencies
export function convertCurrency(value, from, to) {
  if (value == null) return null
  if (from === to) return value
  return _convertCurrency(value, from, to) ?? value
}

function formatInCurrency(value, fromCurrency, toCurrency) {
  if (fromCurrency === 'TIX' || toCurrency === 'TIX') return `${value.toFixed(2)} tix`
  const converted = _convertCurrency(value, fromCurrency, toCurrency)
  if (converted == null) return '—'
  const sym = toCurrency === 'EUR' ? '€' : '$'
  return `${sym}${converted.toFixed(2)}`
}

export function getImageUri(sfCard, size = 'normal') {
  if (!sfCard) return null
  if (sfCard.image_uris) return sfCard.image_uris[size] || sfCard.image_uris.small || null
  if (sfCard.card_faces?.[0]?.image_uris) return sfCard.card_faces[0].image_uris[size] || sfCard.card_faces[0].image_uris.small || null
  return null
}

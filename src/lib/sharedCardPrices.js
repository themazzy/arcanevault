import { sb } from './supabase'
import { enrichCards, getInstantCache } from './scryfall'

const SET_CHUNK_SIZE = 50

// Per-set-code price row cache — avoids re-fetching card_prices on every navigation.
// Prices only change daily; 10-minute in-memory TTL is safe.
const _setRowCache = new Map() // set_code → { rows: [], fetchedAt: number }
const PRICE_CACHE_TTL_MS = 10 * 60 * 1000

function isoDateUtc(daysOffset = 0) {
  const date = new Date()
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() + daysOffset)
  return date.toISOString().slice(0, 10)
}

function getCardKey(card) {
  if (!card?.set_code || !card?.collector_number) return null
  return `${card.set_code}-${card.collector_number}`
}

function uniqueByCardKey(cards) {
  const seen = new Set()
  const unique = []
  for (const card of cards) {
    const key = getCardKey(card)
    if (!key || seen.has(key)) continue
    seen.add(key)
    unique.push(card)
  }
  return unique
}

function rowToPrices(row) {
  const prices = {}
  if (row.price_regular_eur != null) prices.eur = row.price_regular_eur
  if (row.price_foil_eur != null) prices.eur_foil = row.price_foil_eur
  if (row.price_regular_usd != null) prices.usd = row.price_regular_usd
  if (row.price_foil_usd != null) prices.usd_foil = row.price_foil_usd
  return prices
}

export async function overlaySharedCardPrices(cards, baseMap = {}) {
  const requestedKeys = new Set(cards.map(getCardKey).filter(Boolean))
  const setCodes = [...new Set(cards.map(card => card?.set_code).filter(Boolean))]
  if (!requestedKeys.size || !setCodes.length) return { ...baseMap }

  const today = isoDateUtc(0)
  const yesterday = isoDateUtc(-1)
  const now = Date.now()

  // Fetch only set codes not already cached (or expired)
  const toFetch = setCodes.filter(s => {
    const cached = _setRowCache.get(s)
    return !cached || now - cached.fetchedAt > PRICE_CACHE_TTL_MS
  })

  if (toFetch.length) {
    const fetched = []
    for (let i = 0; i < toFetch.length; i += SET_CHUNK_SIZE) {
      const chunk = toFetch.slice(i, i + SET_CHUNK_SIZE)
      const { data, error } = await sb
        .from('card_prices')
        .select(`
          scryfall_id,
          set_code,
          collector_number,
          snapshot_date,
          price_regular_eur,
          price_foil_eur,
          price_regular_usd,
          price_foil_usd,
          updated_at
        `)
        .in('set_code', chunk)
        .in('snapshot_date', [today, yesterday])

      if (error) {
        console.warn('[Prices] Could not load shared card prices:', error.message)
        return { ...baseMap }
      }
      fetched.push(...(data || []))
    }

    // Group fetched rows by set_code and store in cache
    const bySet = {}
    for (const row of fetched) {
      if (!bySet[row.set_code]) bySet[row.set_code] = []
      bySet[row.set_code].push(row)
    }
    for (const s of toFetch) {
      _setRowCache.set(s, { rows: bySet[s] || [], fetchedAt: now })
    }
  }

  // Collect rows from cache for all requested set codes
  const rows = []
  for (const s of setCodes) {
    rows.push(...(_setRowCache.get(s)?.rows || []))
  }

  const currentByKey = {}
  const previousByKey = {}
  for (const row of rows) {
    const key = `${row.set_code}-${row.collector_number}`
    if (!requestedKeys.has(key)) continue
    if (row.snapshot_date === today) currentByKey[key] = row
    else if (row.snapshot_date === yesterday) previousByKey[key] = row
  }

  const merged = { ...baseMap }
  for (const key of requestedKeys) {
    const [set_code, collector_number] = key.split('-')
    const current = currentByKey[key]
    const previous = previousByKey[key]
    if (!current && !previous) continue

    const existing = merged[key] || { key, set_code, collector_number }
    const sharedPrices = current ? rowToPrices(current) : null
    const sharedPricesPrev = previous ? rowToPrices(previous) : null
    merged[key] = {
      ...existing,
      ...(sharedPrices && Object.keys(sharedPrices).length ? { prices: { ...existing.prices, ...sharedPrices }, shared_price_updated_at: current.updated_at } : {}),
      ...(sharedPricesPrev && Object.keys(sharedPricesPrev).length ? { prices_prev: { ...existing.prices_prev, ...sharedPricesPrev } } : {}),
    }
  }

  return merged
}

export async function loadCardMapWithSharedPrices(cards, { onProgress = null, cacheTtlMs } = {}) {
  if (!cards?.length) return {}

  // Shared-price pages should not trigger Scryfall price TTL refreshes.
  // We only need the cached metadata/art, plus fetches for cards missing locally.
  let map = await getInstantCache(Number.MAX_SAFE_INTEGER) || {}
  const missing = uniqueByCardKey(cards.filter(card => !map[getCardKey(card)]))
  if (missing.length) {
    const enriched = await enrichCards(missing, onProgress, cacheTtlMs)
    if (enriched) map = enriched
  } else {
    onProgress?.(100, '')
  }

  return overlaySharedCardPrices(cards, map)
}

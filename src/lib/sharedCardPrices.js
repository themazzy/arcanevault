import { sb } from './supabase'
import {
  getLocalCardPriceRowsByIds,
  getLocalCardPriceRowsBySetCodes,
  putCardPriceRows,
} from './db'
import { enrichCards, getInstantCache } from './scryfall'

const ID_CHUNK_SIZE = 400
const SET_CHUNK_SIZE = 25

// Per-set-code price row cache — avoids re-fetching card_prices on every navigation.
// Prices only change daily; 10-minute in-memory TTL is safe.
const _idChunkInflight = new Map()
const _setRowCache = new Map() // set_code -> { rows: [], fetchedAt: number }
const PRICE_CACHE_TTL_MS = 10 * 60 * 1000
const PRICE_MISS_TTL_MS = 60 * 60 * 1000

function isoDateUtc(daysOffset = 0) {
  const date = new Date()
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() + daysOffset)
  return date.toISOString().slice(0, 10)
}

function normalizeSetCode(setCode) {
  return String(setCode || '').trim().toLowerCase()
}

function normalizeCollectorNumber(collectorNumber) {
  return String(collectorNumber || '').trim()
}

function getCardKey(card) {
  const setCode = normalizeSetCode(card?.set_code)
  const collectorNumber = normalizeCollectorNumber(card?.collector_number)
  if (!setCode || !collectorNumber) return null
  return `${setCode}-${collectorNumber}`
}

function getRowKey(row) {
  const setCode = normalizeSetCode(row?.set_code)
  const collectorNumber = normalizeCollectorNumber(row?.collector_number)
  if (!setCode || !collectorNumber) return null
  return `${setCode}-${collectorNumber}`
}

function getScryfallId(card) {
  return card?.scryfall_id ? String(card.scryfall_id).trim() : null
}

async function fetchSharedPriceRowsByIds(ids, snapshotDates, now) {
  const datesKey = snapshotDates.join('|')
  const rows = []
  const localRows = await getLocalCardPriceRowsByIds(ids, snapshotDates)
  const localByIdDate = new Map(localRows.map(row => [`${row.scryfall_id}|${row.snapshot_date}`, row]))
  const idsNeedingFetch = new Set()

  for (const id of ids) {
    for (const snapshotDate of snapshotDates) {
      const cached = localByIdDate.get(`${id}|${snapshotDate}`)
      if (cached && !cached.missing) {
        rows.push(cached)
      } else if (!cached || now - (cached.cached_at || 0) > PRICE_MISS_TTL_MS) {
        idsNeedingFetch.add(id)
      }
    }
  }

  const idsToFetch = [...idsNeedingFetch].sort()
  for (let i = 0; i < idsToFetch.length; i += ID_CHUNK_SIZE) {
    const chunk = idsToFetch.slice(i, i + ID_CHUNK_SIZE)
    const chunkKey = `${datesKey}:${chunk.join(',')}`
    let promise = _idChunkInflight.get(chunkKey)

    if (!promise) {
      promise = sb
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
        .in('scryfall_id', chunk)
        .in('snapshot_date', snapshotDates)
        .then(({ data, error }) => {
          if (error) throw error
          return data || []
        })
        .finally(() => {
          _idChunkInflight.delete(chunkKey)
        })

      _idChunkInflight.set(chunkKey, promise)
    }

    const data = await promise
    rows.push(...data)

    const toCache = [...data]
    const foundByIdDate = new Set()
    for (const row of data) {
      const id = row?.scryfall_id ? String(row.scryfall_id).trim() : null
      if (!id) continue
      foundByIdDate.add(`${id}|${row.snapshot_date}`)
    }
    for (const id of chunk) {
      for (const snapshotDate of snapshotDates) {
        if (foundByIdDate.has(`${id}|${snapshotDate}`)) continue
        toCache.push({ scryfall_id: id, snapshot_date: snapshotDate, missing: true, cached_at: now })
      }
    }
    await putCardPriceRows(toCache)
  }

  return rows
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

export async function overlaySharedCardPrices(cards, baseMap = {}, { priceLookup = 'exact' } = {}) {
  const requestedKeys = new Set(cards.map(getCardKey).filter(Boolean))
  const requestedIds = [...new Set(cards.map(getScryfallId).filter(Boolean))]
  if (!requestedKeys.size) return { ...baseMap }

  const today = isoDateUtc(0)
  const yesterday = isoDateUtc(-1)
  const snapshotDates = [today, yesterday]
  const now = Date.now()
  const rows = []

  // Prefer exact print identity. Fetching whole sets can exceed the default
  // PostgREST row cap for many-set decks, which leaves some deck cards unpriced.
  if (priceLookup !== 'set' && requestedIds.length) {
    try {
      rows.push(...await fetchSharedPriceRowsByIds(requestedIds, snapshotDates, now))
    } catch (error) {
      console.warn('[Prices] Could not load shared card prices:', error.message)
      return { ...baseMap }
    }
  }

  const pricedKeys = new Set(rows.map(getRowKey).filter(Boolean))
  const fallbackCards = cards.filter(card => {
    const key = getCardKey(card)
    return key && !pricedKeys.has(key)
  })
  const setCodes = [...new Set(fallbackCards.map(card => normalizeSetCode(card?.set_code)).filter(Boolean))]

  if (setCodes.length) {
    const localSetRows = await getLocalCardPriceRowsBySetCodes(setCodes, snapshotDates)
    rows.push(...localSetRows.filter(row => !row.missing))
  }

  // Fallback for legacy rows missing scryfall_id. This path may still fetch
  // whole sets, so it is only used for keys not resolved by exact ID.
  const availableKeys = new Set(rows.map(getRowKey).filter(Boolean))
  const toFetch = setCodes.filter(s => {
    const needsSet = fallbackCards.some(card => normalizeSetCode(card?.set_code) === s && !availableKeys.has(getCardKey(card)))
    if (!needsSet) return false
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
        .in('snapshot_date', snapshotDates)

      if (error) {
        console.warn('[Prices] Could not load shared card prices:', error.message)
        return { ...baseMap }
      }
      fetched.push(...(data || []))
    }
    await putCardPriceRows(fetched)

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
  for (const s of setCodes) {
    rows.push(...(_setRowCache.get(s)?.rows || []))
  }

  const currentByKey = {}
  const previousByKey = {}
  for (const row of rows) {
    const key = getRowKey(row)
    if (!requestedKeys.has(key)) continue
    if (row.snapshot_date === today) currentByKey[key] = row
    else if (row.snapshot_date === yesterday) previousByKey[key] = row
  }

  const merged = { ...baseMap }
  for (const key of requestedKeys) {
    const [set_code, collector_number] = key.split('-')
    const current = currentByKey[key] || previousByKey[key]
    const previous = currentByKey[key] ? previousByKey[key] : null
    if (!current && !previous) continue

    const existing = merged[key] || { key, set_code, collector_number }
    const sharedPrices = rowToPrices(current)
    const sharedPricesPrev = previous ? rowToPrices(previous) : null
    merged[key] = {
      ...existing,
      ...(sharedPrices && Object.keys(sharedPrices).length ? { prices: { ...existing.prices, ...sharedPrices }, shared_price_updated_at: current.updated_at } : {}),
      ...(sharedPricesPrev && Object.keys(sharedPricesPrev).length ? { prices_prev: { ...existing.prices_prev, ...sharedPricesPrev } } : {}),
    }
  }

  return merged
}

export async function loadCardMapWithSharedPrices(cards, { onProgress = null, cacheTtlMs, priceLookup = 'exact' } = {}) {
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

  return overlaySharedCardPrices(cards, map, { priceLookup })
}

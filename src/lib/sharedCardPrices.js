import { sb } from './supabase'
import { enrichCards, getInstantCache } from './scryfall'

const SET_CHUNK_SIZE = 50

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

function rowToPrices(row) {
  return {
    eur: row.price_regular_eur,
    eur_foil: row.price_foil_eur,
    usd: row.price_regular_usd,
    usd_foil: row.price_foil_usd,
  }
}

export async function overlaySharedCardPrices(cards, baseMap = {}) {
  const requestedKeys = new Set(cards.map(getCardKey).filter(Boolean))
  const setCodes = [...new Set(cards.map(card => card?.set_code).filter(Boolean))]
  if (!requestedKeys.size || !setCodes.length) return { ...baseMap }

  const today = isoDateUtc(0)
  const yesterday = isoDateUtc(-1)
  const rows = []

  for (let i = 0; i < setCodes.length; i += SET_CHUNK_SIZE) {
    const chunk = setCodes.slice(i, i + SET_CHUNK_SIZE)
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
    rows.push(...(data || []))
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

    merged[key] = {
      ...(merged[key] || { key, set_code, collector_number }),
      ...(current?.scryfall_id ? { scryfall_id: current.scryfall_id } : {}),
      ...(current ? { prices: rowToPrices(current), shared_price_updated_at: current.updated_at } : {}),
      ...(previous ? { prices_prev: rowToPrices(previous) } : {}),
    }
  }

  return merged
}

export async function loadCardMapWithSharedPrices(cards, { onProgress = null, cacheTtlMs } = {}) {
  if (!cards?.length) return {}

  // Shared-price pages should not trigger Scryfall price TTL refreshes.
  // We only need the cached metadata/art, plus fetches for cards missing locally.
  let map = await getInstantCache(Number.MAX_SAFE_INTEGER) || {}
  const missing = cards.filter(card => !map[getCardKey(card)])
  if (missing.length) {
    const enriched = await enrichCards(missing, onProgress, cacheTtlMs)
    if (enriched) map = enriched
  } else {
    onProgress?.(100, '')
  }

  return overlaySharedCardPrices(cards, map)
}

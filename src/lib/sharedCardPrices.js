import { sb } from './supabase'
import {
  getLocalCardPriceRowsByIds,
  getLocalCardPriceRowsBySetCodes,
  putCardPriceRows,
} from './db'
import { enrichCards, getInstantCache, consumePrefetchedPriceRows } from './scryfall'
import { perfSpan } from './perf'
// runWithConcurrency moved to ./concurrency so cardPrints.js can use it too —
// importing it from here would close the cycle
// cardPrints -> sharedCardPrices -> scryfall -> cardPrints. Re-exported because
// it was part of this module's public surface.
import { runWithConcurrency, withRetry } from './concurrency'

export { runWithConcurrency }

const ID_CHUNK_SIZE = 400
const SET_CHUNK_SIZE = 25
const CHUNK_CONCURRENCY = 6

// Per-set-code price row cache — avoids re-fetching card_prices on every navigation.
// Prices only change daily; 10-minute in-memory TTL is safe.
const _idChunkInflight = new Map()
const _setRowCache = new Map() // set_code -> { rows: [], fetchedAt: number }
const PRICE_CACHE_TTL_MS = 10 * 60 * 1000
const PRICE_MISS_TTL_MS = 5 * 60 * 1000

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

async function fetchSharedPriceRowsByIds(ids, snapshotDates, now, onProgress) {
  const datesKey = snapshotDates.join('|')
  const rows = []
  // Prefer rows the hydrate worker already read off-thread this page load;
  // they cover all of today's+yesterday's rows, so the per-id logic below
  // works the same. Falls back to a main-thread IDB read when absent.
  const localRows = consumePrefetchedPriceRows(snapshotDates)
    || await getLocalCardPriceRowsByIds(ids, snapshotDates)
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
  const chunks = []
  for (let i = 0; i < idsToFetch.length; i += ID_CHUNK_SIZE) {
    chunks.push(idsToFetch.slice(i, i + ID_CHUNK_SIZE))
  }

  const fetchChunk = (chunk) => {
    const chunkKey = `${datesKey}:${chunk.join(',')}`
    let promise = _idChunkInflight.get(chunkKey)
    if (!promise) {
      // Retried per chunk. A price chunk that fails is not fatal — the caller
      // warns and returns the base map — but the failure is silent to the user,
      // who just sees cards priced "-" with no indication anything went wrong.
      // A transient blip should not cost a whole load's prices.
      promise = withRetry(async () => {
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
          .in('scryfall_id', chunk)
          .in('snapshot_date', snapshotDates)
        if (error) throw error
        return data || []
      })
        .finally(() => {
          _idChunkInflight.delete(chunkKey)
        })

      _idChunkInflight.set(chunkKey, promise)
    }
    return promise
  }

  // Fetch chunks with bounded parallelism (a cold cache on a large collection
  // is ~30 chunks — running them serially stacked up round-trip latency), and
  // write the IDB cache once at the end instead of per chunk.
  // Counted per completed chunk, so six in flight cannot report 100% while
  // five are still outstanding. A fully cached load has no chunks at all, in
  // which case the caller's stage jumps straight to done — which is correct.
  let doneChunks = 0
  const chunkResults = await runWithConcurrency(chunks, CHUNK_CONCURRENCY, async (chunk, i) => {
    const rows = await fetchChunk(chunk, i)
    doneChunks += 1
    onProgress?.((doneChunks / chunks.length) * 100)
    return rows
  })

  const toCache = []
  for (let i = 0; i < chunks.length; i++) {
    const data = chunkResults[i]
    rows.push(...data)
    toCache.push(...data)
    const foundByIdDate = new Set()
    for (const row of data) {
      const id = row?.scryfall_id ? String(row.scryfall_id).trim() : null
      if (!id) continue
      foundByIdDate.add(`${id}|${row.snapshot_date}`)
    }
    for (const id of chunks[i]) {
      for (const snapshotDate of snapshotDates) {
        if (foundByIdDate.has(`${id}|${snapshotDate}`)) continue
        toCache.push({ scryfall_id: id, snapshot_date: snapshotDate, missing: true, cached_at: now })
      }
    }
  }
  if (toCache.length) await putCardPriceRows(toCache)

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

// Daily negative cache: cards that resolved to NO shared price today. The
// set-code fallback (whole-set IDB read + Supabase fetch) is expensive and
// runs for legacy cards without a scryfall_id; without this, a handful of
// permanently-unpriced cards (tokens/promos/legacy rows) re-trigger ~1.5s of
// work on every single load. Keyed by UTC date so newly-priced cards are
// rechecked once per day.
const NO_PRICE_CACHE_KEY = 'av_no_shared_price_v1'

function loadNoPriceKeys() {
  try {
    const raw = JSON.parse(localStorage.getItem(NO_PRICE_CACHE_KEY) || 'null')
    if (raw?.date === isoDateUtc(0) && Array.isArray(raw.keys)) return new Set(raw.keys)
  } catch { /* corrupt — ignore */ }
  return new Set()
}

function saveNoPriceKeys(keys) {
  try {
    localStorage.setItem(NO_PRICE_CACHE_KEY, JSON.stringify({ date: isoDateUtc(0), keys: [...keys] }))
  } catch { /* storage full/unavailable — fine */ }
}

function rowToPrices(row) {
  const prices = {}
  if (row.price_regular_eur != null) prices.eur = row.price_regular_eur
  if (row.price_foil_eur != null) prices.eur_foil = row.price_foil_eur
  if (row.price_regular_usd != null) prices.usd = row.price_regular_usd
  if (row.price_foil_usd != null) prices.usd_foil = row.price_foil_usd
  return prices
}

export async function overlaySharedCardPrices(cards, baseMap = {}, { priceLookup = 'exact', onProgress = null } = {}) {
  const endOverlay = perfSpan('price-overlay')
  try {
    return await overlaySharedCardPricesInner(cards, baseMap, { priceLookup, onProgress })
  } finally {
    endOverlay()
  }
}

async function overlaySharedCardPricesInner(cards, baseMap = {}, { priceLookup: _priceLookup = 'exact', onProgress = null } = {}) {
  const requestedKeys = new Set(cards.map(getCardKey).filter(Boolean))
  const requestedIds = [...new Set(cards.map(getScryfallId).filter(Boolean))]
  if (!requestedKeys.size) return { ...baseMap }

  const today = isoDateUtc(0)
  const yesterday = isoDateUtc(-1)
  const snapshotDates = [today, yesterday]
  const now = Date.now()
  const rows = []

  // Prefer exact print identity. Fetching whole sets can exceed the default
  // PostgREST row cap on large sets across multiple snapshot dates, which
  // leaves valid prices out of the response.
  if (requestedIds.length) {
    try {
      rows.push(...await fetchSharedPriceRowsByIds(requestedIds, snapshotDates, now, onProgress))
    } catch (error) {
      console.warn('[Prices] Could not load shared card prices:', error.message)
      return { ...baseMap }
    }
  }

  const pricedKeys = new Set(rows.map(getRowKey).filter(Boolean))
  // The set-code fallback (whole-set IDB reads + network fetches) only helps
  // LEGACY price rows that lack a scryfall_id. Every modern price row carries
  // one, so if the id lookup above found no price, a set lookup reads the same
  // rows and finds nothing either. Restrict the fallback to cards with no
  // scryfall_id — typically zero — so we don't burn ~1s/load re-pricing the
  // handful of genuinely unpriced cards (tokens/promos) on every visit.
  const noPriceKeys = loadNoPriceKeys()
  const fallbackCards = cards.filter(card => {
    if (getScryfallId(card)) return false
    const key = getCardKey(card)
    return key && !pricedKeys.has(key) && !noPriceKeys.has(key)
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

  // Remember fallback cards that still have no shared price so we don't repeat
  // the expensive set-code lookup for them on every load today.
  if (fallbackCards.length) {
    let changed = false
    for (const card of fallbackCards) {
      const key = getCardKey(card)
      if (key && !currentByKey[key] && !previousByKey[key] && !noPriceKeys.has(key)) {
        noPriceKeys.add(key)
        changed = true
      }
    }
    if (changed) saveNoPriceKeys(noPriceKeys)
  }

  return merged
}

// Progress is split into three weighted stages, because until 2026-08-16 the
// bar reported nothing at all on the path everyone actually takes: onProgress
// reached only fetchAndMerge, the Scryfall fallback, which no longer runs once
// card_prints covers a collection. Collection renders the bar as
// `enriching && progLabel`, so an empty label meant a silent 10-15s wait.
//
// Weights approximate observed cost, so the bar does not stall in one stage and
// sprint through another: the local read is quick, metadata is the bulk of the
// network work, prices are a smaller batch on top.
const STAGE_CACHE = { from: 0, to: 8, label: 'Reading local cache' }
const STAGE_META = { from: 8, to: 72, label: 'Loading card details' }
const STAGE_PRICES = { from: 72, to: 100, label: 'Updating prices' }

/**
 * Map a stage-local 0-100 onto its slice of the overall bar.
 *
 * An inner reporter may supply its own label — fetchAndMerge counts cards
 * ("Fetching card data… (150 / 900)"), which is more informative than the
 * stage name, so it wins when present. An empty label is treated as absent
 * rather than passed through: several inner callers signal "this stage is
 * done" with `(100, '')`, and forwarding that blank would hide the bar while
 * later stages are still running.
 */
function stageReporter(onProgress, stage) {
  if (!onProgress) return null
  return (pct = 0, label = '') => {
    const clamped = Math.max(0, Math.min(100, pct))
    onProgress(Math.round(stage.from + (clamped / 100) * (stage.to - stage.from)), label || stage.label)
  }
}

export async function loadCardMapWithSharedPrices(cards, { onProgress = null, priceLookup = 'exact', requireOracle = false, onMetadataReady = null } = {}) {
  if (!cards?.length) return {}

  // Shared-price pages should not trigger Scryfall price TTL refreshes.
  // getInstantCache only reads the cache, so this never refetches — we just need
  // the cached metadata/art, plus fetches for cards missing locally.
  onProgress?.(STAGE_CACHE.from, STAGE_CACHE.label)
  let map = await getInstantCache() || {}
  onProgress?.(STAGE_CACHE.to, STAGE_CACHE.label)
  // A card needs enrichment if its entry is absent or stripped of filter-
  // critical metadata (clearScryfallCache nulls type_line/rarity/etc). The
  // deck builder additionally needs oracle_text for category inference and
  // passes `requireOracle: true` to flag partially-populated card_prints
  // entries for refetch. Other pages skip this check to avoid hammering
  // Scryfall with backfill requests for fields they don't use.
  const missing = uniqueByCardKey(cards.filter(card => {
    const entry = map[getCardKey(card)]
    if (!entry || !entry.type_line) return true
    if (requireOracle && entry.oracle_text == null) return true
    return false
  }))
  if (missing.length) {
    try {
      const enriched = await enrichCards(missing, stageReporter(onProgress, STAGE_META))
      if (enriched) map = enriched
    } catch (err) {
      // Partial enrichment is still useful — pick up whatever made it into
      // the in-memory cache and continue with price overlay so the page
      // renders. Cards still missing will retry on next load.
      console.warn('[loadCardMap] enrichment partial', err?.message || err)
      const partial = await getInstantCache()
      if (partial) map = partial
    }
  }
  // Nothing missing means the metadata stage is simply already complete; the
  // bar should advance past it rather than report 100% and vanish while the
  // price overlay is still running.
  onProgress?.(STAGE_META.to, STAGE_META.label)

  // Publish the map now, before prices. Card art is already in it — image_uri
  // comes from the metadata pass — and images do not depend on prices in any
  // way, so making them wait for the price overlay is pure dead time. Until
  // 2026-08-17 the only publish was the return value below, so on a cold cache
  // (a private tab, a new device) the grid sat imageless through the entire
  // load and every image appeared the instant the price stage finished.
  //
  // The IDB seed in idbQueryBridge covers the warm case, where the cached map
  // is available before any of this runs. This covers the cold one, which the
  // seed by definition cannot: there is nothing local to seed from.
  //
  // Costs one extra render pass over the collection. That is the deliberate
  // trade — two publishes rather than the 57 a per-batch stream would have
  // caused (see plan 1.4).
  if (onMetadataReady && Object.keys(map).length) {
    try { onMetadataReady(map) }
    catch (err) { console.warn('[loadCardMap] onMetadataReady threw', err?.message || err) }
  }

  // Announced before the work, not only from the per-chunk callback. A load
  // whose prices are entirely IDB-cached does zero chunks, and a failed price
  // fetch returns early — in both cases the per-chunk reporter never fires, so
  // the stage would silently never appear.
  onProgress?.(STAGE_PRICES.from, STAGE_PRICES.label)
  const priced = await overlaySharedCardPrices(cards, map, {
    priceLookup,
    onProgress: stageReporter(onProgress, STAGE_PRICES),
  })
  // Empty label is the signal Collection uses to hide the bar (it renders on
  // `enriching && progLabel`), so this is what dismisses it.
  onProgress?.(100, '')
  return priced
}

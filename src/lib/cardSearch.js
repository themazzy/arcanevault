/**
 * Name-based card search served from our own Supabase tables instead of
 * Scryfall's API:
 *
 * - `searchCardNames()`     — ranked one-result-per-card autocomplete via the
 *                             `search_card_names` RPC over `oracle_cards`
 *                             (complete oracle coverage, weekly-synced).
 * - `fetchPrintingsByName()`/`fetchPrintingsForNames()` — all paper printings
 *                             of a name from `card_prints` (kept fresh by the
 *                             daily price-sync workflow), newest first, with
 *                             shared daily prices attached.
 *
 * Every entry point falls back to the equivalent Scryfall query when our
 * tables error out or return nothing (covers flavor names, brand-new cards
 * that beat the daily sync, and Supabase outages), so callers can treat the
 * results as ordinary Scryfall card objects either way. The payoff of the
 * primary path: ~EU-local latency, no 120 ms request pacing, no 429s, and
 * single-query batch lookups.
 */
import { sb } from './supabase'
import { sfGet, scryfallImageAtSize } from './scryfall'
import { sortByNameRelevance } from './scryfallSearch'

const SF = 'https://api.scryfall.com'
// PostgREST responses are hard-capped at 1000 rows; only the five basic lands
// have more printings than that, and their newest 1000 still cover every set
// a user can realistically pick.
const PRINTINGS_ROW_CAP = 1000
const PRICE_ID_CHUNK = 200
const SCRYFALL_PAGE_CAP = 20

const PRINT_COLUMNS = [
  'scryfall_id', 'oracle_id', 'name', 'set_code', 'collector_number', 'lang',
  'type_line', 'mana_cost', 'cmc', 'color_identity', 'image_uri', 'art_crop_uri',
  'rarity', 'set_name', 'artist', 'power', 'toughness',
  'produced_mana', 'keywords', 'colors', 'card_faces', 'oracle_text',
  'released_at', 'edhrec_rank', 'finishes',
].join(',')

function isoDateUtc(daysOffset = 0) {
  const date = new Date()
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() + daysOffset)
  return date.toISOString().slice(0, 10)
}

// ── Row → Scryfall-shaped card object ────────────────────────────────────────

export function buildImageUris(imageUri, artCropUri) {
  if (!imageUri && !artCropUri) return null
  const normal = imageUri || null
  return {
    small: normal ? scryfallImageAtSize(normal, 'small') : null,
    normal,
    large: normal ? scryfallImageAtSize(normal, 'large') : null,
    art_crop: artCropUri || (normal ? scryfallImageAtSize(normal, 'art_crop') : null),
  }
}

// Works for both oracle_cards rows (from the search RPC) and card_prints rows —
// they share column names. Only fields the app's card consumers actually read
// are mapped; anything else stays on the Scryfall fallback path.
export function rowToCard(row) {
  if (!row?.name) return null
  return {
    object: 'card',
    id: row.scryfall_id || null,
    oracle_id: row.oracle_id || null,
    name: row.name,
    set: row.set_code || null,
    set_name: row.set_name || null,
    collector_number: row.collector_number || null,
    lang: row.lang || 'en',
    rarity: row.rarity || null,
    released_at: row.released_at || null,
    type_line: row.type_line || null,
    mana_cost: row.mana_cost || null,
    cmc: row.cmc ?? null,
    color_identity: row.color_identity || [],
    colors: row.colors || [],
    keywords: row.keywords || [],
    produced_mana: row.produced_mana || [],
    power: row.power ?? null,
    toughness: row.toughness ?? null,
    oracle_text: row.oracle_text || null,
    card_faces: row.card_faces || null,
    artist: row.artist || null,
    edhrec_rank: row.edhrec_rank ?? null,
    finishes: row.finishes || [],
    legalities: row.legalities || null,
    image_uris: buildImageUris(row.image_uri, row.art_crop_uri),
  }
}

// ── Shared daily prices (card_prices) ────────────────────────────────────────

export function priceRowToPrices(row) {
  const prices = {}
  if (row.price_regular_eur != null) prices.eur = row.price_regular_eur
  if (row.price_foil_eur != null) prices.eur_foil = row.price_foil_eur
  if (row.price_regular_usd != null) prices.usd = row.price_regular_usd
  if (row.price_foil_usd != null) prices.usd_foil = row.price_foil_usd
  return prices
}

// Pure merge step, exported for tests: today's row wins, yesterday's becomes
// prices_prev (mirrors the overlay semantics in sharedCardPrices.js).
export function mergePriceRows(cards, rows, today) {
  const current = new Map()
  const previous = new Map()
  for (const row of rows || []) {
    if (!row?.scryfall_id) continue
    if (row.snapshot_date === today) current.set(row.scryfall_id, row)
    else previous.set(row.scryfall_id, row)
  }
  return cards.map(card => {
    const cur = current.get(card.id) || previous.get(card.id)
    if (!cur) return card
    const prev = current.get(card.id) ? previous.get(card.id) : null
    return {
      ...card,
      prices: priceRowToPrices(cur),
      ...(prev ? { prices_prev: priceRowToPrices(prev) } : {}),
    }
  })
}

async function attachSharedPrices(cards) {
  const ids = [...new Set(cards.map(card => card.id).filter(Boolean))]
  if (!ids.length) return cards
  const today = isoDateUtc(0)
  const yesterday = isoDateUtc(-1)
  const rows = []
  try {
    for (let i = 0; i < ids.length; i += PRICE_ID_CHUNK) {
      const { data, error } = await sb
        .from('card_prices')
        .select('scryfall_id,snapshot_date,price_regular_eur,price_foil_eur,price_regular_usd,price_foil_usd')
        .in('scryfall_id', ids.slice(i, i + PRICE_ID_CHUNK))
        .in('snapshot_date', [today, yesterday])
      if (error) throw error
      rows.push(...(data || []))
    }
  } catch {
    return cards // prices are best-effort; cards without them still render
  }
  return mergePriceRows(cards, rows, today)
}

// ── Name search (autocomplete / manual search) ───────────────────────────────

/**
 * Ranked card-name search: one result per card, exact match first, then
 * prefix, then fuzzy. Returns Scryfall-shaped card objects.
 */
export async function searchCardNames(term, { limit = 20 } = {}) {
  const q = (term || '').trim()
  if (q.length < 2) return []
  try {
    const { data, error } = await sb.rpc('search_card_names', {
      search_term: q,
      max_results: limit,
    })
    if (error) throw error
    const cards = (data || []).map(rowToCard).filter(Boolean)
    if (cards.length) return cards
  } catch { /* fall back to Scryfall */ }
  return searchCardNamesScryfall(q, limit)
}

async function searchCardNamesScryfall(q, limit) {
  try {
    const data = await sfGet(`${SF}/cards/search?q=${encodeURIComponent(q)}&unique=cards&order=name`)
    return sortByNameRelevance(data?.data || [], q).slice(0, limit)
  } catch {
    return []
  }
}

// ── Printings ────────────────────────────────────────────────────────────────

async function queryPrintRows(builderFn) {
  const query = builderFn(
    sb.from('card_prints')
      .select(PRINT_COLUMNS)
      .not('scryfall_id', 'is', null)
      .or('lang.eq.en,lang.is.null')
      .order('released_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(PRINTINGS_ROW_CAP)
  )
  const { data, error } = await query
  if (error) throw error
  return data || []
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, ch => `\\${ch}`)
}

/**
 * All paper printings of an exact card name, newest first, with shared daily
 * prices attached (pass `withPrices: false` to skip the extra query).
 * `onPartial(cards)` streams incremental results on the paginated Scryfall
 * fallback path.
 */
export async function fetchPrintingsByName(name, { withPrices = true, onPartial = null } = {}) {
  const cardName = (name || '').trim()
  if (!cardName) return []
  try {
    let rows = await queryPrintRows(query => query.eq('name', cardName))
    if (!rows.length && !cardName.includes('//')) {
      // card_prints stores DFC names as the full "Front // Back"; a bare
      // front-face name (e.g. from the scanner) matches as a prefix, and this
      // catches every back-face variant of that front face at once.
      rows = await queryPrintRows(query => query.like('name', `${escapeLike(cardName)} // %`))
    }
    if (rows.length) {
      let cards = rows.map(rowToCard).filter(Boolean)
      if (withPrices) cards = await attachSharedPrices(cards)
      onPartial?.(cards)
      return cards
    }
  } catch { /* fall back to Scryfall */ }
  return fetchPrintingsScryfall(cardName, onPartial)
}

/**
 * Printings for several exact names in one query (Trading want-list search).
 * Results are newest-first within each name; group client-side.
 */
export async function fetchPrintingsForNames(names, { withPrices = true } = {}) {
  const wanted = [...new Set((names || []).map(n => (n || '').trim()).filter(Boolean))]
  if (!wanted.length) return []
  const rows = await queryPrintRows(query => query.in('name', wanted))
  let cards = rows.map(rowToCard).filter(Boolean)
  if (withPrices && cards.length) cards = await attachSharedPrices(cards)
  return cards
}

async function fetchPrintingsScryfall(name, onPartial) {
  try {
    const q = encodeURIComponent(`!"${name}" not:digital`)
    let url = `${SF}/cards/search?q=${q}&unique=prints&order=released&dir=desc`
    const all = []
    // Scryfall paginates at 175/page; heavily-reprinted cards (basic lands)
    // need multiple pages so older sets stay findable.
    for (let page = 0; page < SCRYFALL_PAGE_CAP && url; page++) {
      const data = await sfGet(url)
      if (!data?.data) break
      all.push(...data.data)
      onPartial?.([...all])
      url = data.has_more ? data.next_page : null
    }
    return all
  } catch {
    return []
  }
}

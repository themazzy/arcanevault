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
// Page explicitly because PostgREST responses are capped at 1000 rows and the
// heavily reprinted basics exceed that limit.
const PRINTINGS_PAGE_SIZE = 1000
// Printing pickers render the newest page first and stream the rest in behind
// it. Basics are the reason: ~850 English printings each (Mountain 851, Forest
// 835), ~600 KB of rows, where the picker's own viewport shows about a dozen.
const PRINTINGS_FIRST_PAGE_SIZE = 60
const PRINTINGS_NAME_CHUNK = 40
const DISPLAY_PRINTING_NAME_CHUNK = 100
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

/** Map the exact print selected by get_deck_builder_display_printings(). */
export function displayPrintingRowToCard(row) {
  const card = rowToCard(row)
  if (!card) return null
  const parsedPrice = row.selected_price == null ? null : Number(row.selected_price)
  const displayPrice = Number.isFinite(parsedPrice) && parsedPrice > 0 ? parsedPrice : null
  return {
    ...card,
    requested_name: row.requested_name || row.name,
    display_price: displayPrice,
    display_foil: displayPrice == null ? null : row.selected_foil === true,
    display_finish: displayPrice == null ? null : (row.selected_foil === true ? 'Foil' : 'Non-foil'),
  }
}

/**
 * Overlay only print-specific display fields onto oracle metadata. This keeps
 * legality/type data from the oracle row while guaranteeing that image, set,
 * finish, and displayed price all describe one exact English printing.
 */
export function mergeDisplayPrinting(baseCard, displayCard) {
  if (!displayCard) return baseCard
  return {
    ...(baseCard || {}),
    id: displayCard.id || baseCard?.id || null,
    oracle_id: displayCard.oracle_id || baseCard?.oracle_id || null,
    name: baseCard?.name || displayCard.name,
    set: displayCard.set,
    collector_number: displayCard.collector_number,
    lang: displayCard.lang,
    released_at: displayCard.released_at,
    image_uris: displayCard.image_uris || baseCard?.image_uris || null,
    // oracle_cards.card_faces belongs to its representative printing. Keeping
    // it here would make CardDetail prefer that artwork over the exact display
    // printing's top-level image until the full print finishes loading.
    card_faces: displayCard.card_faces || null,
    display_price: displayCard.display_price,
    display_foil: displayCard.display_foil,
    display_finish: displayCard.display_finish,
  }
}

/**
 * Resolve exact English display printings entirely from Supabase. There is no
 * Scryfall fallback: these rows drive price/image pairing and must come from
 * the same stored catalogue snapshot.
 */
export async function fetchDeckBuilderDisplayPrintings(names, { priceSource = 'cardmarket_trend' } = {}) {
  const wanted = [...new Set((names || []).map(name => (name || '').trim()).filter(Boolean))]
  if (!wanted.length) return []
  const cards = []
  for (let i = 0; i < wanted.length; i += DISPLAY_PRINTING_NAME_CHUNK) {
    const { data, error } = await sb.rpc('get_deck_builder_display_printings', {
      card_names: wanted.slice(i, i + DISPLAY_PRINTING_NAME_CHUNK),
      price_source: priceSource,
    })
    if (error) throw error
    cards.push(...(data || []).map(displayPrintingRowToCard).filter(Boolean))
  }
  return cards
}

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
  const chunks = []
  for (let i = 0; i < ids.length; i += PRICE_ID_CHUNK) chunks.push(ids.slice(i, i + PRICE_ID_CHUNK))
  const rows = []
  try {
    // Issued together rather than one after another: a basic land's ~850 ids
    // used to mean five serialized round trips before anything could render.
    const results = await Promise.all(chunks.map(chunk => sb
      .from('card_prices')
      .select('scryfall_id,snapshot_date,price_regular_eur,price_foil_eur,price_regular_usd,price_foil_usd')
      .in('scryfall_id', chunk)
      .in('snapshot_date', [today, yesterday])))
    for (const { data, error } of results) {
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

// ── Art search (background-art pickers) ──────────────────────────────────────

/**
 * The `search_card_art` RPC needs three characters before the trigram index on
 * card_prints.name can produce candidates; a shorter term degrades into a seq
 * scan over ~113k rows. Callers gate their input on this so the round trip is
 * never made for a term the server would reject anyway.
 */
export const MIN_ART_SEARCH_LENGTH = 3

/** One selectable artwork. `url` is a Scryfall `art_crop` (424×248-ish). */
export function artRowToOption(row) {
  if (!row?.art_crop_uri) return null
  const isBack = row.face_index === 1
  return {
    key: `${row.scryfall_id || row.art_crop_uri}:${row.face_index || 0}`,
    url: row.art_crop_uri,
    cardName: row.card_name || '',
    faceName: row.face_name || row.card_name || '',
    isBack,
    setCode: row.set_code || null,
    setName: row.set_name || null,
    collectorNumber: row.collector_number || null,
    artist: row.artist || null,
  }
}

/**
 * Distinct artworks matching a card name, served entirely from `card_prints`.
 * Deliberately has no Scryfall fallback: `cards/search` answers 404 for a name
 * with no matches, which the browser logs as a failed request on every
 * keystroke of a typo, and it hides double-faced cards behind per-face
 * `image_uris`. Both are the reasons this moved to Supabase — see the RPC.
 *
 * Genuine two-sided prints contribute a second option for the back-face art.
 * Throws on a Supabase error so callers can show a real message.
 */
export async function searchCardArt(term, { limit = 24 } = {}) {
  const q = (term || '').trim()
  if (q.length < MIN_ART_SEARCH_LENGTH) return []
  const { data, error } = await sb.rpc('search_card_art', {
    search_term: q,
    max_results: limit,
  })
  if (error) throw error
  return (data || []).map(artRowToOption).filter(Boolean)
}

// ── Printings ────────────────────────────────────────────────────────────────

function printRowsQuery(language) {
  let query = sb.from('card_prints')
    .select(PRINT_COLUMNS)
    .not('scryfall_id', 'is', null)
  if (language !== 'all') query = query.or('lang.eq.en,lang.is.null')
  return query
    .order('released_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .order('scryfall_id', { ascending: true })
}

/**
 * `limit` fetches exactly one bounded page; otherwise rows are paged from
 * `from` until the catalogue is exhausted.
 */
async function queryPrintRows(builderFn, { language = 'english', from = 0, limit = null } = {}) {
  if (limit != null) {
    const { data, error } = await builderFn(printRowsQuery(language))
      .range(from, from + limit - 1)
    if (error) throw error
    return data || []
  }
  const rows = []
  for (let offset = from; ; offset += PRINTINGS_PAGE_SIZE) {
    const query = builderFn(printRowsQuery(language))
      .range(offset, offset + PRINTINGS_PAGE_SIZE - 1)
    const { data, error } = await query
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < PRINTINGS_PAGE_SIZE) break
  }
  return rows
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, ch => `\\${ch}`)
}

async function toPricedCards(rows, withPrices) {
  const cards = rows.map(rowToCard).filter(Boolean)
  if (!withPrices || !cards.length) return cards
  return attachSharedPrices(cards)
}

/**
 * All paper printings of an exact card name, newest first, with shared daily
 * prices attached (pass `withPrices: false` to skip the extra query).
 *
 * The promise still resolves with the *complete* list, so callers that ignore
 * `onPartial` are unaffected. `onPartial(cards)` fires early with the newest
 * page (and again per page on the Scryfall fallback), which is what lets a
 * picker paint a basic land's newest printings without waiting on the other
 * ~800.
 */
export async function fetchPrintingsByName(name, {
  withPrices = true,
  onPartial = null,
  language = 'english',
  firstPageSize = PRINTINGS_FIRST_PAGE_SIZE,
} = {}) {
  const cardName = (name || '').trim()
  if (!cardName) return []
  try {
    let build = query => query.eq('name', cardName)
    let head = await queryPrintRows(build, { language, limit: firstPageSize })
    if (!head.length && !cardName.includes('//')) {
      // card_prints stores DFC names as the full "Front // Back"; a bare
      // front-face name (e.g. from the scanner) matches as a prefix, and this
      // catches every back-face variant of that front face at once.
      build = query => query.like('name', `${escapeLike(cardName)} // %`)
      head = await queryPrintRows(build, { language, limit: firstPageSize })
    }
    if (head.length) {
      const headCards = await toPricedCards(head, withPrices)
      onPartial?.(headCards)
      // A short first page is already the whole list — no tail request at all,
      // which is every card that isn't heavily reprinted.
      if (head.length < firstPageSize) return headCards
      try {
        const tail = await queryPrintRows(build, { language, from: head.length })
        if (tail.length) return headCards.concat(await toPricedCards(tail, withPrices))
      } catch { /* keep the page already in hand rather than losing everything */ }
      return headCards
    }
  } catch { /* fall back to Scryfall */ }
  return fetchPrintingsScryfall(cardName, onPartial, language)
}

/**
 * Printings for several exact names in one query (Trading want-list search).
 * Results are newest-first within each name; group client-side.
 */
export async function fetchPrintingsForNames(names, { withPrices = true, language = 'english' } = {}) {
  const wanted = [...new Set((names || []).map(n => (n || '').trim()).filter(Boolean))]
  if (!wanted.length) return []
  const rows = []
  try {
    for (let i = 0; i < wanted.length; i += PRINTINGS_NAME_CHUNK) {
      rows.push(...await queryPrintRows(
        query => query.in('name', wanted.slice(i, i + PRINTINGS_NAME_CHUNK)),
        { language },
      ))
    }
  } catch {
    rows.length = 0
  }

  let cards = rows.map(rowToCard).filter(Boolean)
  if (withPrices && cards.length) cards = await attachSharedPrices(cards)

  for (const name of wanted) {
    if (filterScryfallPrintingsByRequestedName(cards, name).length) continue
    cards.push(...await fetchPrintingsByName(name, { withPrices, language }))
  }
  const unique = new Map()
  for (const card of cards) {
    const key = card?.id || `${card?.name || ''}|${card?.set || ''}|${card?.collector_number || ''}|${card?.lang || ''}`
    if (!unique.has(key)) unique.set(key, card)
  }
  return [...unique.values()]
}

function filterScryfallPrintingsByRequestedName(cards, name) {
  const exact = (cards || []).filter(card => card?.name === name)
  if (exact.length || String(name).includes('//')) return exact
  return (cards || []).filter(card => card?.name?.startsWith(`${name} //`))
}

async function fetchPrintingsScryfall(name, onPartial, language = 'english') {
  try {
    const languageFilter = language === 'all' ? '' : ' lang:en'
    const q = encodeURIComponent(`!"${name}" game:paper${languageFilter}`)
    let url = `${SF}/cards/search?q=${q}&unique=prints&order=released&dir=desc`
    const all = []
    // Scryfall paginates at 175/page; heavily-reprinted cards (basic lands)
    // need multiple pages so older sets stay findable.
    for (let page = 0; page < SCRYFALL_PAGE_CAP && url; page++) {
      const data = await sfGet(url)
      if (!data?.data) break
      all.push(...data.data)
      onPartial?.(filterScryfallPrintingsByRequestedName(all, name))
      url = data.has_more ? data.next_page : null
    }
    return filterScryfallPrintingsByRequestedName(all, name)
  } catch {
    return []
  }
}

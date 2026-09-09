import { sfGet, sfGetOrStatus, getPrice } from './scryfall'
import { sb } from './supabase'

// Release calendar and spoiler feed behind /sets and /sets/:code.
//
// Sourced live from Scryfall rather than our own card_prints / oracle_cards
// tables, and deliberately so: those hold *released* prints, and a spoiler page
// is by definition about cards that do not exist there yet. Scryfall adds each
// card to its unreleased set as it is previewed, so `e:<code>` is the feed —
// no separate spoiler source, and no ingestion job of our own to keep alive.

const SETS_URL = 'https://api.scryfall.com/sets'
const SEARCH_URL = 'https://api.scryfall.com/cards/search'

// Set types a collector plans around. Token, memorabilia, art-series, promo and
// minigame sets share a release date with their parent product and would double
// the length of the calendar without adding a card anyone can buy or play.
export const UPCOMING_SET_TYPES = new Set([
  'expansion',
  'core',
  'masters',
  'draft_innovation',
  'commander',
  'starter_deck',
])

export const SET_TYPE_LABELS = {
  expansion: 'Expansion',
  core: 'Core Set',
  masters: 'Masters',
  draft_innovation: 'Draft Innovation',
  commander: 'Commander',
  starter_deck: 'Starter Deck',
}

export function setTypeLabel(type) {
  if (SET_TYPE_LABELS[type]) return SET_TYPE_LABELS[type]
  return String(type || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

export function selectUpcomingSets(sets, today) {
  return (sets || [])
    .filter(set => set.released_at > today && UPCOMING_SET_TYPES.has(set.set_type))
    .sort((a, b) => a.released_at.localeCompare(b.released_at))
}

// Companion products (Star Trek Commander alongside Star Trek) carry
// `parent_set_code` and land on the same day. Nesting them under the parent
// keeps one release = one row; a child whose parent is *not* upcoming (a
// Commander deck attached to an already-released set) stays top-level rather
// than disappearing from the calendar entirely.
export function groupSetsByParent(sets) {
  const list = sets || []
  const codes = new Set(list.map(s => s.code))
  const childrenByParent = new Map()
  const roots = []
  for (const set of list) {
    const parent = set.parent_set_code
    if (parent && parent !== set.code && codes.has(parent)) {
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, [])
      childrenByParent.get(parent).push(set)
    } else {
      roots.push(set)
    }
  }
  return roots.map(set => ({ ...set, children: childrenByParent.get(set.code) || [] }))
}

// Dates are UTC day numbers, never local Date arithmetic: a local-midnight
// subtraction repeats or skips a day across a DST boundary, which is exactly
// the kind of off-by-one a visible countdown makes obvious.
function utcDayNumber(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''))
  if (!m) return null
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000)
}

export function daysUntil(releasedAt, today) {
  const a = utcDayNumber(releasedAt)
  const b = utcDayNumber(today)
  if (a == null || b == null) return null
  return a - b
}

export function countdownLabel(days) {
  if (days == null) return ''
  if (days < 0) return 'Released'
  if (days === 0) return 'Out today'
  if (days === 1) return 'Tomorrow'
  if (days < 7) return `In ${days} days`
  if (days < 60) {
    const weeks = Math.round(days / 7)
    return `In ${weeks} week${weeks === 1 ? '' : 's'}`
  }
  return `In ${Math.round(days / 30)} months`
}

export function formatReleaseDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''))
  if (!m) return ''
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    .toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Card shape ───────────────────────────────────────────────────────────────

export const COLOR_FILTERS = [
  { id: 'W', label: 'White' },
  { id: 'U', label: 'Blue' },
  { id: 'B', label: 'Black' },
  { id: 'R', label: 'Red' },
  { id: 'G', label: 'Green' },
  { id: 'M', label: 'Multicolor' },
  { id: 'C', label: 'Colorless' },
]

// Colour identity, not `colors`: it is the question a deckbuilder actually asks
// of a spoiler ("can this go in my deck"), and it is the only one that answers
// correctly for lands and for cards whose abilities cost off-colour mana.
export function cardColorBuckets(card) {
  const identity = card?.color_identity || []
  const buckets = new Set(identity)
  if (identity.length === 0) buckets.add('C')
  if (identity.length >= 2) buckets.add('M')
  return buckets
}

// Ordered most- to least-specific: an Artifact Creature is a creature, and a
// Land Creature is a creature, so Creature has to win over both.
const TYPE_ORDER = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Land']

export function frontTypeLine(card) {
  const line = card?.type_line || card?.card_faces?.[0]?.type_line || ''
  return String(line).split('//')[0]
}

export function cardPrimaryType(card) {
  const line = frontTypeLine(card)
  for (const type of TYPE_ORDER) if (line.includes(type)) return type
  return 'Other'
}

const RARITY_ORDER = { mythic: 0, rare: 1, uncommon: 2, common: 3, special: 4, bonus: 5 }
export const RARITIES = ['mythic', 'rare', 'uncommon', 'common']

export function cardOracleText(card) {
  if (card?.oracle_text) return card.oracle_text
  const faces = Array.isArray(card?.card_faces) ? card.card_faces.map(f => f.oracle_text).filter(Boolean) : []
  return faces.join('\n')
}

// ── Set summary ──────────────────────────────────────────────────────────────

export function summarizeSpoilers(cards) {
  const list = cards || []
  const rarity = {}
  const colors = new Map(COLOR_FILTERS.map(c => [c.id, 0]))
  const types = new Map()
  for (const card of list) {
    const r = card.rarity || 'common'
    rarity[r] = (rarity[r] || 0) + 1
    for (const bucket of cardColorBuckets(card)) {
      colors.set(bucket, (colors.get(bucket) || 0) + 1)
    }
    const type = cardPrimaryType(card)
    types.set(type, (types.get(type) || 0) + 1)
  }
  return {
    total: list.length,
    rarity,
    colors: COLOR_FILTERS.map(c => ({ ...c, count: colors.get(c.id) || 0 })),
    types: [...types.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
  }
}

// Mechanics come out of Scryfall's own `keywords` array rather than a parse of
// our own: it already covers keyword abilities, keyword actions and ability
// words, and it is maintained per printing, so a mechanic introduced next year
// needs no code change here.
export function extractMechanics(cards) {
  const counts = new Map()
  for (const card of cards || []) {
    for (const keyword of card.keywords || []) {
      counts.set(keyword, (counts.get(keyword) || 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

// A mechanic new to a set is printed with reminder text on the cards that carry
// it, so the set's own spoilers explain it — no glossary of ours to maintain,
// and the wording is Wizards'.
//
// Pairing a keyword with the right parenthetical is the whole difficulty, and
// distance alone gets it wrong: "Vigilance, ward {2} (Whenever this creature
// becomes the target...)" hands Vigilance the text belonging to Ward. Two
// narrower rules are used instead, and each was checked against a real set:
//
//  1. The reminder directly follows the keyword and at most its own argument
//     ("Station (…", "Kicker {1}{U} (…", "surveil 1. (…", "Investigate. (…").
//  2. Otherwise a looser gap is allowed only when the reminder text restates
//     the keyword, which is how ability words read ("Whenever you face a
//     dilemma, draw a card. (You face a dilemma as you choose…)"). Ward's text
//     never says "vigilance", so the bad pairing above still cannot happen.
const LOOSE_REMINDER_GAP = 60

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function mechanicReminderText(cards, keyword) {
  const name = String(keyword || '').trim()
  if (!name) return null
  const escaped = escapeRegExp(name)
  // Keyword, optionally its own argument (mana symbols or a number), optionally
  // one piece of trailing punctuation, then the reminder.
  const adjacent = new RegExp(
    `\\b${escaped}\\b(?:\\s+(?:\\{[^}]*\\}|\\d+)+)?\\s*[.,;:—-]?\\s*\\(([^)]+)\\)`, 'i')
  const nearby = new RegExp(`\\b${escaped}\\b[^(\\n]{0,${LOOSE_REMINDER_GAP}}\\(([^)]+)\\)`, 'i')
  const mentionsKeyword = new RegExp(`\\b${escaped}\\b`, 'i')

  const texts = (cards || []).map(cardOracleText)
  for (const text of texts) {
    const match = adjacent.exec(text)
    if (match) return match[1].trim()
  }
  for (const text of texts) {
    const match = nearby.exec(text)
    if (match && mentionsKeyword.test(match[1])) return match[1].trim()
  }
  return null
}

// ── Prices ───────────────────────────────────────────────────────────────────

// Prices come from our own `card_prices`, not from the Scryfall payload (which
// `slimSpoilerCard` drops): it is the same shared daily snapshot the rest of the
// app prices against, so a card cannot show one number here and another in the
// collection. One query per set — `card_prices` is indexed by set_code and this
// is the same shape sharedCardPrices.js already uses for its fallback path.
//
// Coverage is really a released-set feature. Measured 2026-09-09: The Hobbit
// (released) 321/321 priced, Star Trek (Nov) 9/135 — preorder prices barely
// exist in any source, so an unpriced spoiler is normal, not a failure.

function snapshotDatesUtc() {
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const yesterday = new Date(today)
  yesterday.setUTCDate(yesterday.getUTCDate() - 1)
  return [today.toISOString().slice(0, 10), yesterday.toISOString().slice(0, 10)]
}

/**
 * Folds price rows into the Scryfall-shaped `prices` object the app's
 * `getPrice`/`formatPrice` already read, so nothing downstream needs a second
 * way to read a price. Today's snapshot wins over yesterday's.
 */
export function buildPriceMap(rows, [today] = snapshotDatesUtc()) {
  const byId = new Map()
  for (const row of rows || []) {
    if (!row?.scryfall_id) continue
    const existing = byId.get(row.scryfall_id)
    // Rows arrive for both snapshot dates; keep today's, else whatever we have.
    if (existing && existing.snapshot_date === today) continue
    byId.set(row.scryfall_id, row)
  }
  const prices = new Map()
  for (const [id, row] of byId) {
    prices.set(id, {
      eur: row.price_regular_eur != null ? String(row.price_regular_eur) : null,
      usd: row.price_regular_usd != null ? String(row.price_regular_usd) : null,
      eur_foil: row.price_foil_eur != null ? String(row.price_foil_eur) : null,
      usd_foil: row.price_foil_usd != null ? String(row.price_foil_usd) : null,
    })
  }
  return prices
}

/** Attaches prices without mutating the cached card objects. */
export function attachPrices(cards, priceMap) {
  if (!priceMap?.size) return cards || []
  return (cards || []).map(card => {
    const prices = priceMap.get(card.id)
    return prices ? { ...card, prices } : card
  })
}

export async function fetchSetPrices(setCode) {
  const code = String(setCode || '').trim().toLowerCase()
  if (!code) return new Map()
  const snapshotDates = snapshotDatesUtc()
  const { data, error } = await sb
    .from('card_prices')
    .select('scryfall_id,snapshot_date,price_regular_eur,price_foil_eur,price_regular_usd,price_foil_usd')
    .eq('set_code', code)
    .in('snapshot_date', snapshotDates)
  // Prices are an enhancement — a set with none still browses fine.
  if (error) {
    console.warn('[sets] Could not load prices for', code, error.message)
    return new Map()
  }
  return buildPriceMap(data, snapshotDates)
}

// ── Filter + sort ────────────────────────────────────────────────────────────

export const EMPTY_SPOILER_FILTERS = { search: '', rarity: '', color: '', type: '', mechanic: '' }

export function filterSpoilerCards(cards, filters = {}) {
  const { search = '', rarity = '', color = '', type = '', mechanic = '' } = filters
  const needle = search.trim().toLowerCase()
  return (cards || []).filter(card => {
    if (rarity && card.rarity !== rarity) return false
    if (color && !cardColorBuckets(card).has(color)) return false
    if (type && cardPrimaryType(card) !== type) return false
    if (mechanic && !(card.keywords || []).includes(mechanic)) return false
    if (needle) {
      const haystack = `${card.name || ''}\n${card.type_line || ''}\n${cardOracleText(card)}`.toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })
}

export const SPOILER_SORTS = [
  { id: 'spoiled', label: 'Recently spoiled' },
  { id: 'name', label: 'Name' },
  { id: 'priceDesc', label: 'Price — high to low' },
  { id: 'priceAsc', label: 'Price — low to high' },
  { id: 'cmc', label: 'Mana value' },
  { id: 'rarity', label: 'Rarity' },
  { id: 'number', label: 'Card number' },
]

function collectorNumberValue(card) {
  const n = Number.parseInt(String(card?.collector_number || ''), 10)
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER
}

export function sortSpoilerCards(cards, sortId, priceSource = 'cardmarket_trend') {
  const list = [...(cards || [])]
  // 'spoiled' is the order Scryfall already returned (order=spoiled), so it is
  // a copy rather than a re-sort — most cards carry no per-card preview date to
  // sort on locally.
  if (!sortId || sortId === 'spoiled') return list
  const byName = (a, b) => (a.name || '').localeCompare(b.name || '')
  if (sortId === 'name') return list.sort(byName)
  if (sortId === 'cmc') return list.sort((a, b) => (a.cmc ?? 0) - (b.cmc ?? 0) || byName(a, b))
  if (sortId === 'rarity') {
    return list.sort((a, b) => (RARITY_ORDER[a.rarity] ?? 9) - (RARITY_ORDER[b.rarity] ?? 9) || byName(a, b))
  }
  if (sortId === 'number') {
    return list.sort((a, b) => collectorNumberValue(a) - collectorNumberValue(b) || byName(a, b))
  }
  if (sortId === 'priceDesc' || sortId === 'priceAsc') {
    // An unpriced card sinks to the bottom of *both* directions rather than
    // being treated as 0. On an unreleased set most cards have no price yet, so
    // "cheapest first" would otherwise be a list of unknowns with the actual
    // cheap cards buried under them.
    const desc = sortId === 'priceDesc'
    return list.sort((a, b) => {
      const pa = getPrice(a, false, { price_source: priceSource })
      const pb = getPrice(b, false, { price_source: priceSource })
      if (pa == null && pb == null) return byName(a, b)
      if (pa == null) return 1
      if (pb == null) return -1
      return (desc ? pb - pa : pa - pb) || byName(a, b)
    })
  }
  return list
}

// ── Fetchers ─────────────────────────────────────────────────────────────────

const SETS_CACHE_KEY = 'dl_set_calendar_v1'
const SETS_CACHE_TTL = 6 * 60 * 60 * 1000

function readCache(storage, key, ttl) {
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const { ts, data } = JSON.parse(raw)
    if (!ts || Date.now() - ts > ttl) return null
    return data
  } catch { return null }
}

function writeCache(storage, key, data) {
  try { storage.setItem(key, JSON.stringify({ ts: Date.now(), data })) } catch { /* quota */ }
}

export async function fetchAllSets({ force = false } = {}) {
  if (!force) {
    const cached = readCache(localStorage, SETS_CACHE_KEY, SETS_CACHE_TTL)
    if (cached) return cached
  }
  const json = await sfGet(SETS_URL)
  const data = json?.data || []
  if (data.length) writeCache(localStorage, SETS_CACHE_KEY, data)
  return data
}

export async function fetchUpcomingSets(today = todayIso()) {
  return selectUpcomingSets(await fetchAllSets(), today)
}

export async function fetchSetByCode(code) {
  const wanted = String(code || '').toLowerCase()
  if (!wanted) return null
  const sets = await fetchAllSets()
  return sets.find(s => (s.code || '').toLowerCase() === wanted) || null
}

// Only the fields the spoiler grid, the card detail and the wishlist write
// actually read. A full Scryfall card is ~6 KB — a 500-card set would not
// survive a sessionStorage round-trip, and nothing here needs rulings, prices,
// legalities or purchase URIs. `image_uris` keeps Scryfall's own shape because
// the wishlist path (addMissingToWishlist -> buildCardPrintPayload) reads it.
export function slimSpoilerCard(card) {
  if (!card) return null
  const faces = Array.isArray(card.card_faces) ? card.card_faces.map(f => ({
    name: f.name || null,
    mana_cost: f.mana_cost || null,
    type_line: f.type_line || null,
    oracle_text: f.oracle_text || null,
    flavor_text: f.flavor_text || null,
    power: f.power ?? null,
    toughness: f.toughness ?? null,
    loyalty: f.loyalty ?? null,
    image_uris: f.image_uris ? {
      small: f.image_uris.small || null,
      normal: f.image_uris.normal || null,
      art_crop: f.image_uris.art_crop || null,
    } : null,
  })) : null
  return {
    id: card.id,
    oracle_id: card.oracle_id || null,
    name: card.name,
    lang: card.lang || 'en',
    set: card.set,
    set_name: card.set_name,
    collector_number: card.collector_number,
    rarity: card.rarity || null,
    layout: card.layout || null,
    mana_cost: card.mana_cost || card.card_faces?.[0]?.mana_cost || null,
    cmc: card.cmc ?? null,
    type_line: card.type_line || null,
    oracle_text: card.oracle_text || null,
    flavor_text: card.flavor_text || null,
    power: card.power ?? null,
    toughness: card.toughness ?? null,
    loyalty: card.loyalty ?? null,
    colors: card.colors || [],
    color_identity: card.color_identity || [],
    keywords: card.keywords || [],
    produced_mana: card.produced_mana || [],
    artist: card.artist || null,
    digital: card.digital === true,
    scryfall_uri: card.scryfall_uri || null,
    image_status: card.image_status || null,
    image_uris: card.image_uris ? {
      small: card.image_uris.small || null,
      normal: card.image_uris.normal || null,
      large: card.image_uris.large || null,
      art_crop: card.image_uris.art_crop || null,
    } : null,
    card_faces: faces,
    preview: card.preview ? {
      previewed_at: card.preview.previewed_at || null,
      source: card.preview.source || null,
      source_uri: card.preview.source_uri || null,
    } : null,
  }
}

const SPOILER_CACHE_PREFIX = 'dl_spoilers_v1:'
const SPOILER_CACHE_TTL = 15 * 60 * 1000
// A Magic set is ~300 cards and Scryfall pages at 175. Six pages is headroom
// for a bloated set with variants without letting a bad query walk forever.
const MAX_SPOILER_PAGES = 6

/** Every card Scryfall knows about in a set, most recently spoiled first. */
export async function fetchSpoiledCards(code, { force = false } = {}) {
  const setCode = String(code || '').toLowerCase()
  if (!setCode) return []
  const cacheKey = SPOILER_CACHE_PREFIX + setCode
  if (!force) {
    const cached = readCache(sessionStorage, cacheKey, SPOILER_CACHE_TTL)
    if (cached) return cached
  }
  const cards = []
  let url = `${SEARCH_URL}?q=${encodeURIComponent(`e:${setCode}`)}&order=spoiled&unique=cards`
  for (let page = 0; page < MAX_SPOILER_PAGES && url; page++) {
    const json = await sfGet(url)
    // A set with nothing spoiled yet answers 404, which sfGet reports as null.
    // That is an empty spoiler list, not a failure.
    if (!json?.data) break
    for (const card of json.data) {
      const slim = slimSpoilerCard(card)
      if (slim) cards.push(slim)
    }
    url = json.has_more ? json.next_page : null
  }
  writeCache(sessionStorage, cacheKey, cards)
  return cards
}

const MECHANIC_CACHE_KEY = 'dl_set_mechanics_v2'
const MECHANIC_CACHE_TTL = 7 * 24 * 60 * 60 * 1000

function readMechanicCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MECHANIC_CACHE_KEY) || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

/**
 * How much history a mechanic has *outside* this set, which is what makes it
 * new rather than returning. Both clauses matter: `-e:<code>` drops the set
 * itself, and `date<` drops any other unreleased set previewing the same
 * mechanic, so a mechanic shared by two simultaneous products still reads new.
 */
export async function fetchMechanicHistory(keyword, { setCode, releasedAt }) {
  const name = String(keyword || '').trim()
  if (!name || !setCode) return null
  const cacheKey = `${setCode}|${name}`
  const cache = readMechanicCache()
  const hit = cache[cacheKey]
  if (hit && Date.now() - hit.ts < MECHANIC_CACHE_TTL) return hit.data

  const clauses = [`keyword:"${name}"`, `-e:${setCode}`]
  if (releasedAt) clauses.push(`date<${releasedAt}`)
  const url = `${SEARCH_URL}?q=${encodeURIComponent(clauses.join(' '))}&unique=cards&order=released&dir=asc`
  const result = await sfGetOrStatus(url)

  // 404 is Scryfall's "no cards match", and it is the answer that makes a
  // mechanic new. Every other failure — 429, 5xx, offline — is the absence of
  // an answer, and must never be read as zero: doing so flagged Ward as new on
  // The Hobbit, because a set that big fires enough lookups to get
  // rate-limited. Returning null leaves the mechanic unflagged and, crucially,
  // uncached, so it is retried rather than remembered as wrong for a week.
  if (!result.ok && result.status !== 404) return null

  const json = result.ok ? result.json : null
  const first = json?.data?.[0] || null
  const data = {
    keyword: name,
    priorCount: json?.total_cards || 0,
    firstSet: first?.set_name || null,
    firstSetCode: first?.set || null,
    firstReleased: first?.released_at || null,
  }
  cache[cacheKey] = { ts: Date.now(), data }
  try { localStorage.setItem(MECHANIC_CACHE_KEY, JSON.stringify(cache)) } catch { /* quota */ }
  return data
}

/** A mechanic with no printing anywhere before this set is new to it. */
export function isNewMechanic(history) {
  return !!history && history.priorCount === 0
}

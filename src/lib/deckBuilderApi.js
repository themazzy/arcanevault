/**
 * Deck Builder API
 *
 * - Scryfall: card search, commander search, autocomplete, batch name fetch
 * - EDHRec: commander recommendations (json.edhrec.com — unofficial, no auth)
 * - Recommander.cards: experimental co-occurrence recommendations
 */

import { sfGet, sfUrl, getImageUri } from './scryfall'
import { getProdAppUrl } from './publicUrl'
import { sb } from './supabase'
import { sortByNameRelevance } from './scryfallSearch'
import { legalPartnerQuery } from './commanderPartners'

const SF = 'https://api.scryfall.com'
const EDHREC = 'https://json.edhrec.com'

// Deck imports go through the Cloudflare Worker proxy (the upstream APIs are
// CORS-restricted; the old relative /api/* paths only worked under the Vite
// dev proxy and 404'd in production). Exported for tests.
export function importProxyUrl(source, id) {
  return getProdAppUrl(`/api/import/${source}/${encodeURIComponent(id)}`)
}

// ── Recommander.cards (deck-aware recommendations) ─────────────────────────────
// Co-occurrence/ML recommendations that adapt to the current deck. Proxied
// through our Cloudflare worker (the upstream sends no CORS headers). Returns
// [{ oracle_id, name, score }] on success, [] on any failure / cold start — the
// caller falls back to EDHREC. Best-effort and never throws.
export async function fetchRecommenderRecs(commanderName, deckNames = [], partnerName = null) {
  if (!commanderName) return []
  try {
    const res = await fetch(getProdAppUrl('/api/recommend'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ card_format: 'name', commander: commanderName, partner: partnerName || null, deck: deckNames || [] }),
    })
    if (!res.ok) return []
    const json = await res.json()
    if (json?.result_code !== 'success') return []
    return (json.data?.recommendations || []).filter(r => r?.oracle_id && r?.name)
  } catch {
    return []
  }
}

// ── Formats ───────────────────────────────────────────────────────────────────

export const FORMATS = [
  { id: 'commander',     label: 'Commander / EDH', isEDH: true,  deckSize: 100 },
  { id: 'oathbreaker',   label: 'Oathbreaker',     isEDH: true,  deckSize: 60,  isOathbreaker: true },
  { id: 'brawl',         label: 'Brawl',           isEDH: true,  deckSize: 100 },
  { id: 'standardbrawl', label: 'Standard Brawl',  isEDH: true,  deckSize: 60  },
  { id: 'standard',      label: 'Standard',        isEDH: false, deckSize: 60  },
  { id: 'modern',        label: 'Modern',          isEDH: false, deckSize: 60  },
  { id: 'pioneer',       label: 'Pioneer',         isEDH: false, deckSize: 60  },
  { id: 'legacy',        label: 'Legacy',          isEDH: false, deckSize: 60  },
  { id: 'vintage',       label: 'Vintage',         isEDH: false, deckSize: 60  },
  { id: 'pauper',        label: 'Pauper',          isEDH: false, deckSize: 60  },
]

// ── Card type grouping ────────────────────────────────────────────────────────

export const TYPE_GROUPS = [
  'Commander', 'Creatures', 'Planeswalkers', 'Battles',
  'Instants', 'Sorceries', 'Artifacts', 'Enchantments', 'Lands', 'Other',
]

export function classifyCardType(typeLine = '') {
  const t = (typeLine || '').toLowerCase()
  if (t.includes('creature'))     return 'Creatures'
  if (t.includes('planeswalker')) return 'Planeswalkers'
  if (t.includes('battle'))       return 'Battles'
  if (t.includes('instant'))      return 'Instants'
  if (t.includes('sorcery'))      return 'Sorceries'
  if (t.includes('artifact'))     return 'Artifacts'
  if (t.includes('enchantment'))  return 'Enchantments'
  if (t.includes('land'))         return 'Lands'
  return 'Other'
}

export function groupDeckCards(deckCards) {
  const groups = new Map(TYPE_GROUPS.map(g => [g, []]))
  for (const dc of deckCards) {
    if (dc.is_commander) { groups.get('Commander').push(dc); continue }
    const g = classifyCardType(dc.type_line)
    groups.get(g).push(dc)
  }
  // Remove empty groups, but keep Commander always
  for (const [key, arr] of groups) {
    if (key !== 'Commander' && arr.length === 0) groups.delete(key)
  }
  return groups
}

// ── Deck metadata (stored in folders.description as JSON) ─────────────────────

export function parseDeckMeta(description) {
  try { return JSON.parse(description || '{}') }
  catch { return {} }
}

export function serializeDeckMeta(meta) {
  return JSON.stringify(meta)
}

// ── Card image URI helper ─────────────────────────────────────────────────────

// Delegates to scryfall's getImageUri so both helpers share one behavior
// (including deriving a missing size from the stored 'normal' URL).
export function getCardImageUri(sfCard, size = 'normal') {
  return getImageUri(sfCard, size)
}

export function getPrimaryFaceData(sfCard) {
  if (!sfCard) return null
  return sfCard.card_faces?.[0] || null
}

export function getDeckBuilderCardMeta(sfCard) {
  if (!sfCard) {
    return {
      scryfall_id: null,
      set_code: null,
      collector_number: null,
      type_line: null,
      mana_cost: null,
      cmc: null,
      color_identity: [],
      image_uri: null,
    }
  }

  const face = getPrimaryFaceData(sfCard)
  return {
    scryfall_id: sfCard.id || null,
    set_code: sfCard.set || null,
    collector_number: sfCard.collector_number || null,
    type_line: face?.type_line || sfCard.type_line || null,
    mana_cost: face?.mana_cost || sfCard.mana_cost || null,
    cmc: sfCard.cmc ?? null,
    color_identity: sfCard.color_identity || [],
    image_uri: getCardImageUri(sfCard, 'normal'),
  }
}

// ── EDHRec slug ───────────────────────────────────────────────────────────────

export function nameToSlug(name) {
  return name
    .toLowerCase()
    // EDHREC drops diacritics rather than deleting the letter (Jötun → jotun).
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    // A hyphen in the printed name stays a word break: "Nine-Fingers Keene" →
    // nine-fingers-keene. Stripping it with the other punctuation produced
    // "ninefingers-keene", which 403s.
    .replace(/-/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

// Pre-fix slugger that deleted hyphens/diacritics outright ("ninefingers-keene").
// Kept as a lower-priority candidate in case any EDHREC page still sanitizes
// that way; for names without hyphens it dedupes away.
function legacyNameToSlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

function getEdhrecCommanderSlugCandidates(name) {
  const parts = String(name || '')
    .split('//')
    .map(part => part.trim())
    .filter(Boolean)

  const candidates = [
    nameToSlug(name),
    ...parts.map(part => nameToSlug(part)),
    legacyNameToSlug(name),
    ...parts.map(part => legacyNameToSlug(part)),
  ].filter(Boolean)

  return [...new Set(candidates)]
}

// EDHREC partner / background pair pages combine both commander slugs with a
// hyphen. The site serves either order (verified), but we try alphabetical
// first (its canonical form) then the reverse to be safe. Cartesian over each
// commander's own slug candidates so diacritic/hyphen variants still resolve.
export function getEdhrecPartnerSlugCandidates(nameA, nameB) {
  const a = getEdhrecCommanderSlugCandidates(nameA)
  const b = getEdhrecCommanderSlugCandidates(nameB)
  const out = []
  for (const sa of a) {
    for (const sb of b) {
      if (!sa || !sb) continue
      out.push([sa, sb].sort().join('-'))
      out.push(`${sa}-${sb}`)
      out.push(`${sb}-${sa}`)
    }
  }
  return [...new Set(out)]
}

// ── Scryfall helpers ──────────────────────────────────────────────────────────
// sfGet (rate-limited, with Accept header) is imported from scryfall.js
const sfFetch = sfGet

/** Search cards with optional color identity filter.
 *  Format is intentionally NOT applied as a Scryfall filter — illegal cards
 *  are still returned and surfaced to the user with a legality warning.
 *  The query is anchored to `name:` (rather than sent bare) so a common word
 *  doesn't pull in every card that merely mentions it in oracle text; results
 *  are then re-ranked by sortByNameRelevance() so an exact name match always
 *  outranks Scryfall's requested order (edhrec popularity can otherwise bury
 *  a literal match like "Void" under more popular "Void ___" cards). */
export async function searchCards({ query = '', format, colorIdentity, cardType, cmcMin, cmcMax, page = 1 } = {}) {
  const trimmedQuery = query.trim()
  const parts = []
  if (trimmedQuery) parts.push(`name:"${trimmedQuery.replace(/"/g, '')}"`)
  if (colorIdentity?.length) parts.push(`id<=${colorIdentity.join('')}`)
  if (cardType)      parts.push(`t:${cardType}`)
  if (cmcMin !== '' && cmcMin != null) parts.push(`cmc>=${cmcMin}`)
  if (cmcMax !== '' && cmcMax != null) parts.push(`cmc<=${cmcMax}`)
  // No query AND no filters → bail without hitting Scryfall. The old behavior
  // was to send `q=*`, which returned a generic top-of-set page that wasn't
  // useful and cost a round trip on every cleared-input event.
  if (!parts.length) return { cards: [], hasMore: false }

  const q = encodeURIComponent(parts.join(' '))
  const order = format === 'commander' ? 'edhrec' : 'name'
  const data = await sfFetch(`${SF}/cards/search?q=${q}&order=${order}&unique=cards&page=${page}`)
  if (!data) return { cards: [], hasMore: false, error: true }
  const cards = trimmedQuery ? sortByNameRelevance(data.data || [], trimmedQuery) : (data.data || [])
  return { cards, hasMore: data.has_more || false }
}

/** Search for valid commanders */
export async function searchCommanders(q, scope = 'commander') {
  if (!q || q.length < 2) return []
  const filter = scope === 'companion' ? 'keyword:companion' : 'is:commander'
  const query = encodeURIComponent(`"${q}" ${filter}`)
  const data = await sfFetch(`${SF}/cards/search?q=${query}&order=edhrec&unique=cards`)
  return (data?.data || []).slice(0, 12)
}

/**
 * List the legal partners for a commander with a partner-style ability.
 * `descriptor` comes from detectPartnerType; `typed` is the second search-bar
 * filter. For "Partner with [name]" the specifically-named partner is pinned to
 * the top (and fetched if EDHREC ordering pushed it off the returned page).
 */
export async function searchLegalPartners(descriptor, commanderName, typed = '') {
  const q = legalPartnerQuery(descriptor, commanderName, typed)
  if (!q) return []
  const data = await sfFetch(`${SF}/cards/search?q=${encodeURIComponent(q)}&order=edhrec&unique=cards`)
  let cards = data?.data || []
  if (descriptor?.type === 'partner-with' && descriptor.name) {
    const target = descriptor.name.toLowerCase()
    if (!cards.some(c => (c.name || '').toLowerCase() === target)) {
      const [named] = await fetchCardsByNames([descriptor.name]).catch(() => [])
      if (named) cards = [named, ...cards]
    } else {
      cards = [...cards].sort((a, b) =>
        (b.name?.toLowerCase() === target ? 1 : 0) - (a.name?.toLowerCase() === target ? 1 : 0))
    }
  }
  return cards.slice(0, 40)
}

/** Batch-fetch Scryfall card data by name list (for enriching EDHRec results) */
export async function fetchCardsByNames(names) {
  if (!names?.length) return []
  const results = []
  for (let i = 0; i < names.length; i += 75) {
    const batch = names.slice(i, i + 75).map(name => ({ name }))
    try {
      const res = await fetch(sfUrl(`${SF}/cards/collection`), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body:    JSON.stringify({ identifiers: batch }),
      })
      if (res.ok) {
        const data = await res.json()
        results.push(...(data.data || []))
      }
    } catch {}
    if (i + 75 < names.length) await new Promise(r => setTimeout(r, 150))
  }
  return results
}

// Convert the bounded recommendation RPC response into the Scryfall-like shape
// already consumed throughout DeckBuilder. Image variants intentionally point
// at the stored normal image; recommendation tiles do not need a second CDN URL.
export function recommendationMetadataRowToCard(row) {
  if (!row?.name || !row?.scryfall_id) return null
  const imageUris = row.image_uri || row.art_crop_uri
    ? {
        small: row.image_uri || row.art_crop_uri,
        normal: row.image_uri || row.art_crop_uri,
        large: row.image_uri || row.art_crop_uri,
        art_crop: row.art_crop_uri || row.image_uri,
      }
    : null
  return {
    requested_name: row.requested_name || row.name,
    id: row.scryfall_id,
    lang: row.lang || null,
    oracle_id: row.oracle_id || null,
    name: row.name,
    set: row.set_code || null,
    set_code: row.set_code || null,
    collector_number: row.collector_number || null,
    set_name: row.set_name || null,
    type_line: row.type_line || '',
    oracle_text: row.oracle_text || '',
    mana_cost: row.mana_cost || '',
    cmc: row.cmc ?? 0,
    color_identity: row.color_identity || [],
    colors: row.colors || [],
    legalities: row.legalities || {},
    image_uris: imageUris,
    rarity: row.rarity || null,
    artist: row.artist || null,
    power: row.power ?? null,
    toughness: row.toughness ?? null,
    produced_mana: row.produced_mana || [],
    keywords: row.keywords || [],
    card_faces: row.card_faces || null,
  }
}

/**
 * Resolve recommendation names from the shared Supabase card dictionary.
 * Rankings still come from EDHREC/Recommander; this replaces runtime Scryfall
 * enrichment for images, rules text, print identity, and format legalities.
 */
export async function fetchRecommendationMetadataByNames(names) {
  const uniqueNames = [...new Set((names || []).map(name => String(name || '').trim()).filter(Boolean))]
  if (!uniqueNames.length) return []
  const cards = []
  for (let i = 0; i < uniqueNames.length; i += 300) {
    const { data, error } = await sb.rpc('get_recommendation_card_metadata', {
      requested_names: uniqueNames.slice(i, i + 300),
    })
    if (error) throw error
    cards.push(...(data || []).map(recommendationMetadataRowToCard).filter(Boolean))
  }
  return cards
}

export async function fetchCardsByScryfallIds(ids) {
  if (!ids?.length) return []
  const results = []
  for (let i = 0; i < ids.length; i += 75) {
    const batch = ids.slice(i, i + 75).map(id => ({ id }))
    try {
      const res = await fetch(sfUrl(`${SF}/cards/collection`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ identifiers: batch }),
      })
      if (res.ok) {
        const data = await res.json()
        results.push(...(data.data || []))
      }
    } catch {}
    if (i + 75 < ids.length) await new Promise(r => setTimeout(r, 150))
  }
  return results
}

function escapeScryfallExactName(name) {
  return String(name || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export async function fetchPaperPrintings(name) {
  if (!name) return []
  const query = encodeURIComponent(`!"${escapeScryfallExactName(name)}" game:paper`)
  const data = await sfFetch(`${SF}/cards/search?q=${query}&unique=prints&order=released&dir=desc`)
  // Scryfall's !"name" operator also matches against individual face names, so a
  // multi-face card like "Naktamun Lorespinner // Wheel of Fortune" leaks into
  // results for an unrelated request ("Wheel of Fortune"). Require the primary
  // card name to match so we never return a different card's printings.
  return (data?.data || []).filter(p => p?.name === name)
}

// ── Printings from our own DB (card_prints + card_prices) ───────────────────
// The deck-builder printing optimizer used to fetch every card's printings from
// Scryfall (one `unique:prints` search per card), which trips Scryfall's rate
// limit (429 + CORS) on real decks. We mirror the full print catalog in
// `card_prints` and daily prices in `card_prices`, so we source from there.
// `card_prints` has no release date, so we map set_code → released_at via a
// single cached Scryfall /sets request.

let _setReleaseMap = null
let _setReleasePromise = null
const SET_RELEASE_KEY = 'dl_set_releases_v1'

async function getSetReleaseMap() {
  if (_setReleaseMap) return _setReleaseMap
  try {
    const raw = JSON.parse(localStorage.getItem(SET_RELEASE_KEY) || 'null')
    if (raw?.map && raw.exp > Date.now()) { _setReleaseMap = raw.map; return _setReleaseMap }
  } catch {}
  if (!_setReleasePromise) {
    _setReleasePromise = (async () => {
      const map = {}
      try {
        const res = await fetch(`${SF}/sets`)
        const data = res.ok ? await res.json() : null
        for (const s of data?.data || []) {
          if (s?.code && s?.released_at) map[String(s.code).toLowerCase()] = s.released_at
        }
        try { localStorage.setItem(SET_RELEASE_KEY, JSON.stringify({ exp: Date.now() + 7 * 86400 * 1000, map })) } catch {}
      } catch {}
      _setReleaseMap = map
      return map
    })()
  }
  return _setReleasePromise
}

function dbPrintToScryfallShape(p, priceRow, setReleases) {
  return {
    id: p.scryfall_id,
    name: p.name,
    set: p.set_code,
    set_code: p.set_code,
    collector_number: p.collector_number,
    lang: p.lang || null,
    type_line: p.type_line,
    mana_cost: p.mana_cost,
    cmc: p.cmc,
    color_identity: p.color_identity || [],
    image_uris: p.image_uri ? { normal: p.image_uri } : null,
    released_at: setReleases[String(p.set_code || '').toLowerCase()] || null,
    prices: {
      eur:      priceRow?.price_regular_eur != null ? String(priceRow.price_regular_eur) : null,
      eur_foil: priceRow?.price_foil_eur    != null ? String(priceRow.price_foil_eur)    : null,
      usd:      priceRow?.price_regular_usd != null ? String(priceRow.price_regular_usd) : null,
      usd_foil: priceRow?.price_foil_usd    != null ? String(priceRow.price_foil_usd)    : null,
    },
  }
}

/**
 * All paper printings for a batch of card names, sourced from card_prints +
 * card_prices. Returns Map<name, scryfallShapedPrint[]> sorted newest-first
 * (mirroring Scryfall's `order=released&dir=desc`). Names with no rows map to [].
 */
export async function fetchPaperPrintingsByNamesFromDb(names) {
  const result = new Map((names || []).filter(Boolean).map(n => [n, []]))
  const uniqueNames = [...result.keys()]
  if (!uniqueNames.length) return result

  const allPrints = []
  for (let i = 0; i < uniqueNames.length; i += 200) {
    const batch = uniqueNames.slice(i, i + 200)
    const { data, error } = await sb
      .from('card_prints')
      .select('scryfall_id,name,set_code,collector_number,lang,type_line,mana_cost,cmc,color_identity,image_uri')
      .in('name', batch)
    if (error) throw error
    if (data) allPrints.push(...data)
  }
  if (!allPrints.length) return result

  const ids = [...new Set(allPrints.map(p => p.scryfall_id).filter(Boolean))]
  const priceMap = new Map()   // scryfall_id → newest price row
  for (let i = 0; i < ids.length; i += 400) {
    const batch = ids.slice(i, i + 400)
    const { data: prices } = await sb
      .from('card_prices')
      .select('scryfall_id,snapshot_date,price_regular_eur,price_foil_eur,price_regular_usd,price_foil_usd')
      .in('scryfall_id', batch)
    for (const row of prices || []) {
      const ex = priceMap.get(row.scryfall_id)
      if (!ex || row.snapshot_date > ex.snapshot_date) priceMap.set(row.scryfall_id, row)
    }
  }

  const setReleases = await getSetReleaseMap()
  for (const p of allPrints) {
    if (!result.has(p.name)) result.set(p.name, [])
    result.get(p.name).push(dbPrintToScryfallShape(p, priceMap.get(p.scryfall_id), setReleases))
  }
  for (const arr of result.values()) {
    arr.sort((a, b) => (b.released_at || '').localeCompare(a.released_at || ''))
  }
  return result
}

/** Single-name convenience wrapper over fetchPaperPrintingsByNamesFromDb. */
export async function fetchPaperPrintingsFromDb(name) {
  if (!name) return []
  const map = await fetchPaperPrintingsByNamesFromDb([name])
  return map.get(name) || []
}

export function pickAutomaticDeckPrinting(printings, fallbackCard = null) {
  return (printings || []).find(print => print.lang === 'en')
    || (fallbackCard?.lang === 'en' ? fallbackCard : null)
    || (printings || [])[0]
    || fallbackCard
    || null
}

// ── EDHRec ────────────────────────────────────────────────────────────────────

// LRU-bounded cache for EDHRec recommendation payloads. A long-running session
// would otherwise accumulate one entry per (formatId, commander slug) forever.
const EDH_CACHE_MAX = 50
const _edhCache = new Map()
function edhCacheGet(key) {
  if (!_edhCache.has(key)) return undefined
  const value = _edhCache.get(key)
  _edhCache.delete(key)
  _edhCache.set(key, value)
  return value
}
function edhCacheSet(key, value) {
  if (_edhCache.has(key)) _edhCache.delete(key)
  _edhCache.set(key, value)
  while (_edhCache.size > EDH_CACHE_MAX) {
    const first = _edhCache.keys().next().value
    _edhCache.delete(first)
  }
}

/**
 * Fetch commander recommendations from EDHRec.
 * Returns { categories: [{ header, tag, cards: [{name, inclusion, synergy, cmc, type}] }] }
 * Returns null on failure.
 */
// EDHRec: the /pages/ path allows direct browser requests (no CORS block).
// The old /commanders/ path was blocked by Cloudflare; /pages/commanders/ is not.
async function edhrecFetch(path) {
  try {
    const res = await fetch(`${EDHREC}/pages/${path}`)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

export async function fetchEdhrecCommander(commanderName, formatId = 'commander', { themeSlug = '', partnerName = '' } = {}) {
  // With a partner/background, EDHREC's pair page (both slugs) is far more
  // representative than either solo page; solo candidates stay as the fallback.
  const partnerSlugs = partnerName ? getEdhrecPartnerSlugCandidates(commanderName, partnerName) : []
  const slugs = [...partnerSlugs, ...getEdhrecCommanderSlugCandidates(commanderName)]
  // EDHRec has dedicated Brawl pages at /pages/commanders/<slug>/brawl.json and
  // per-archetype theme pages at /pages/commanders/<slug>/<theme>.json. A theme
  // takes precedence over the brawl subpath; both fall back to the base page.
  const subPath = themeSlug ? `/${themeSlug}` : (formatId === 'brawl' ? '/brawl' : '')
  const cacheKey = themeSlug
    ? `theme:${themeSlug}${partnerName ? ':' + nameToSlug(partnerName) : ''}`
    : (formatId === 'brawl' ? 'brawl' : 'commander') + (partnerName ? ':' + nameToSlug(partnerName) : '')
  for (const slug of slugs) {
    const hit = edhCacheGet(`${cacheKey}:${slug}`)
    if (hit) return hit
  }

  try {
    let data = null
    let resolvedSlug = null

    for (const slug of slugs) {
      data = await edhrecFetch(`commanders/${slug}${subPath}.json`)
      if (data) {
        resolvedSlug = slug
        break
      }
    }

    // Theme/brawl-specific page may not exist — fall back to the base commander page.
    if (!data && subPath) {
      for (const slug of slugs) {
        data = await edhrecFetch(`commanders/${slug}.json`)
        if (data) {
          resolvedSlug = slug
          break
        }
      }
    }

    if (!data) throw new Error('all commander slugs failed')

    const cardlists = data?.container?.json_dict?.cardlists || []
    const result = {
      commander: data?.commanders?.[0] || null,
      // Deck archetypes for this commander (Infect, +1/+1 Counters, …), ranked
      // by deck count. Used by the build assistant's theme selector.
      themes: (data?.panels?.taglinks || [])
        .filter(t => t?.slug && t?.value)
        .map(t => ({ slug: t.slug, label: t.value, count: t.count ?? 0 })),
      categories: cardlists
        .filter(cl => cl.cardviews?.length)
        .map(cl => ({
          header: cl.header,
          tag:    cl.tag,
          // EDHREC renamed the per-card deck count `inclusion` → `num_decks`
          // (kept `inclusion` as a fallback for older fixtures/caches), and this
          // payload no longer carries per-card `cmc`/`type`/`color_identity` at
          // all — those are resolved downstream from our own card metadata RPC.
          // Missing `num_decks` here silently zeroed every recommendation's
          // inclusion %, collapsing the "best cards" ranking to curve/alpha order.
          cards:  cl.cardviews.map(cv => ({
            name:           cv.name,
            slug:           cv.sanitized,
            inclusion:      cv.num_decks       ?? cv.inclusion ?? 0,
            potentialDecks: cv.potential_decks ?? 0,
            synergy:        cv.synergy         ?? 0,
            cmc:            cv.cmc             ?? 0,
            type:           cv.type            ?? '',
            colorIdentity:  cv.color_identity  || [],
          })),
        })),
    }

    // Only cache under the slug we actually resolved — the others returned 404
    // for this format, so caching them would mask future format-specific hits.
    if (resolvedSlug) edhCacheSet(`${cacheKey}:${resolvedSlug}`, result)
    return result
  } catch (err) {
    console.warn('[EDHRec] failed for', commanderName, err.message)
    return null
  }
}


// ── Deck import ───────────────────────────────────────────────────────────────

/**
 * Detect which service a URL belongs to and extract the deck ID.
 * Returns { source: 'archidekt'|'moxfield'|'goldfish', id: string } or null.
 */
export function parseImportUrl(url) {
  const archidekt = url.match(/archidekt\.com\/decks\/(\d+)/)
  if (archidekt) return { source: 'archidekt', id: archidekt[1] }

  // Moxfield deck IDs are short opaque slugs (e.g. "abc123_xy-Z"). Restrict
  // length so non-deck routes like /decks/help can't masquerade as IDs.
  const moxfield = url.match(/moxfield\.com\/decks\/([A-Za-z0-9_-]{6,40})(?:[/?#]|$)/)
  if (moxfield) return { source: 'moxfield', id: moxfield[1] }

  const goldfish = url.match(/mtggoldfish\.com\/deck\/(\d+)/)
  if (goldfish) return { source: 'goldfish', id: goldfish[1] }

  return null
}

/**
 * Parse a plain-text decklist (standard MTG format).
 * Supports:
 *   "4 Lightning Bolt"
 *   "4x Lightning Bolt"
 *   "Lightning Bolt"                        (qty defaults to 1)
 *   "4 Lightning Bolt (M10) 155"            (set code + collector number preserved)
 *   "4 Lightning Bolt [M10]"                (bracket set code)
 *   "4 *F* Lightning Bolt"                  (MTGO foil marker)
 *   "4 Lightning Bolt (M10) 155 [Foil]"     (Moxfield-style foil)
 *   Section headers: "Commander:", "Deck:", "Attractions:", "Sideboard:", "// Comment"
 * Returns [{ name, qty, isCommander, board, setCode, collectorNumber, foil }]
 */
export function parseTextDecklist(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const cards = []
  let board = 'main'
  let inCommander = false

  for (const line of lines) {
    // Section headers
    if (/^(\/\/\s*)?(commander|commanders)/i.test(line)) { inCommander = true; board = 'main'; continue }
    if (/^(\/\/\s*)?(deck|mainboard|main board)/i.test(line)) { inCommander = false; board = 'main'; continue }
    if (/^(\/\/\s*)?(attractions?|attraction deck)/i.test(line)) { inCommander = false; board = 'attraction'; continue }
    if (/^(\/\/\s*)?(sideboard|side board)/i.test(line)) { inCommander = false; board = 'side'; continue }
    if (/^(\/\/\s*)?(maybeboard|maybe)/i.test(line)) { inCommander = false; board = 'maybe'; continue }
    if (line.startsWith('//')) continue // other comments

    let rest = line

    // Detect and strip foil markers. Anchored to word boundaries / end-of-line
    // so a hypothetical card name containing the literal substring won't be stripped.
    let foil = false
    if (/(?:^|\s)\*F\*(?:\s|$)/i.test(rest) || /\[foil\]\s*$/i.test(rest) || /\(foil\)\s*$/i.test(rest)) {
      foil = true
      rest = rest
        .replace(/(?:^|\s)\*F\*(?=\s|$)/gi, ' ')
        .replace(/\s*\[foil\]\s*$/gi, '')
        .replace(/\s*\(foil\)\s*$/gi, '')
        .trim()
    }

    // Extract optional qty at start: "4 " or "4x "
    let qty = 1
    const qtyMatch = rest.match(/^(\d+)x?\s+/)
    if (qtyMatch) {
      qty = parseInt(qtyMatch[1], 10)
      rest = rest.slice(qtyMatch[0].length)
    }

    // Extract set code + optional collector number from the end of the line:
    //   "(M10) 155" or "[M10] 155" or "(M10)" or "[M10]"
    //   "(plst) IKO-250" means the concrete printed card is IKO #250.
    // Set codes are 2-6 alphanumeric chars; collector numbers may have a trailing letter (e.g. 155a)
    let setCode = null
    let collectorNumber = null
    const sourcePrintMatch = rest.match(/\s+[\(\[]([A-Za-z0-9]{2,6})[\)\]]\s+([A-Za-z0-9]{2,6})-(\d+[a-z]?)\s*$/)
    if (sourcePrintMatch) {
      setCode = sourcePrintMatch[2].toLowerCase()
      collectorNumber = sourcePrintMatch[3] || null
      rest = rest.slice(0, sourcePrintMatch.index).trim()
    }
    const setMatch = !sourcePrintMatch && rest.match(/\s+[\(\[]([A-Za-z0-9]{2,6})[\)\]]\s*(\d+[a-z]?)?\s*$/)
    if (setMatch) {
      setCode = setMatch[1].toLowerCase()
      collectorNumber = setMatch[2] || null
      rest = rest.slice(0, setMatch.index).trim()
    }

    // Strip back-face suffix: "Front // Back" → "Front"
    rest = rest.replace(/\s*\/\/.*$/, '').trim()

    const name = rest
    if (!name || qty < 1) continue
    cards.push({ name, qty, isCommander: inCommander, board, setCode, collectorNumber, foil })
    inCommander = false // only first card after Commander: header is commander
  }

  return cards
}

/**
 * Import a deck from Archidekt.
 * Returns { name, format, cards: [{ name, qty, isCommander, board, scryfallId, setCode, collectorNumber }] }
 */
export async function importFromArchidekt(deckId) {
  const res = await fetch(importProxyUrl('archidekt', deckId))
  if (!res.ok) throw new Error(`Archidekt ${res.status}`)
  const data = await res.json()

  // Find the premier category (Commander slot)
  const premierCats = new Set(
    (data.categories || []).filter(c => c.isPremier).map(c => String(c.name || '').toLowerCase())
  )

  const FORMAT_MAP = { 3: 'commander', 1: 'standard', 2: 'modern', 11: 'pioneer', 4: 'legacy', 5: 'vintage', 10: 'pauper', 14: 'brawl' }
  const getArchidektBoard = (categories = []) => {
    const names = categories.map(cat => String(cat?.name || cat || '').trim().toLowerCase())
    if (names.some(name => name === 'attraction' || name === 'attractions' || name.includes('attraction deck'))) return 'attraction'
    if (names.some(name => name.includes('maybeboard') || name === 'maybe' || name.includes('maybe board'))) return 'maybe'
    if (names.some(name => name.includes('sideboard') || name.includes('side board'))) return 'side'
    return 'main'
  }

  const cards = (data.cards || [])
    .filter(c => !c.deletedAt)
    .map(c => {
      const isCommander = (c.categories || []).some(cat => premierCats.has(String(cat?.name || cat || '').toLowerCase()))
      const board = isCommander ? 'main' : getArchidektBoard(c.categories || [])
      return {
        name:             c.card?.oracleCard?.name || '',
        qty:              c.quantity || 1,
        isCommander,
        board,
        scryfallId:       c.card?.uid || null,
        setCode:          c.card?.edition?.editioncode || null,
        collectorNumber:  c.card?.collectorNumber || null,
        foil:             c.modifier === 'Foil',
      }
    })
    .filter(c => c.name)

  return {
    name:   data.name || 'Imported Deck',
    format: FORMAT_MAP[data.deckFormat] || 'commander',
    cards,
  }
}

/**
 * Import a deck from Moxfield (requires no auth for some public decks via proxy).
 * Falls back gracefully — callers should catch and prompt user to paste text instead.
 */
export async function importFromMoxfield(deckId) {
  const res = await fetch(importProxyUrl('moxfield', deckId))
  if (!res.ok) throw new Error(`Moxfield ${res.status} — paste the deck text instead`)
  const data = await res.json()

  const cards = []

  const addBoard = (board, boardName, isCommander = false) => {
    for (const [, entry] of Object.entries(board || {})) {
      cards.push({
        name:            entry.card?.name || '',
        qty:             entry.quantity || 1,
        isCommander,
        board:           boardName,
        scryfallId:      entry.card?.scryfall_id || null,
        setCode:         entry.card?.set || null,
        collectorNumber: entry.card?.cn || null,
        foil:            entry.isFoil || false,
      })
    }
  }

  addBoard(data.commanders, 'main', true)
  addBoard(data.mainboard,  'main', false)
  addBoard(data.attractions, 'attraction', false)
  addBoard(data.sideboard,  'side', false)
  addBoard(data.maybeboard, 'maybe', false)

  return {
    name:   data.name || 'Imported Deck',
    format: data.format || 'commander',
    cards:  cards.filter(c => c.name),
  }
}

/**
 * Import a deck from MTGGoldfish (plain text download).
 */
export async function importFromGoldfish(deckId) {
  const res = await fetch(importProxyUrl('goldfish', deckId))
  // MTGGoldfish sits behind a Cloudflare JS challenge that blocks server-side
  // fetches — expect 403s here. Steer the user to the paste flow.
  if (!res.ok) throw new Error('MTGGoldfish blocks automated imports — open the deck, use Export → copy the decklist, and paste it here instead.')
  const text = await res.text()
  const cards = parseTextDecklist(text)
  return { name: 'Goldfish Import', format: 'commander', cards }
}

/**
 * Main import entry point. Detects source from URL and fetches deck data.
 * Returns { name, format, cards } or throws with a user-friendly message.
 */
export async function importDeckFromUrl(url) {
  const parsed = parseImportUrl(url.trim())
  if (!parsed) throw new Error('Unrecognised URL. Paste a deck link from Archidekt, Moxfield, or MTGGoldfish.')

  if (parsed.source === 'archidekt') return importFromArchidekt(parsed.id)
  if (parsed.source === 'moxfield')  return importFromMoxfield(parsed.id)
  if (parsed.source === 'goldfish')  return importFromGoldfish(parsed.id)

  throw new Error('Unsupported source')
}

// ── Debounce helper ───────────────────────────────────────────────────────────

export function makeDebouncer(ms = 300) {
  let timer
  return (fn) => {
    clearTimeout(timer)
    timer = setTimeout(fn, ms)
  }
}

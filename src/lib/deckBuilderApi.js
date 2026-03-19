/**
 * Deck Builder API
 *
 * - Scryfall: card search, commander search, autocomplete, batch name fetch
 * - EDHRec: commander recommendations (json.edhrec.com — unofficial, no auth)
 * - Recommander.cards: experimental co-occurrence recommendations
 */

const SF = 'https://api.scryfall.com'
const EDHREC = 'https://json.edhrec.com'
const RECOMMANDER = 'https://recommander.cards'

// ── Formats ───────────────────────────────────────────────────────────────────

export const FORMATS = [
  { id: 'commander', label: 'Commander / EDH', isEDH: true,  deckSize: 100 },
  { id: 'brawl',     label: 'Brawl',           isEDH: true,  deckSize: 60  },
  { id: 'standard',  label: 'Standard',         isEDH: false, deckSize: 60  },
  { id: 'modern',    label: 'Modern',           isEDH: false, deckSize: 60  },
  { id: 'pioneer',   label: 'Pioneer',          isEDH: false, deckSize: 60  },
  { id: 'legacy',    label: 'Legacy',           isEDH: false, deckSize: 60  },
  { id: 'vintage',   label: 'Vintage',          isEDH: false, deckSize: 60  },
  { id: 'pauper',    label: 'Pauper',           isEDH: false, deckSize: 60  },
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

export function getCardImageUri(sfCard, size = 'normal') {
  if (!sfCard) return null
  return sfCard.image_uris?.[size]
    ?? sfCard.card_faces?.[0]?.image_uris?.[size]
    ?? null
}

// ── EDHRec slug ───────────────────────────────────────────────────────────────

export function nameToSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

// ── Scryfall helpers ──────────────────────────────────────────────────────────

let _lastSf = 0
async function sfFetch(url) {
  const wait = Math.max(0, 100 - (Date.now() - _lastSf))
  if (wait) await new Promise(r => setTimeout(r, wait))
  _lastSf = Date.now()
  const res = await fetch(url)
  if (!res.ok) return null
  return res.json()
}

/** Search cards with optional format + color identity filter */
export async function searchCards({ query = '', format, colorIdentity, cardType, cmcMin, cmcMax, page = 1 } = {}) {
  const parts = []
  if (query.trim()) parts.push(query.trim())
  if (format)        parts.push(`f:${format}`)
  if (colorIdentity?.length) parts.push(`id<=${colorIdentity.join('')}`)
  if (cardType)      parts.push(`t:${cardType}`)
  if (cmcMin !== '' && cmcMin != null) parts.push(`cmc>=${cmcMin}`)
  if (cmcMax !== '' && cmcMax != null) parts.push(`cmc<=${cmcMax}`)
  if (!parts.length) parts.push('*')

  const q = encodeURIComponent(parts.join(' '))
  const order = format === 'commander' ? 'edhrec' : 'name'
  const data = await sfFetch(`${SF}/cards/search?q=${q}&order=${order}&unique=cards&page=${page}`)
  if (!data) return { cards: [], hasMore: false }
  return { cards: data.data || [], hasMore: data.has_more || false }
}

/** Search for valid commanders */
export async function searchCommanders(q) {
  if (!q || q.length < 2) return []
  const query = encodeURIComponent(`"${q}" is:commander`)
  const data = await sfFetch(`${SF}/cards/search?q=${query}&order=edhrec&unique=cards`)
  return (data?.data || []).slice(0, 12)
}

/** Autocomplete card names for search box */
export async function autocompleteCards(q) {
  if (!q || q.length < 2) return []
  const data = await sfFetch(`${SF}/cards/autocomplete?q=${encodeURIComponent(q)}`)
  return data?.data || []
}

/** Batch-fetch Scryfall card data by name list (for enriching EDHRec results) */
export async function fetchCardsByNames(names) {
  if (!names?.length) return []
  const results = []
  for (let i = 0; i < names.length; i += 75) {
    const batch = names.slice(i, i + 75).map(name => ({ name }))
    try {
      const res = await fetch(`${SF}/cards/collection`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
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

// ── EDHRec ────────────────────────────────────────────────────────────────────

const _edhCache = {}

/**
 * Fetch commander recommendations from EDHRec.
 * Returns { categories: [{ header, tag, cards: [{name, inclusion, synergy, cmc, type}] }] }
 * Returns null on failure.
 */
// EDHRec blocks direct browser requests (Cloudflare 403).
// Route through Vite dev-server proxy at /api/edhrec → json.edhrec.com
async function edhrecFetch(path) {
  try {
    const res = await fetch(`/api/edhrec/${path}`)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

export async function fetchEdhrecCommander(commanderName) {
  const slug = nameToSlug(commanderName)
  if (_edhCache[slug]) return _edhCache[slug]

  try {
    const data = await edhrecFetch(`commanders/${slug}.json`)
    if (!data) throw new Error('all proxies failed')

    const cardlists = data?.container?.json_dict?.cardlists || []
    const result = {
      commander: data?.commanders?.[0] || null,
      categories: cardlists
        .filter(cl => cl.cardviews?.length)
        .map(cl => ({
          header: cl.header,
          tag:    cl.tag,
          cards:  cl.cardviews.map(cv => ({
            name:      cv.name,
            slug:      cv.sanitized,
            inclusion: cv.inclusion ?? 0,
            synergy:   cv.synergy   ?? 0,
            cmc:       cv.cmc       ?? 0,
            type:      cv.type      ?? '',
            colorIdentity: cv.color_identity || [],
          })),
        })),
    }

    _edhCache[slug] = result
    return result
  } catch (err) {
    console.warn('[EDHRec] failed for', commanderName, err.message)
    return null
  }
}

// ── Recommander.cards (experimental) ─────────────────────────────────────────

/**
 * Fetch co-occurrence recommendations from recommander.cards.
 * Fully experimental — returns [] silently on any error.
 */
export async function fetchRecommander(cardNames) {
  if (!cardNames?.length) return []
  try {
    const res = await fetch(`${RECOMMANDER}/api/recommendations`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ cards: cardNames.slice(0, 20) }),
      signal:  AbortSignal.timeout(6000),
    })
    if (!res.ok) return []
    const data = await res.json()
    return (data.recommendations || data.cards || []).map(r => ({
      name:  r.name || r.card_name || r.card,
      score: r.score ?? r.similarity ?? 0,
    })).filter(r => r.name)
  } catch {
    return []
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

  const moxfield = url.match(/moxfield\.com\/decks\/([A-Za-z0-9_-]+)/)
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
 *   Section headers: "Commander:", "Deck:", "Sideboard:", "// Comment"
 * Returns [{ name, qty, isCommander, board }]
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
    if (/^(\/\/\s*)?(sideboard|side board)/i.test(line)) { inCommander = false; board = 'side'; continue }
    if (/^(\/\/\s*)?(maybeboard|maybe)/i.test(line)) { inCommander = false; board = 'maybe'; continue }
    if (line.startsWith('//')) continue // other comments

    // Card line: "4 Card Name" or "4x Card Name"
    const match = line.match(/^(\d+)x?\s+(.+)$/)
    if (!match) continue

    const qty  = parseInt(match[1], 10)
    const name = match[2].trim().replace(/\s*\(.*?\)\s*\d*/g, '').trim() // strip (SET) 123 suffixes

    if (!name || qty < 1) continue
    cards.push({ name, qty, isCommander: inCommander, board })
    inCommander = false // only first card after Commander: header is commander
  }

  return cards
}

/**
 * Import a deck from Archidekt.
 * Returns { name, format, cards: [{ name, qty, isCommander, board, scryfallId, setCode, collectorNumber }] }
 */
export async function importFromArchidekt(deckId) {
  const res = await fetch(`/api/archidekt/api/decks/${deckId}/`)
  if (!res.ok) throw new Error(`Archidekt ${res.status}`)
  const data = await res.json()

  // Find the premier category (Commander slot)
  const premierCats = new Set(
    (data.categories || []).filter(c => c.isPremier).map(c => c.name)
  )

  const FORMAT_MAP = { 3: 'commander', 1: 'standard', 2: 'modern', 11: 'pioneer', 4: 'legacy', 5: 'vintage', 10: 'pauper', 14: 'brawl' }

  const cards = (data.cards || [])
    .filter(c => !c.deletedAt)
    .map(c => {
      const isCommander = (c.categories || []).some(cat => premierCats.has(cat))
      return {
        name:             c.card?.oracleCard?.name || '',
        qty:              c.quantity || 1,
        isCommander,
        board:            'main',
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
  const res = await fetch(`/api/moxfield/v2/decks/all/${deckId}`)
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
  const res = await fetch(`/api/goldfish/deck/download/${deckId}`)
  if (!res.ok) throw new Error(`Goldfish ${res.status}`)
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

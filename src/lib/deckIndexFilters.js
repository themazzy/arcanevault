// Deck-index (tile-level) filtering & sorting for the Builder "My Decks" tab.
// Pure logic, no imports — the community tab applies the same criteria
// server-side in the get_community_decks RPC; keep semantics aligned when
// changing either side.

export const COLOR_MATCH_MODES = ['includes', 'exact', 'at_most']

export const COLOR_MODE_LABELS = {
  includes: 'Includes',
  exact:    'Exactly',
  at_most:  'At most',
}

// Color-identity match. A deck with an empty identity is treated as colorless
// ('C') so the C pip actually matches colorless decks — Scryfall identities
// never contain 'C' themselves.
export function matchColorIdentity(deckColors, selected, mode = 'includes') {
  if (!selected || selected.length === 0) return true
  const deck = new Set(deckColors && deckColors.length ? deckColors : ['C'])
  const sel  = new Set(selected)
  if (mode === 'exact') {
    if (deck.size !== sel.size) return false
    for (const c of sel) if (!deck.has(c)) return false
    return true
  }
  if (mode === 'at_most') {
    for (const c of deck) if (!sel.has(c)) return false
    return true
  }
  // 'includes' — deck identity must contain every selected color
  for (const c of sel) if (!deck.has(c)) return false
  return true
}

export const EMPTY_DECK_INDEX_FILTERS = {
  search: '',
  type: 'all',          // all | builder | collection
  visibility: 'all',    // all | public | private
  format: 'all',        // all | <FORMATS id>
  colors: [],           // subset of W U B R G C
  colorMode: 'includes',
  bracket: 'all',       // all | 1..5
  tags: [],             // deck matches when it has ANY selected tag
}

const metaOf = deck => deck.__meta || {}

export const deckFormatId = meta => meta.format || 'commander'

// Prefer colors aggregated from actual deck cards (RPC field); fall back to
// the stored commander identity — same rule the deck tiles use for pips.
export function deckColorsOf(deck) {
  const raw = deck.deck_color_identity
  return raw && raw.length > 0 ? raw : (metaOf(deck).commanderColorIdentity || [])
}

export function filterDeckIndex(decks, filters) {
  const f = { ...EMPTY_DECK_INDEX_FILTERS, ...filters }
  const q = f.search.trim().toLowerCase()
  return (decks || []).filter(deck => {
    const meta = metaOf(deck)
    if (q) {
      const cmd = (meta.commanders?.map(c => c.name).join(' ') || meta.commanderName || '').toLowerCase()
      const tagText = (meta.tags || []).join(' ').toLowerCase()
      if (!(deck.name || '').toLowerCase().includes(q) && !cmd.includes(q) && !tagText.includes(q)) return false
    }
    if (f.type === 'builder' && deck.type !== 'builder_deck') return false
    if (f.type === 'collection' && deck.type !== 'deck') return false
    if (f.visibility !== 'all') {
      const isPublic = meta.is_public === true || meta.is_public === 'true'
      if (f.visibility === 'public' && !isPublic) return false
      if (f.visibility === 'private' && isPublic) return false
    }
    if (f.format !== 'all' && deckFormatId(meta) !== f.format) return false
    if (f.colors.length && !matchColorIdentity(deckColorsOf(deck), f.colors, f.colorMode)) return false
    if (f.bracket !== 'all' && Number(meta.bracket) !== Number(f.bracket)) return false
    if (f.tags.length) {
      const deckTags = meta.tags || []
      if (!f.tags.some(t => deckTags.includes(t))) return false
    }
    return true
  })
}

export const DECK_INDEX_SORTS = {
  name:      'Name A→Z',
  name_desc: 'Name Z→A',
  format:    'Format',
  bracket:   'Bracket',
  count:     'Card Count',
  created:   'Newest',
  updated:   'Recently Updated',
}

const updatedTs = d => Date.parse(d.deck_modified_at || d.updated_at || d.created_at || 0) || 0
const createdTs = d => Date.parse(d.created_at || d.updated_at || 0) || 0
const byName = (a, b) => (a.name || '').localeCompare(b.name || '')

export function sortDeckIndex(decks, sortBy) {
  const arr = [...(decks || [])]
  if (sortBy === 'name')      return arr.sort(byName)
  if (sortBy === 'name_desc') return arr.sort((a, b) => byName(b, a))
  if (sortBy === 'created')   return arr.sort((a, b) => createdTs(b) - createdTs(a))
  if (sortBy === 'format')    return arr.sort((a, b) =>
    deckFormatId(metaOf(a)).localeCompare(deckFormatId(metaOf(b))) || byName(a, b))
  if (sortBy === 'bracket')   return arr.sort((a, b) =>
    (Number(metaOf(b).bracket) || 0) - (Number(metaOf(a).bracket) || 0) || byName(a, b))
  if (sortBy === 'count')     return arr.sort((a, b) =>
    (b.card_count || 0) - (a.card_count || 0) || byName(a, b))
  return arr.sort((a, b) => updatedTs(b) - updatedTs(a)) // 'updated' (default)
}

// ── Active-filter chips ──────────────────────────────────────────────────────
// Each chip carries the key needed by clearFilterChip to remove just itself.
// `opts.formatLabel` lets callers pass the human FORMATS label for the id.

export function describeActiveFilters(filters, opts = {}) {
  const f = { ...EMPTY_DECK_INDEX_FILTERS, ...filters }
  const chips = []
  if (f.type !== 'all') chips.push({ key: 'type', label: f.type === 'builder' ? 'Builder decks' : 'Collection decks' })
  if (f.visibility !== 'all') chips.push({ key: 'visibility', label: f.visibility === 'public' ? 'Public' : 'Private' })
  if (f.format !== 'all') chips.push({ key: 'format', label: opts.formatLabel || f.format })
  if (f.colors.length) chips.push({ key: 'colors', label: `${COLOR_MODE_LABELS[f.colorMode] || 'Includes'} ${f.colors.join('')}` })
  if (f.bracket !== 'all') chips.push({ key: 'bracket', label: `Bracket ${f.bracket}` })
  for (const t of f.tags) chips.push({ key: `tag:${t}`, label: t })
  return chips
}

export function countActiveFilters(filters) {
  return describeActiveFilters(filters).length
}

export function clearFilterChip(filters, key) {
  if (key.startsWith('tag:')) {
    const tag = key.slice(4)
    return { ...filters, tags: (filters.tags || []).filter(t => t !== tag) }
  }
  if (key === 'colors') return { ...filters, colors: [] }
  return { ...filters, [key]: EMPTY_DECK_INDEX_FILTERS[key] }
}

// ── View-preference persistence (localStorage) ───────────────────────────────
// Device-local on purpose: view prefs aren't worth a user_settings migration.

export function loadViewPrefs(storageKey, fallback) {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return fallback
    return { ...fallback, ...JSON.parse(raw) }
  } catch {
    return fallback
  }
}

export function saveViewPrefs(storageKey, value) {
  try { localStorage.setItem(storageKey, JSON.stringify(value)) } catch { /* quota/private mode */ }
}

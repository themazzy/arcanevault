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

export const TAG_MATCH_MODES = ['any', 'all']

export const TAG_MODE_LABELS = {
  any: 'Any tag',
  all: 'All tags',
}

export const COMPLETION_LABELS = {
  all:      'Any size',
  complete: 'At target',
  under:    'Under target',
  over:     'Over target',
}

export const EMPTY_DECK_INDEX_FILTERS = {
  search: '',
  type: 'all',          // all | builder | collection
  visibility: 'all',    // all | public | private
  format: 'all',        // all | <FORMATS id>
  colors: [],           // subset of W U B R G C
  colorMode: 'includes',
  bracket: 'all',       // all | 1..5
  tags: [],
  tagMode: 'any',       // any = matches ANY selected tag | all = must have every one
  completion: 'all',    // all | complete | under | over (vs the format's deck size)
  unsyncedOnly: false,  // only linked pairs with pending drift
}

const metaOf = deck => deck.__meta || {}

export const deckFormatId = meta => meta.format || 'commander'

// Mirrors getSyncState() in deckSync.js. Duplicated rather than imported so this
// module stays dependency-free (deckSync pulls in the Supabase client).
export function isDeckUnsynced(meta) {
  const m = meta || {}
  if (!(m.linked_deck_id || m.linked_builder_id)) return false
  const s = m.sync_state || {}
  return !!(s.unsynced_builder || s.unsynced_collection)
}

/**
 * How a deck's card count sits against its format's target size.
 * `deckSizeFor(formatId)` resolves the target — callers pass a resolver over
 * FORMATS rather than this module importing it, so the size stays defined in
 * exactly one place (deckBuilderApi.FORMATS) and this file stays pure.
 * Returns null when the count or the target is unknown.
 */
export function deckCompletion(deck, deckSizeFor) {
  if (typeof deckSizeFor !== 'function') return null
  const count = deck?.card_count
  if (count == null) return null
  const target = deckSizeFor(deckFormatId(metaOf(deck)))
  if (!target) return null
  if (count === target) return 'complete'
  return count < target ? 'under' : 'over'
}

// Prefer colors aggregated from actual deck cards (RPC field); fall back to
// the stored commander identity — same rule the deck tiles use for pips.
export function deckColorsOf(deck) {
  const raw = deck.deck_color_identity
  return raw && raw.length > 0 ? raw : (metaOf(deck).commanderColorIdentity || [])
}

export function filterDeckIndex(decks, filters, opts = {}) {
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
      const match = f.tagMode === 'all'
        ? f.tags.every(t => deckTags.includes(t))
        : f.tags.some(t => deckTags.includes(t))
      if (!match) return false
    }
    if (f.completion !== 'all' && deckCompletion(deck, opts.deckSizeFor) !== f.completion) return false
    if (f.unsyncedOnly && !isDeckUnsynced(meta)) return false
    return true
  })
}

// Sort keys are direction-free — direction is a separate axis so every key can
// be reversed, not just name (which used to need a hand-paired `name_desc`).
export const DECK_INDEX_SORTS = {
  updated: 'Last updated',
  created: 'Date created',
  name:    'Name',
  format:  'Format',
  bracket: 'Bracket',
  count:   'Card count',
}

// The direction each key opens on — the one people mean when they pick it.
export const DECK_INDEX_SORT_DEFAULT_DIR = {
  updated: 'desc',
  created: 'desc',
  name:    'asc',
  format:  'asc',
  bracket: 'desc',
  count:   'desc',
}

// Human labels for the direction toggle, per key.
const SORT_DIR_LABELS = {
  updated: { asc: 'Oldest first',   desc: 'Newest first' },
  created: { asc: 'Oldest first',   desc: 'Newest first' },
  name:    { asc: 'A→Z',            desc: 'Z→A' },
  format:  { asc: 'A→Z',            desc: 'Z→A' },
  bracket: { asc: 'Lowest first',   desc: 'Highest first' },
  count:   { asc: 'Fewest first',   desc: 'Most first' },
}

const updatedTs = d => Date.parse(d.deck_modified_at || d.updated_at || d.created_at || 0) || 0
const createdTs = d => Date.parse(d.created_at || d.updated_at || 0) || 0
const byName = (a, b) => (a.name || '').localeCompare(b.name || '')

// Every comparator is written ascending; sortDeckIndex flips the sign for
// 'desc'. Name is always the tiebreak, applied after the flip so ties stay A→Z.
const ASC_COMPARATORS = {
  name:    byName,
  updated: (a, b) => updatedTs(a) - updatedTs(b),
  created: (a, b) => createdTs(a) - createdTs(b),
  format:  (a, b) => deckFormatId(metaOf(a)).localeCompare(deckFormatId(metaOf(b))),
  bracket: (a, b) => (Number(metaOf(a).bracket) || 0) - (Number(metaOf(b).bracket) || 0),
  count:   (a, b) => (a.card_count || 0) - (b.card_count || 0),
}

/**
 * Resolve a stored sort preference into a valid { sortBy, dir } pair.
 * Accepts the retired `name_desc` key so saved localStorage prefs (and any
 * caller still passing it) keep working.
 */
export function normalizeDeckSort(sortBy, dir) {
  if (sortBy === 'name_desc') return { sortBy: 'name', dir: 'desc' }
  const key = DECK_INDEX_SORTS[sortBy] ? sortBy : 'updated'
  const direction = dir === 'asc' || dir === 'desc' ? dir : DECK_INDEX_SORT_DEFAULT_DIR[key]
  return { sortBy: key, dir: direction }
}

export function describeSortDirection(sortBy, dir) {
  const { sortBy: key, dir: direction } = normalizeDeckSort(sortBy, dir)
  return SORT_DIR_LABELS[key][direction]
}

export function sortDeckIndex(decks, sortBy, dir) {
  const { sortBy: key, dir: direction } = normalizeDeckSort(sortBy, dir)
  const compare = ASC_COMPARATORS[key]
  const sign = direction === 'asc' ? 1 : -1
  return [...(decks || [])].sort((a, b) => {
    const r = compare(a, b) * sign
    return r !== 0 ? r : byName(a, b)
  })
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
  if (f.completion !== 'all') chips.push({ key: 'completion', label: COMPLETION_LABELS[f.completion] })
  if (f.unsyncedOnly) chips.push({ key: 'unsyncedOnly', label: 'Unsynced' })
  for (const t of f.tags) chips.push({ key: `tag:${t}`, label: t })
  // Only meaningful with more than one tag selected — with one, any === all.
  if (f.tags.length > 1 && f.tagMode === 'all') chips.push({ key: 'tagMode', label: 'All tags' })
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

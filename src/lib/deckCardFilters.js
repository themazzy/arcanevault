// Card-level filters + extra groupings for the Deck Builder's deck list.
// Pure logic over deck_cards rows (dc) + their cached Scryfall entry (sf).

import { classifyCardType } from './deckBuilderApi'
import { matchColorIdentity } from './deckIndexFilters'
import { normalizeBoard } from './deckBuilderHelpers'

export const EMPTY_DECK_CARD_FILTERS = {
  colors: [],            // subset of W U B R G C
  colorMode: 'includes', // includes | exact | at_most (matchColorIdentity)
  types: [],             // classifyCardType group names ('Creatures', 'Instants', …)
  rarities: [],          // common | uncommon | rare | mythic
  cmcMin: '',
  cmcMax: '',
}

export const DECK_CARD_TYPE_OPTIONS = [
  'Creatures', 'Instants', 'Sorceries', 'Artifacts',
  'Enchantments', 'Planeswalkers', 'Battles', 'Lands',
]

export const DECK_CARD_RARITY_OPTIONS = ['common', 'uncommon', 'rare', 'mythic']

const hasCmcBound = v => v !== '' && v != null

export function countActiveCardFilters(filters) {
  const f = filters || EMPTY_DECK_CARD_FILTERS
  let n = 0
  if (f.colors?.length) n++
  if (f.types?.length) n++
  if (f.rarities?.length) n++
  if (hasCmcBound(f.cmcMin)) n++
  if (hasCmcBound(f.cmcMax)) n++
  return n
}

const WUBRG = new Set(['W', 'U', 'B', 'R', 'G'])

// What the deck actually contains, per filter dimension — the filter panel
// only offers options that exist in the deck. Rarity comes from the cached
// Scryfall entry (same source matchesDeckCardFilters uses), so `getRarity`
// is a callback; an unresolved rarity contributes nothing.
export function computeDeckFilterPresence(deckCards, getRarity) {
  const boards = new Set()
  const colors = new Set()
  const types = new Set()
  const rarities = new Set()
  for (const dc of deckCards || []) {
    boards.add(normalizeBoard(dc.board))
    const ci = (dc.color_identity || []).filter(c => WUBRG.has(c))
    if (ci.length === 0) colors.add('C')
    for (const c of ci) colors.add(c)
    types.add(classifyCardType(dc.type_line))
    const rarity = getRarity ? getRarity(dc) : null
    if (rarity) rarities.add(rarity)
  }
  return { boards, colors, types, rarities }
}

// Options to render: those present in the deck, plus any currently-selected
// value even if stale (e.g. the last card of a type was removed while its
// filter was active) so the user can still see and clear it. A null/undefined
// presence set means "unknown" and leaves the full option list untouched.
export function availableFilterOptions(options, present, selected = []) {
  if (!present) return options
  return options.filter(o => present.has(o) || selected.includes(o))
}

export function matchesDeckCardFilters(dc, sf, filters) {
  const f = filters || EMPTY_DECK_CARD_FILTERS
  if (f.colors?.length && !matchColorIdentity(dc.color_identity, f.colors, f.colorMode)) return false
  if (f.types?.length && !f.types.includes(classifyCardType(dc.type_line))) return false
  if (f.rarities?.length) {
    const rarity = sf?.rarity || null
    if (!rarity || !f.rarities.includes(rarity)) return false
  }
  const cmc = Number(dc.cmc ?? 0)
  if (hasCmcBound(f.cmcMin) && !(cmc >= Number(f.cmcMin))) return false
  if (hasCmcBound(f.cmcMax) && !(cmc <= Number(f.cmcMax))) return false
  return true
}

// ── Extra group-by modes ─────────────────────────────────────────────────────
// Land detection matches the type grouping (classifyCardType) so a card never
// lands in a different bucket depending on the grouping mode.

const isLandCard = dc => classifyCardType(dc.type_line) === 'Lands'

export const MANA_VALUE_GROUP_ORDER = ['0', '1', '2', '3', '4', '5', '6', '7+', 'Lands']

export function manaValueGroupKey(dc) {
  if (isLandCard(dc)) return 'Lands'
  const cmc = Math.floor(Number(dc.cmc ?? 0))
  if (cmc >= 7) return '7+'
  return String(Math.max(0, cmc))
}

export const COLOR_GROUP_ORDER = ['White', 'Blue', 'Black', 'Red', 'Green', 'Multicolor', 'Colorless', 'Lands']

const MONO_COLOR_NAMES = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' }

export function colorGroupKey(dc) {
  if (isLandCard(dc)) return 'Lands'
  const ci = (dc.color_identity || []).filter(c => MONO_COLOR_NAMES[c])
  if (ci.length === 0) return 'Colorless'
  if (ci.length === 1) return MONO_COLOR_NAMES[ci[0]]
  return 'Multicolor'
}

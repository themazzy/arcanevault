// Commander "build from collection" assistant.
//
// This module is pure and synchronous (except `enrichPlanWithEdhrec`, which
// wraps a single network call): given a commander, the user's owned cards, and
// Scryfall metadata, it sorts color-legal owned cards into a small set of
// *coarse build roles* (Ramp, Draw, Removal, …) and compares each
// role's count against a target quota, surfacing the gaps a player should fill.
//
// It deliberately reuses the existing functional classifier in cardCategory.js
// rather than re-deriving roles — `coarseRole()` is just a bucketing layer over
// `getCardCategoryFromCard`.

import { getCardCategoryFromCard } from './cardCategory'
import { getCardLegalityWarnings } from './deckLegality'
import { isMassLandDenial, isExtraTurn } from './commanderBracket'
import { cardNameMatchKeys, isGroupFolder } from './deckBuilderHelpers'

// ── Coarse role taxonomy ──────────────────────────────────────────────────────
// Collapses the ~30 granular categories from getCardCategory into the 8 build
// roles a deckbuilder reasons about. Anything not listed (Creature, Artifact,
// Enchantment, Instant, Sorcery, Planeswalker, Other type-fallbacks) falls
// through to Synergy — those are the deck's "stuff" that fills the remainder.

export const ROLE_RAMP = 'Ramp'
export const ROLE_DRAW = 'Draw'
export const ROLE_REMOVAL = 'Removal'
export const ROLE_WIPE = 'Board Wipe'
export const ROLE_PROTECTION = 'Protection'
export const ROLE_WINCON = 'Game Plan / Win Cons'
export const ROLE_SYNERGY = 'Synergy'
export const ROLE_LANDS = 'Lands'

// Display + iteration order for the wizard (Lands last — handled separately by
// most players, and Synergy is the catch-all remainder before it).
export const ROLE_ORDER = [
  ROLE_RAMP,
  ROLE_DRAW,
  ROLE_REMOVAL,
  ROLE_WIPE,
  ROLE_PROTECTION,
  ROLE_WINCON,
  ROLE_SYNERGY,
  ROLE_LANDS,
]

// Granular category (from getCardCategory) → coarse role. Categories absent
// here resolve to Synergy via COARSE_ROLE_MAP's lookup default.
export const COARSE_ROLE_MAP = {
  Ramp: ROLE_RAMP,
  'Cost Reduction': ROLE_RAMP,

  'Card Draw': ROLE_DRAW,
  Tutor: ROLE_DRAW,

  Removal: ROLE_REMOVAL,
  Burn: ROLE_REMOVAL,
  Counterspell: ROLE_REMOVAL,

  'Board Wipe': ROLE_WIPE,

  Protection: ROLE_PROTECTION,

  Combo: ROLE_WINCON,
  'Extra Turns': ROLE_WINCON,
  Drain: ROLE_WINCON,
  Finisher: ROLE_WINCON,

  Land: ROLE_LANDS,

  // Everything else (Tokens, Anthem, +1/+1 Counters, Sacrifice, Blink,
  // Landfall, Lifegain, Copy, Doublers, Cheat, Graveyard, Mill, Discard, Stax,
  // Evasion, Creature, Artifact, Enchantment, Instant, Sorcery, Planeswalker,
  // Other) → Synergy, handled by the default in `granularToCoarse`.
}

export function granularToCoarse(granularCategory) {
  return COARSE_ROLE_MAP[granularCategory] || ROLE_SYNERGY
}

// EDHREC cardviews carry no oracle text, so not-owned upgrades can't go through
// the regex classifier. Their EDHREC section header is the best functional hint
// we have ("Mana Artifacts" → Ramp, "Card Draw" → Draw, …). Returns a
// coarse role or null when the header is type-based ("Creatures", "Instants")
// and the caller should fall back to type-line classification.
export function edhrecHeaderToRole(header = '') {
  const h = header.toLowerCase()
  if (/\bland/.test(h)) return ROLE_LANDS
  if (/\bramp\b|mana (rock|artifact|dork)|mana artifact/.test(h)) return ROLE_RAMP
  if (/card (draw|advantage)|\bdraw\b/.test(h)) return ROLE_DRAW
  if (/board ?wipe|sweeper|wrath/.test(h)) return ROLE_WIPE
  if (/protect/.test(h)) return ROLE_PROTECTION
  if (/removal|interaction|counter/.test(h)) return ROLE_REMOVAL
  return null
}

/** Coarse build role for an owned card row + its Scryfall metadata. */
export function coarseRole(card, sfCard) {
  return granularToCoarse(getCardCategoryFromCard(card, sfCard))
}

// Resolve the build role of a card already in the deck. Oracle-text
// classification wins when it's confident (a non-Synergy role), since it's the
// most reliable signal; otherwise we defer to the plan's EDHREC-derived role
// (which can re-bucket cards the regex misses, e.g. a mana rock with no cached
// oracle). This ordering stops a stale/empty plan role from overriding a
// correct oracle classification — which was collapsing every role into Synergy
// when the assistant opened on a filled deck.
export function roleOfDeckCard(dc, sfMap, roleByName) {
  const sfCard = sfMap?.[dc?.scryfall_id] || null
  const byOracle = coarseRole(dc, sfCard)
  if (byOracle !== ROLE_SYNERGY) return byOracle
  // Try the front-face key too — EDHREC upgrade entries name DFCs by front face
  for (const key of cardNameMatchKeys(dc?.name)) {
    const role = roleByName?.get(key)
    if (role) return role
  }
  return ROLE_SYNERGY
}

// Live per-role counts from the actual deck contents (commander excluded),
// using roleOfDeckCard so the progress bars match how the steps display cards.
export function countByRole(deckCards, sfMap, roleByName) {
  const counts = new Map(ROLE_ORDER.map(r => [r, 0]))
  for (const dc of deckCards || []) {
    if (dc?.is_commander) continue
    const role = roleOfDeckCard(dc, sfMap, roleByName)
    counts.set(role, (counts.get(role) || 0) + (dc.qty || 1))
  }
  return counts
}

// Pick the cheapest English printing from candidates already sorted
// cheapest-first. `langById` maps a printing's scryfall id → its language.
// Returns the chosen candidate (so a foreign printing that happens to be
// cheaper is skipped), or null when none of the candidates are English.
export function pickCheapestEnglish(candidates, langById) {
  for (const c of candidates || []) {
    if (c?.id && langById?.get?.(c.id) === 'en') return c
  }
  return null
}

// ── Binder availability ───────────────────────────────────────────────────────
// Owned copies available for building are the BINDER-placed ones: a card whose
// every placement is a collection-deck allocation is already in use by another
// deck and must not be offered as "from your collection". Group folders are
// organisational containers and never hold cards. Returns the Set of cards.id
// values with at least one binder placement; callers pre-filter
// analyzeBuildPlan's ownedCards with it.
export function binderPlacedCardIds(folders, folderCards) {
  const binderIds = new Set()
  for (const f of folders || []) {
    if (f?.type === 'binder' && f.id && !isGroupFolder(f)) binderIds.add(f.id)
  }
  const out = new Set()
  for (const fc of folderCards || []) {
    if (fc?.card_id && binderIds.has(fc.folder_id) && (fc.qty ?? 1) > 0) out.add(fc.card_id)
  }
  return out
}

// ── Commander deck template ───────────────────────────────────────────────────
// Target quotas for a typical Commander deck. `ideal` drives gap math and the
// wizard progress bars; `min` flags a role as under-built. Synergy is the
// remainder: whatever's left after the other roles + lands fill the 100 slots.
// Tunable in one place.

export const COMMANDER_DECK_SIZE = 100 // includes the commander

export const COMMANDER_TEMPLATE = {
  [ROLE_LANDS]: { min: 36, ideal: 37 },
  [ROLE_RAMP]: { min: 10, ideal: 11 },
  [ROLE_DRAW]: { min: 10, ideal: 12 },
  [ROLE_REMOVAL]: { min: 8, ideal: 10 },
  [ROLE_WIPE]: { min: 2, ideal: 3 },
  [ROLE_PROTECTION]: { min: 3, ideal: 4 },
  [ROLE_WINCON]: { min: 3, ideal: 10 },
  [ROLE_SYNERGY]: 'remainder', // remainder shrinks by the net +3 above (15 → 12)
}

// ── Face-aware card text ──────────────────────────────────────────────────────
// MDFC / transform / split cards carry their second half in card_faces[]. A
// cached entry's top-level oracle_text/type_line is the front face only (or,
// for a card_prints-sourced entry, both faces already joined). To reason about
// the WHOLE card — a back-face land that taps for mana, a back-face Armageddon,
// the land half of a spell//land MDFC — we scan every face's text/type together.
// Duplication (when the top-level field already concatenates faces) is harmless:
// these strings are only regex-scanned / substring-tested, never displayed.
export function faceOracleText(sf, card) {
  const parts = []
  const top = sf?.oracle_text ?? card?.oracle_text
  if (top) parts.push(top)
  for (const f of sf?.card_faces || []) if (f?.oracle_text) parts.push(f.oracle_text)
  return parts.join('\n')
}
export function faceTypeLine(sf, card) {
  const parts = []
  const top = sf?.type_line ?? card?.type_line
  if (top) parts.push(top)
  for (const f of sf?.card_faces || []) if (f?.type_line) parts.push(f.type_line)
  return parts.join(' // ')
}

// ── Bracket flags ─────────────────────────────────────────────────────────────
// Does a card raise the deck's Commander Bracket? Game Changers are matched by
// name (works for unowned EDHREC upgrades too, where we have no oracle text);
// mass land denial / extra turns need oracle text (owned cards). Both faces are
// scanned, so a back-face Armageddon / extra-turn on an MDFC is caught. Returns
// { label, level } (the bracket floor the card implies) or null.
export function bracketFlagFor(name, sfCard, gameChangerNames) {
  const lower = String(name || '').toLowerCase()
  if (gameChangerNames && (gameChangerNames.has(lower) || gameChangerNames.has(lower.split('//')[0].trim()))) {
    return { label: 'Game Changer', level: 3 }
  }
  const oracle = faceOracleText(sfCard)
  if (oracle && isMassLandDenial(oracle)) return { label: 'Land denial', level: 4 }
  if (oracle && isExtraTurn(oracle)) return { label: 'Extra turn', level: 2 }
  return null
}

// ── Mana base analysis ────────────────────────────────────────────────────────
// Parse the colors a card can produce, and whether it's a (repeatable) mana
// source — used to count colored sources in the manabase step.

export const WUBRG = ['W', 'U', 'B', 'R', 'G']
const BASIC_SUBTYPE = { plains: 'W', island: 'U', swamp: 'B', mountain: 'R', forest: 'G' }

// Colors a card can add. Basic land subtypes count; "add … any color/type"
// counts as all five; otherwise we scan each "add" clause for mana symbols
// (incl. hybrid pips like {W/U}). Returns a Set of WUBRG letters.
export function producedColors(oracleText = '', typeLine = '') {
  const out = new Set()
  const t = String(typeLine).toLowerCase()
  for (const [sub, col] of Object.entries(BASIC_SUBTYPE)) {
    if (t.includes(sub)) out.add(col)
  }
  const clauses = String(oracleText).toLowerCase().split(/[.\n;]/).filter(c => c.includes('add'))
  for (const clause of clauses) {
    if (/\bany (color|type)\b/.test(clause)) { WUBRG.forEach(c => out.add(c)); continue }
    for (const c of WUBRG) {
      if (new RegExp(`\\{[^}]*${c.toLowerCase()}[^}]*\\}`).test(clause)) out.add(c)
    }
  }
  return out
}

// A repeatable mana source: any land, or a permanent with a "{T}: Add …"
// ability (mana rocks / dorks). One-shot rituals (no {T}) are excluded.
export function isManaSource(oracleText = '', typeLine = '') {
  if (String(typeLine).toLowerCase().includes('land')) return true
  return /\{t\}[^.]*\badd\b/.test(String(oracleText).toLowerCase())
}

// Per-color source count for a set of deck cards (each { sfCard?, type_line?,
// oracle_text?, qty? }). Counts a card toward a color when it's a mana source
// that can produce that color. Returns a map { W, U, B, R, G } (+ total lands).
export function countManaSources(cards, sfMapOrGetter) {
  const counts = { W: 0, U: 0, B: 0, R: 0, G: 0 }
  let lands = 0
  const getSf = typeof sfMapOrGetter === 'function'
    ? sfMapOrGetter
    : (c) => (sfMapOrGetter || {})[c?.scryfall_id] || null
  for (const c of cards || []) {
    const sf = getSf(c)
    // Face-aware: a spell//land MDFC or a transforming land taps for mana and
    // plays as a land off its back face, which the front-face-only type/oracle
    // would miss entirely.
    const oracle = faceOracleText(sf, c)
    const typeLine = faceTypeLine(sf, c)
    const qty = c?.qty || 1
    if (typeLine.toLowerCase().includes('land')) lands += qty
    if (!isManaSource(oracle, typeLine)) continue
    for (const col of producedColors(oracle, typeLine)) counts[col] += qty
  }
  return { ...counts, lands }
}

// ── Karsten colored-source requirements ───────────────────────────────────────
// From Frank Karsten's "How Many Sources Do You Need to Consistently Cast Your
// Spells? A 2022 Update" (TCGplayer Infinite), 99-card Commander column —
// assumes ~41 lands, the Commander free mulligan + opening draw, and ~90%
// on-curve castability. KARSTEN_99[pips][cmc] = colored sources of one color
// the deck should run to cast a spell with that many pips on curve.
const KARSTEN_99 = {
  1: { 1: 19, 2: 19, 3: 18, 4: 16, 5: 15, 6: 14 },
  2: { 2: 30, 3: 28, 4: 26, 5: 23, 6: 22, 7: 20 },
  3: { 3: 36, 4: 33, 5: 30, 6: 28, 7: 26 },
  4: { 4: 39, 5: 36 },
}

// Sources needed for `pips` pips of one color on a spell of mana value `cmc`.
// CMC clamps into the table's range (cheaper spells can't have that many pips;
// pricier ones keep the last row's requirement). 5+ pips reuse the 4-pip row.
export function karstenSourcesNeeded(pips, cmc) {
  const row = KARSTEN_99[Math.min(4, Math.max(1, pips))]
  const turns = Object.keys(row).map(Number)
  const t = Math.min(Math.max(Math.round(cmc || 0), Math.min(...turns)), Math.max(...turns))
  return row[t]
}

// Per-color source targets for a deck: Karsten's method — the deck's most
// demanding spell of each color sets that color's requirement. Only strict
// single-color pips count ({W}); hybrid ({W/U}, {2/W}) and Phyrexian ({W/P})
// pips are payable another way and set no hard requirement. Lands are skipped;
// the commander is included (cards array decides). Returns
// { W: { needed, pips, cmc, card }, … } for colors with at least one pip.
export function karstenColorRequirements(cards, sfMapOrGetter) {
  const getSf = typeof sfMapOrGetter === 'function'
    ? sfMapOrGetter
    : (c) => (sfMapOrGetter || {})[c?.scryfall_id] || null
  const out = {}
  for (const c of cards || []) {
    const sf = getSf(c)
    const typeLine = (sf?.type_line || c?.type_line || '').toLowerCase()
    if (typeLine.includes('land')) continue
    const cost = sf?.mana_cost || c?.mana_cost || ''
    const cmc = sf?.cmc ?? c?.cmc ?? 0
    const pipCounts = {}
    for (const sym of String(cost).match(/\{[^}]+\}/g) || []) {
      const inner = sym.slice(1, -1).toUpperCase()
      if (WUBRG.includes(inner)) pipCounts[inner] = (pipCounts[inner] || 0) + 1
    }
    for (const [col, pips] of Object.entries(pipCounts)) {
      const needed = karstenSourcesNeeded(pips, cmc)
      if (!out[col] || needed > out[col].needed) {
        out[col] = { needed, pips, cmc, card: c?.name || sf?.name || '' }
      }
    }
  }
  return out
}

// ── Basic land split ──────────────────────────────────────────────────────────
// We don't want the Lands step to fill all ~37 slots with nonbasic/utility
// lands. Instead the player adds owned nonbasics up to a target, and basics top
// the manabase up to the land count automatically on finish — split across the
// commander's colors by the deck's actual colored-pip demand.

export const BASIC_LAND_BY_COLOR = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' }
const BASIC_LAND_NAME_SET = new Set(Object.values(BASIC_LAND_BY_COLOR).map(n => n.toLowerCase()))

// Rough basic-land count by number of colors in the identity — the rest of the
// manabase is nonbasic fixing. Grounded in common Commander manabase guidance:
// mono decks run mostly basics, and each extra color trades basics for duals /
// fetches / fixing. Used only to suggest the nonbasic target in the Lands step;
// the actual auto-fill tops the deck up to its land target regardless.
export function recommendedBasicCount(numColors) {
  switch (numColors) {
    case 0: return 0  // colorless — Wastes / utility lands, no basics auto-added
    case 1: return 28
    case 2: return 13
    case 3: return 9
    case 4: return 5
    default: return 3 // 5-color
  }
}

// Colored pip demand across the deck's nonland cards (mana symbols in each cost;
// a hybrid pip counts toward each half). Returns { W, U, B, R, G }.
export function countColorPips(cards, sfMapOrGetter) {
  const counts = { W: 0, U: 0, B: 0, R: 0, G: 0 }
  const getSf = typeof sfMapOrGetter === 'function'
    ? sfMapOrGetter
    : (c) => (sfMapOrGetter || {})[c?.scryfall_id] || null
  for (const c of cards || []) {
    if (c?.is_commander) continue
    const sf = getSf(c)
    const type = (sf?.type_line || c?.type_line || '').toLowerCase()
    if (type.includes('land')) continue
    const cost = sf?.mana_cost || c?.mana_cost || ''
    const qty = c?.qty || 1
    for (const sym of String(cost).match(/\{[^}]+\}/g) || []) {
      for (const col of WUBRG) if (sym.includes(col)) counts[col] += qty
    }
  }
  return counts
}

// Plan the basic lands to ADD so total lands reach the land target. Two-phase
// split across the commander's colors: first close Karsten source shortfalls
// (each basic is +1 source of its color, so basics go greedily to the color
// furthest below its per-deck target), then distribute what's left by pip
// demand (even split when there's no pip data). Purely additive and
// idempotent: re-running once the target is met adds nothing. Returns
// { counts: { Forest: n, … }, total } (names → copies to add).
export function planBasicLands({ deckCards = [], sfMap = {}, colors = [], landTarget = 37 } = {}) {
  const ids = (colors || []).filter(c => WUBRG.includes(c))
  if (!ids.length) return { counts: {}, total: 0 }

  const getSf = (c) => sfMap[c?.scryfall_id] || null
  let lands = 0
  for (const c of deckCards) {
    if (c?.is_commander) continue
    const sf = getSf(c)
    const type = (sf?.type_line || c?.type_line || '').toLowerCase()
    if (type.includes('land')) lands += (c?.qty || 1)
  }
  const needed = Math.max(0, landTarget - lands)
  if (!needed) return { counts: {}, total: 0 }

  const alloc = Object.fromEntries(ids.map(col => [col, 0]))
  let left = needed

  // Phase 1 — Karsten shortfalls. Greedy by largest remaining shortfall (ties
  // resolve in commander-color order), decrementing as we go since each added
  // basic is itself a source.
  const reqs = karstenColorRequirements(deckCards, sfMap)
  const sources = countManaSources(deckCards, sfMap)
  const shortfall = {}
  for (const col of ids) {
    shortfall[col] = Math.max(0, (reqs[col]?.needed || 0) - (sources[col] || 0))
  }
  while (left > 0) {
    let best = null
    for (const col of ids) {
      if (shortfall[col] > 0 && (best == null || shortfall[col] > shortfall[best])) best = col
    }
    if (best == null) break
    alloc[best]++
    shortfall[best]--
    left--
  }

  // Phase 2 — pip-weighted largest-remainder apportionment for the rest, so
  // the counts sum to exactly `needed`.
  if (left > 0) {
    const pips = countColorPips(deckCards, sfMap)
    let weights = ids.map(col => pips[col])
    let sum = weights.reduce((a, b) => a + b, 0)
    if (sum <= 0) { weights = ids.map(() => 1); sum = ids.length } // no pip data → even

    const slots = ids.map((col, i) => {
      const exact = (left * weights[i]) / sum
      const n = Math.floor(exact)
      return { col, n, frac: exact - n }
    })
    let remainder = left - slots.reduce((a, s) => a + s.n, 0)
    slots.sort((a, b) => b.frac - a.frac)
    for (let i = 0; i < slots.length && remainder > 0; i++, remainder--) slots[i].n++
    for (const s of slots) alloc[s.col] += s.n
  }

  const counts = {}
  for (const col of ids) if (alloc[col] > 0) counts[BASIC_LAND_BY_COLOR[col]] = alloc[col]
  return { counts, total: needed }
}

// Basics to add when auto-fill finishes: planBasicLands's Karsten/pip color
// split, but capped to the deck's open slots so the deck lands at exactly
// deckSize. Without the cap a DFC/MDFC land (e.g. Treasure Map // Treasure Cove)
// can be typed as a land in the candidate pool that picked it yet as a nonland
// in the freshly-added row's type_line — the "landTarget − lands" math then
// over-counts the basics needed and the deck finishes at 101. Re-running with a
// reduced target keeps the shortfall-first split while pinning the total to the
// open slots. `openSlots` clamps to ≥ 0. Returns { counts, total }.
export function basicsForAutoFill({ deckCards = [], sfMap = {}, colors = [], landTarget = 37, openSlots = 0 } = {}) {
  const slots = Math.max(0, openSlots)
  const planned = planBasicLands({ deckCards, sfMap, colors, landTarget })
  if (planned.total <= slots) return planned
  return planBasicLands({ deckCards, sfMap, colors, landTarget: landTarget - planned.total + slots })
}

// True for a basic land by name (used to keep basics out of the nonbasic step).
export function isBasicLandName(name) {
  return BASIC_LAND_NAME_SET.has(String(name || '').toLowerCase())
}

// ── Cut helper ────────────────────────────────────────────────────────────────
// Rank deck cards by how cuttable they are (most-cuttable first) to help trim an
// over-100 deck. Three modes; Balanced is the user-facing default.

export const CUT_MODES = [
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Weighs play rate, mana cost, and overfilled categories together. A safe all-round pick.',
  },
  {
    id: 'popularity',
    label: 'Least played',
    description: 'Cuts the cards the fewest Commander decks run, first.',
  },
  {
    id: 'redundancy',
    label: 'Trim excess',
    description: 'Cuts from the categories you have the most extra cards in (e.g. too much ramp), first.',
  },
]

// Short human reason a card is suggested for the cut.
function cutReason(c, mode) {
  if (mode === 'redundancy' && c.roleOver > 0) return `extra ${c.role}`
  if (c.hasData && c.inclusion < 30) return 'rarely played'
  if (c.roleOver > 0) return `extra ${c.role}`
  if ((c.cmc || 0) >= 5) return 'high CMC'
  if (!c.hasData) return 'off-meta'
  return 'trim'
}

/**
 * Rank cut candidates most-cuttable first.
 * @param {Array} candidates each { id, name, role, cmc, inclusion, hasData, roleOver }
 *   - inclusion: EDHREC inclusion % (0 when unknown)
 *   - hasData:   whether EDHREC actually lists the card. Distinguishes a card
 *     that's genuinely *unpopular* (cuttable) from one that's simply off-meta /
 *     not on the commander's page — the latter gets a neutral score in Balanced
 *     so the player's own pet cards aren't auto-dumped.
 *   - roleOver:  how many copies the card's role is above its target (0 if within)
 * @param {string} mode  'balanced' | 'popularity' | 'redundancy'
 * @returns {Array} new array sorted desc by cuttability, each with `reason`.
 */
export function rankCutCandidates(candidates, mode = 'balanced') {
  const scored = (candidates || []).map(c => {
    const inclusion = Math.max(0, Math.min(100, c.inclusion || 0))
    // Popularity → cuttability. Unknown cards are neutral (50) except in
    // popularity mode, where the player explicitly wants raw inclusion to rule.
    const pop = c.hasData ? inclusion : (mode === 'popularity' ? 0 : 50)
    const popCut = 100 - pop                 // 0..100, higher = more cuttable
    const cmcCut = Math.min(10, c.cmc || 0) * 4 // 0..40
    const redun = Math.max(0, c.roleOver || 0) * 12
    let score
    if (mode === 'popularity') score = popCut + cmcCut * 0.25
    else if (mode === 'redundancy') score = redun * 2 + popCut * 0.4 + cmcCut * 0.2
    else score = popCut * 0.6 + cmcCut * 0.4 + redun // balanced
    return { ...c, score }
  })
  scored.sort((a, b) =>
    (b.score - a.score) ||
    ((a.inclusion || 0) - (b.inclusion || 0)) ||
    ((b.cmc || 0) - (a.cmc || 0)) ||
    String(a.name || '').localeCompare(String(b.name || '')),
  )
  return scored.map(c => ({ ...c, reason: cutReason(c, mode) }))
}

// ── Auto-fill ─────────────────────────────────────────────────────────────────
// One-click fill: pick the top candidates for every role's remaining gap. Pure
// planning only — the caller adds the picks (and the basics). Two sources:
//   'owned'        — binder-placed candidates only, in their given order.
//   'recommended'  — ownership-blind: each role's owned candidates and unowned
//                    suggestions (`spec.upgrades` / `landUpgrades`) are merged
//                    and re-ranked purely by recommendation strength (EDHREC
//                    inclusion %, or recommander score for score-only picks),
//                    so the deck is "what the data says", not "what I own".
// Slot math: whatever the deck still needs to reach `deckSize` is split into a
// lands reserve (filled here with nonbasics up to `nonbasicTarget`, the rest
// left for basics) and a nonland budget spent role-by-role in template order.
// `exclude` injects the caller's live filters (already added, over budget,
// over the target bracket). Each name is picked at most once (singleton).
//
// Returns [{ role, cand, owned }] in add order.
// Recommendation strength of an upgrade/candidate: EDHREC inclusion % or the
// recommander score scaled to the same 0-100 range, whichever is higher.
// Shared by auto-fill ranking and selectUpgrades' blended sort.
export function recRank(c) {
  return Math.max(c?.edhrecInclusion || 0, Math.round((c?.score || 0) * 100))
}

// ── Upgrade pool sizing ───────────────────────────────────────────────────────
// Two caps, deliberately different:
//   • display  — how many suggestion tiles a role shows on screen (small).
//   • retained — how many candidates each role KEEPS in the plan. Kept much
//     deeper than the display cap so that budget / bracket / owned filters
//     applied downstream (and auto-fill's exclude gate) still have candidates
//     left under harsh filters — a €1 budget can knock out most of a shallow
//     pool and starve auto-fill short of 100. Bounded so a huge EDHREC page
//     doesn't bloat state.
export function upgradeDisplayLimit(gap = 0) {
  return Math.max(24, (gap || 0) + 8)
}
export function upgradePoolDepth(gap = 0) {
  return Math.min(150, Math.max(75, (gap || 0) * 4 + 20))
}

// ── Curve-aware ranking ───────────────────────────────────────────────────────
// How well a card's mana value fits what the deck's curve NEEDS (lower = better
// fit): a deck already running pricier than target wants cheaper cards first,
// a cheap deck has room for a bomb, an on-curve deck prefers cards near target.
export function curveFitKey(cmc, curveStatus = 'on', targetCmc = 3) {
  const c = cmc ?? 0
  if (curveStatus === 'high') return c        // too pricey → cheaper first
  if (curveStatus === 'low') return -c        // too cheap → pricier first
  return Math.abs(c - (targetCmc ?? 3))       // on curve → nearest target first
}

// Auto-fill candidate comparator. Recommendation strength dominates — but it's
// BUCKETED (RANK_BUCKET-wide bands), so curve fit only reorders cards of
// *similar* quality and never demotes a clearly stronger card for a cheaper
// weaker one. With no curve target it collapses to the plain rank→cmc→name order
// (behavior unchanged). This is how the deck trends toward its target curve
// while still recommending the good cards.
const RANK_BUCKET = 6
function bestRankBucket(cand) {
  return Math.round(recRank(cand) / RANK_BUCKET)
}
function rankComparator(targetCmc, curveStatus) {
  if (targetCmc == null) {
    return (a, b) =>
      (recRank(b.cand) - recRank(a.cand)) ||
      ((a.cand.cmc ?? 0) - (b.cand.cmc ?? 0)) ||
      String(a.cand.name || '').localeCompare(b.cand.name || '')
  }
  return (a, b) =>
    (bestRankBucket(b.cand) - bestRankBucket(a.cand)) ||
    (curveFitKey(a.cand.cmc, curveStatus, targetCmc) - curveFitKey(b.cand.cmc, curveStatus, targetCmc)) ||
    (recRank(b.cand) - recRank(a.cand)) ||
    String(a.cand.name || '').localeCompare(b.cand.name || '')
}

export function planAutoFill({
  roles = [],              // plan.roles: [{ role, target, ownedCandidates, upgrades? }]
  liveCounts,              // Map role → current count (countByRole)
  totalCards = 0,          // current deck size incl. commander
  deckSize = COMMANDER_DECK_SIZE,
  landsTarget = 0,
  currentLands = 0,
  nonbasicTarget = 0,
  currentNonbasicLands = 0,
  landCandidates = [],     // nonbasic owned land candidates, fixers first
  landUpgrades = [],       // unowned land suggestions (used with source 'recommended')
  source = 'owned',        // 'owned' | 'recommended'
  targetCmc = null,        // target avg mana value; null = curve not considered
  curveStatus = 'on',      // 'high' | 'on' | 'low' — deck's current curve vs target
  exclude = () => false,
} = {}) {
  const picks = []
  const taken = new Set()
  const slotsLeft = Math.max(0, deckSize - totalCards)
  if (!slotsLeft) return picks

  const landsReserve = Math.min(slotsLeft, Math.max(0, landsTarget - currentLands))
  let nonlandBudget = slotsLeft - landsReserve
  const cmp = rankComparator(targetCmc, curveStatus)

  // Pool for a role under the chosen source: tagged { cand, owned } entries.
  // The owned-only pool keeps its incoming (inclusion) order unless a curve
  // target is set, in which case it's re-ranked curve-aware like the blended
  // pool — so "complete from binders" respects the curve too.
  const poolFor = (owned, upgrades) => {
    if (source !== 'recommended') {
      const pool = (owned || []).map(cand => ({ cand, owned: true }))
      return targetCmc == null ? pool : pool.sort(cmp)
    }
    return [
      ...(owned || []).map(cand => ({ cand, owned: true })),
      ...(upgrades || []).map(cand => ({ cand, owned: false })),
    ].sort(cmp)
  }

  // Take up to `need` picks from `pool`, honoring the shared name/exclude
  // gates. Returns how many were taken. Entries may carry their own role
  // (spillover pool); `role` is the fallback.
  const takeFrom = (pool, need, role) => {
    let n = 0
    for (const entry of pool) {
      if (n >= need) break
      const key = (entry.cand?.name || '').toLowerCase()
      if (!key || taken.has(key) || isBasicLandName(key) || exclude(entry.cand)) continue
      taken.add(key)
      picks.push({ role: entry.role || role, cand: entry.cand, owned: entry.owned })
      n++
    }
    return n
  }

  for (const spec of roles) {
    if (spec.role === ROLE_LANDS) continue
    const need = Math.min(
      Math.max(0, (spec.target || 0) - (liveCounts?.get?.(spec.role) || 0)),
      nonlandBudget,
    )
    if (need <= 0) continue
    nonlandBudget -= takeFrom(poolFor(spec.ownedCandidates, spec.upgrades), need, spec.role)
  }

  // Spillover: role quotas are ideals, not hard walls. When a role's pool ran
  // dry (or a role had no gap left to justify its pool), the remaining nonland
  // budget is spent on the best-ranked candidates left in ANY role's pool —
  // otherwise every starved role leaves permanent holes and the build lands
  // short of `deckSize` even though fitting cards exist elsewhere.
  if (nonlandBudget > 0) {
    const spill = []
    for (const spec of roles) {
      if (spec.role === ROLE_LANDS) continue
      for (const entry of poolFor(spec.ownedCandidates, spec.upgrades)) {
        spill.push({ ...entry, role: spec.role })
      }
    }
    spill.sort(cmp)
    nonlandBudget -= takeFrom(spill, nonlandBudget)
  }

  const landNeed = Math.min(Math.max(0, nonbasicTarget - currentNonbasicLands), landsReserve)
  if (landNeed > 0) takeFrom(poolFor(landCandidates, landUpgrades), landNeed, ROLE_LANDS)

  return picks
}

// ── Buy the gap ───────────────────────────────────────────────────────────────
// Deck cards not available in the user's binders, merged by name (a deck can
// hold several printings of one name). Basics are skipped — they're auto-added
// on finish and buying them is noise. Split into `toBuy` (not owned anywhere)
// and `elsewhere` (owned, but every copy is allocated to another deck — moving
// it is an alternative to buying). Both sorted by name.
export function buildBuyList(deckCards, availableNameKeys, elsewhereNameKeys) {
  const byName = new Map()
  for (const dc of deckCards || []) {
    const name = dc?.name
    if (!name || isBasicLandName(name)) continue
    const keys = cardNameMatchKeys(name)
    if (keys.some(k => availableNameKeys?.has?.(k))) continue
    const key = keys[0]
    const prev = byName.get(key)
    if (prev) { prev.qty += dc.qty || 1; continue }
    byName.set(key, {
      name,
      qty: dc.qty || 1,
      elsewhere: keys.some(k => elsewhereNameKeys?.has?.(k)),
    })
  }
  const all = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  return {
    toBuy: all.filter(m => !m.elsewhere),
    elsewhere: all.filter(m => m.elsewhere),
  }
}

// Plain-text buy list ("1 Sol Ring" lines) — the format every deck site's mass
// entry / import accepts.
export function buyListText(items) {
  return (items || []).map(m => `${m.qty} ${m.name}`).join('\n')
}

// TCGplayer Mass Entry deep link. DFC names are sent as the front face only —
// mass entry doesn't match "Front // Back".
export function tcgplayerMassEntryUrl(items) {
  if (!items?.length) return null
  const list = items
    .map(m => `${m.qty} ${String(m.name).split('//')[0].trim()}`)
    .join('||')
  return `https://www.tcgplayer.com/massentry?c=${encodeURIComponent(list)}`
}

// ── Cut-to-100 analysis ───────────────────────────────────────────────────────
// When the deck is over `deckSize`, rank every eligible card by cuttability
// (via rankCutCandidates) and recommend exactly the overage. Protections: the
// commander is never a candidate, locked ids are excluded, and lands are only
// eligible when the manabase is above its target — and then only the worst
// `landOver` nonbasics, so trimming never breaks the mana base. Pure; the
// component wraps this in a useMemo. `roleOf(dc)` resolves a deck card's coarse
// role (injected so the component can share its plan-aware classifier);
// `inclusionOf(name)` returns EDHREC inclusion % (0 when unknown).
export function analyzeCut({
  plan, deckCards = [], sfMap = {}, totalCards = 0, cutMode = 'balanced',
  lockedIds = new Set(), roleOf, inclusionOf,
}) {
  if (!plan) return null
  const over = totalCards - plan.deckSize
  const targets = new Map(plan.roles.map(r => [r.role, r.target]))
  const counts = new Map(ROLE_ORDER.map(r => [r, 0]))
  const rows = []
  let totalLands = 0
  for (const dc of deckCards || []) {
    if (dc?.is_commander) continue
    const sf = sfMap?.[dc?.scryfall_id] || null
    const name = dc.name || ''
    const role = roleOf(dc)
    counts.set(role, (counts.get(role) || 0) + (dc.qty || 1))
    const isLand = (sf?.type_line || dc?.type_line || '').toLowerCase().includes('land')
    if (isLand) totalLands += (dc.qty || 1)
    const inclusion = inclusionOf(name) ?? 0
    rows.push({
      id: dc.id, name, role, isLand,
      scryfall_id: dc.scryfall_id,
      cmc: sf?.cmc ?? dc?.cmc ?? 0,
      inclusion, hasData: inclusion > 0,
    })
  }
  if (over <= 0) return { over, cutTarget: 0, recommended: [], extra: [], landOver: 0 }

  const landTarget = targets.get(ROLE_LANDS) || 37
  const landOver = Math.max(0, totalLands - landTarget)
  const withRoleOver = r => ({ ...r, role: r.isLand ? ROLE_LANDS : r.role,
    roleOver: Math.max(0, (counts.get(r.role) || 0) - (targets.get(r.role) || 0)) })

  const nonland = rows.filter(r => !r.isLand && !lockedIds.has(r.id)).map(withRoleOver)
  // Only nonbasic lands are cuttable (singletons); basics are multi-copy rows
  // managed by the lands step, so cutting one would gut the manabase.
  let landPool = []
  if (landOver > 0) {
    const lands = rows.filter(r => r.isLand && !isBasicLandName(r.name) && !lockedIds.has(r.id)).map(withRoleOver)
    landPool = rankCutCandidates(lands, cutMode).slice(0, landOver)
  }
  const ranked = rankCutCandidates([...nonland, ...landPool], cutMode)
  return {
    over,
    cutTarget: over,
    recommended: ranked.slice(0, over),
    extra: ranked.slice(over, over + 6), // a few more "also consider"
    landOver,
  }
}

// ── Combo inclusion by bracket ────────────────────────────────────────────────
// How many-piece a combo should be to suit a target Commander Bracket, following
// the WotC bracket guidance that fast 2-card infinite combos belong to
// high-power decks while lower brackets prefer longer chains — or none:
//   • null (Any) / 4+ (Optimized, cEDH) : any combo, incl. fast 2-card
//   • 3        (Upgraded)                : 3-or-more-card combos only
//   • ≤ 2      (Core / Exhibition)       : no combos suggested
// `pieceCount` is the total number of cards the combo uses.
export function comboFitsBracket(pieceCount, targetBracket) {
  if (targetBracket == null) return true
  if (targetBracket >= 4) return true
  if (targetBracket === 3) return (pieceCount || 0) >= 3
  return false
}

// ── Archetype-aware quota flexing ─────────────────────────────────────────────
// A selected EDHREC theme (Tokens, Spellslinger, Voltron, …) nudges the role
// quotas. Deltas only touch the FIXED roles — Synergy is the remainder, so
// trimming fixed roles automatically grows the themed-synergy slots, and adding
// to them shrinks it. First matching rule wins (slug matched case-insensitively).
export const ARCHETYPE_RULES = [
  { match: /voltron|aura|equipment|enchantress/, deltas: { [ROLE_PROTECTION]: 3, [ROLE_RAMP]: 1, [ROLE_WIPE]: -2 } },
  { match: /superfriends|planeswalker|\bwalkers?\b/, deltas: { [ROLE_PROTECTION]: 2, [ROLE_RAMP]: 1, [ROLE_WIPE]: 1, [ROLE_REMOVAL]: 1 } },
  { match: /spell|storm|magecraft|prowess|cantrip/, deltas: { [ROLE_DRAW]: 2, [ROLE_REMOVAL]: 1 } },
  { match: /control|tempo/, deltas: { [ROLE_REMOVAL]: 2, [ROLE_DRAW]: 1, [ROLE_WIPE]: 1 } },
  { match: /\bcombo\b/, deltas: { [ROLE_DRAW]: 2, [ROLE_PROTECTION]: 1, [ROLE_REMOVAL]: 1 } },
  { match: /infect|poison|toxic/, deltas: { [ROLE_PROTECTION]: 2, [ROLE_WIPE]: -1 } },
  { match: /land|landfall/, deltas: { [ROLE_LANDS]: 2, [ROLE_RAMP]: 1 } },
  { match: /token|\bgo.?wide\b|swarm/, deltas: { [ROLE_REMOVAL]: -1, [ROLE_WIPE]: -1 } },
  { match: /sacrifice|aristocrat|\bblood\b|morbid|\bdeath/, deltas: { [ROLE_REMOVAL]: -1 } },
  { match: /counter/, deltas: { [ROLE_DRAW]: 1, [ROLE_WIPE]: -1 } },
  { match: /stax|hatebear|\btax(es)?\b|prison/, deltas: { [ROLE_RAMP]: 1 } },
  { match: /reanimat|graveyard|recursion|self.?mill/, deltas: { [ROLE_DRAW]: 1 } },
  { match: /lifegain|life.?gain/, deltas: { [ROLE_WIPE]: -1 } },
  { match: /aggro|aggression|\bhaste\b/, deltas: { [ROLE_LANDS]: -1, [ROLE_RAMP]: -1 } },
]

// Returns the quota delta map for a theme slug ({} when no rule matches / balanced).
export function archetypeAdjustments(themeSlug = '') {
  const slug = String(themeSlug || '').toLowerCase()
  if (!slug) return {}
  const rule = ARCHETYPE_RULES.find(r => r.match.test(slug))
  return rule ? rule.deltas : {}
}

// Returns a new template with the (fixed-role) deltas applied. Counts clamp at
// 0 and min never exceeds ideal. Synergy stays 'remainder'.
export function applyTemplateAdjustments(template, deltas = {}) {
  if (!deltas || !Object.keys(deltas).length) return template
  const out = {}
  for (const role of Object.keys(template)) {
    const spec = template[role]
    const d = deltas[role]
    if (!spec || spec === 'remainder' || !d) { out[role] = spec; continue }
    const ideal = Math.max(0, (spec.ideal ?? 0) + d)
    const min = Math.min(ideal, Math.max(0, (spec.min ?? 0) + d))
    out[role] = { min, ideal }
  }
  return out
}

// Sum of fixed (non-remainder) ideal counts — used to compute the Synergy
// remainder target so role ideals always add up to the deck size.
function remainderTarget(template, deckSize) {
  let fixed = 0
  for (const role of Object.keys(template)) {
    const spec = template[role]
    if (spec && spec !== 'remainder') fixed += spec.ideal
  }
  // -1 for the commander itself, which occupies a slot but no role quota.
  return Math.max(0, deckSize - 1 - fixed)
}

// ── Build plan analysis ───────────────────────────────────────────────────────

/**
 * Build a Commander deck plan from owned cards.
 *
 * @param {Object}   args
 * @param {Object}   args.commander         { name, color_identity }
 * @param {Array}    args.ownedCards         owned card rows (from collection/IDB)
 * @param {Object}   args.sfMap             scryfall metadata map keyed by scryfall_id
 * @param {Array}    [args.currentDeckCards] cards already in the deck (wizard progress)
 * @param {Object}   [args.template]        role quota template
 * @param {number}   [args.deckSize]        total deck size incl. commander
 * @returns {BuildPlan}
 */
export function analyzeBuildPlan({
  commander,
  ownedCards = [],
  sfMap = {},
  currentDeckCards = [],
  template = COMMANDER_TEMPLATE,
  deckSize = COMMANDER_DECK_SIZE,
} = {}) {
  const commanderColorIdentity = Array.isArray(commander?.color_identity)
    ? commander.color_identity
    : []

  // Names already in the deck — used to mark candidates as added and to count
  // current per-role fill. Foil/non-foil collapse to the same name (singleton).
  const deckNames = new Set(
    currentDeckCards.flatMap(c => cardNameMatchKeys(c?.name)),
  )

  // ── Classify owned cards into roles, filtered by commander legality ─────────
  const buckets = new Map(ROLE_ORDER.map(r => [r, []]))
  let totalOwnedLegal = 0
  const seenNames = new Set() // de-dupe owned copies by name (singleton format)

  for (const card of ownedCards) {
    const sfCard = sfMap[card?.scryfall_id] || null
    const name = card?.name || sfCard?.name || ''
    const lowerName = name.toLowerCase()
    if (!lowerName || seenNames.has(lowerName)) continue

    // Tokens/emblems/dungeons can be physically owned (scanned alongside real
    // cards) but can never go in a deck. Their all-not_legal legalities are
    // often uncached, so the offline-first "default legal" fallback below would
    // otherwise let them through as candidates.
    const typeLine = (sfCard?.type_line || card?.type_line || '').toLowerCase()
    if (/\btoken\b|\bemblem\b|\bdungeon\b/.test(typeLine)) continue

    // Legality check needs color_identity + legalities; prefer the richer
    // Scryfall metadata, fall back to the owned row. Cards whose metadata hasn't
    // been fetched yet (no legalities) default to "legal" — offline-first, we'd
    // rather show an owned card than hide it on a cold cache.
    const legalityCard = {
      name,
      color_identity: sfCard?.color_identity || card?.color_identity || [],
      legalities: sfCard?.legalities || card?.legalities || {},
    }
    const warnings = getCardLegalityWarnings({
      card: legalityCard,
      formatId: 'commander',
      formatLabel: 'Commander',
      isEDH: true,
      commanderColorIdentity,
    })
    if (warnings.length) continue // outside color identity or banned/not legal

    seenNames.add(lowerName)
    totalOwnedLegal++

    const role = granularToCoarse(getCardCategoryFromCard(card, sfCard))
    buckets.get(role).push({
      card,
      sfCard,
      name,
      cmc: sfCard?.cmc ?? card?.cmc ?? 0,
      edhrecInclusion: 0, // populated by enrichPlanWithEdhrec
      inDeck: deckNames.has(lowerName),
    })
  }

  // Default ranking: lowest CMC first, then alphabetical. EDHREC enrichment
  // re-ranks by inclusion afterwards.
  for (const list of buckets.values()) {
    list.sort((a, b) => (a.cmc - b.cmc) || a.name.localeCompare(b.name))
  }

  // ── Per-role gap math ───────────────────────────────────────────────────────
  const synergyTarget = remainderTarget(template, deckSize)
  const roles = ROLE_ORDER.map(role => {
    const spec = template[role]
    const target = spec === 'remainder' ? synergyTarget : (spec?.ideal ?? 0)
    const candidates = buckets.get(role)
    const current = candidates.filter(c => c.inDeck).length
    return {
      role,
      target,
      current,
      gap: Math.max(0, target - current),
      ownedCandidates: candidates,
      edhrecUpgrades: [], // filled by enrichPlanWithEdhrec
    }
  })

  return {
    commander: commander || null,
    commanderColorIdentity,
    totalOwnedLegal,
    deckSize,
    roles,
  }
}

// ── EDHREC enrichment ─────────────────────────────────────────────────────────

/**
 * Overlay EDHREC data onto a plan: boost owned candidates that EDHREC players
 * run (re-ranking each role by inclusion), and fill `edhrecUpgrades` with
 * high-inclusion cards the user does NOT own, bucketed into the same coarse
 * roles. Degrades gracefully — returns the plan unchanged if EDHREC is null.
 *
 * @param {BuildPlan} plan
 * @param {Function}  fetchEdhrec  async (commanderName) => edhrec result | null
 *                                 (inject `fetchEdhrecCommander` from deckBuilderApi)
 * @returns {Promise<BuildPlan>}
 */
// EDHREC reports `inclusion` as a raw deck count with `potentialDecks` as the
// denominator; the figure players expect is the percentage. Falls back to the
// raw value when the denominator is absent (keeps older fixtures/data working).
export function edhrecInclusionPct(cv) {
  const inc = cv?.inclusion ?? 0
  const pot = cv?.potentialDecks ?? 0
  return pot > 0 ? Math.min(100, Math.round((inc / pot) * 100)) : inc
}

// Win-cons safety net. For creature-combat / voltron / aggro commanders the
// deck's actual win conditions are big evasive beaters that classify as
// Synergy, not one of the win-con categories (Combo / Extra Turns / Drain /
// Finisher). That can leave the Win Cons step empty even for a deck with an
// obvious game plan. When the win-con upgrade pool is short of the role's
// ideal, borrow the highest-inclusion unowned *creatures and planeswalkers*
// from the Synergy pool (planeswalkers are the finishers in a superfriends
// list) so the step always offers real threats. Moves (not copies) so a card
// never appears in two steps. Mutates + returns `upgradesByRole`.
export function backfillWinconUpgrades(upgradesByRole, ownedWinCount = 0) {
  const winPool = upgradesByRole.get(ROLE_WINCON) || []
  const target = COMMANDER_TEMPLATE[ROLE_WINCON]?.ideal || 10
  const short = target - ownedWinCount - winPool.length
  if (short <= 0) return upgradesByRole

  const syn = upgradesByRole.get(ROLE_SYNERGY) || []
  const takenIdx = new Set()
  const picks = []
  const threats = syn
    .map((u, i) => ({ u, i }))
    .filter(({ u }) => /(creature|planeswalker)/i.test(u.type || ''))
    .sort((a, b) => (b.u.edhrecInclusion || 0) - (a.u.edhrecInclusion || 0))
  for (const { u, i } of threats) {
    if (picks.length >= short) break
    picks.push(u)
    takenIdx.add(i)
  }
  if (!picks.length) return upgradesByRole

  upgradesByRole.set(ROLE_SYNERGY, syn.filter((_, i) => !takenIdx.has(i)))
  upgradesByRole.set(ROLE_WINCON, [...winPool, ...picks])
  return upgradesByRole
}

export async function enrichPlanWithEdhrec(plan, fetchEdhrec, fetchCardMeta) {
  if (!plan?.commander?.name || typeof fetchEdhrec !== 'function') return plan

  let data = null
  try {
    data = await fetchEdhrec(plan.commander.name)
  } catch {
    data = null
  }
  if (!data?.categories?.length) return plan

  // Flatten EDHREC cardviews into a name→{cv, header} map, keeping the best
  // inclusion seen (a card can appear in multiple EDHREC sections). We retain
  // the section header so not-owned upgrades can be bucketed functionally.
  const byName = new Map()
  for (const cat of data.categories) {
    for (const cv of cat.cards || []) {
      const key = (cv.name || '').toLowerCase()
      if (!key) continue
      const prev = byName.get(key)
      if (!prev || (cv.inclusion ?? 0) > (prev.cv.inclusion ?? 0)) {
        byName.set(key, { cv, header: cat.header || '' })
      }
    }
  }

  // Both full and front-face keys — EDHREC names DFCs by front face, owned
  // rows carry the full "Front // Back" name.
  const ownedNames = new Set()
  for (const role of plan.roles) {
    for (const c of role.ownedCandidates) for (const k of cardNameMatchKeys(c.name)) ownedNames.add(k)
  }

  // Resolve oracle text + art for the top unowned EDHREC cards so we can
  // classify them by *function* (Draw, Removal, …). EDHREC's default
  // sections are mostly type-based ("Creatures", "Instants") and only a couple
  // map to a role ("Mana Artifacts" → Ramp), so without rules text the
  // functional roles get no suggestions at all. Reuses the same batched name
  // lookup that resolves the tiles' art. Best-effort: degrades to header/type.
  let metaByName = new Map()
  if (typeof fetchCardMeta === 'function') {
    const unowned = [...byName.entries()]
      .filter(([key]) => !ownedNames.has(key))
      .sort((a, b) => (b[1].cv.inclusion ?? 0) - (a[1].cv.inclusion ?? 0))
      .slice(0, 250)
      .map(([, v]) => v.cv.name)
    if (unowned.length) {
      try {
        const metas = await fetchCardMeta(unowned)
        for (const m of metas || []) if (m?.name) metaByName.set(m.name.toLowerCase(), m)
      } catch { /* fall back to header/type classification below */ }
    }
  }

  // Bucket NOT-owned EDHREC cards into coarse roles. Prefer real oracle-text
  // classification when we resolved it; otherwise infer from the section header
  // ("Mana Artifacts" → Ramp) and fall back to the type line. The user confirms
  // each pick regardless.
  const upgradesByRole = new Map(ROLE_ORDER.map(r => [r, []]))
  for (const [key, { cv, header }] of byName) {
    if (ownedNames.has(key)) continue
    const meta = metaByName.get(key)
    const role = meta
      ? granularToCoarse(getCardCategoryFromCard(
          { type_line: meta.type_line || cv.type, oracle_text: meta.oracle_text || '' },
          { type_line: meta.type_line || cv.type, oracle_text: meta.oracle_text || '' }))
      : (edhrecHeaderToRole(header) ||
         granularToCoarse(getCardCategoryFromCard({ type_line: cv.type }, { type_line: cv.type })))
    upgradesByRole.get(role).push({
      name: cv.name,
      slug: cv.slug,
      // EDHREC's payload no longer carries cmc/type/color identity — prefer the
      // resolved metadata (our card RPC) so curve fit + display aren't all zero.
      cmc: meta?.cmc ?? cv.cmc ?? 0,
      type: meta?.type_line || cv.type || '',
      colorIdentity: meta?.color_identity || cv.colorIdentity || [],
      edhrecInclusion: edhrecInclusionPct(cv),
      image: meta?.image || null,
      source: 'edhrec',
    })
  }

  // Hybrid re-bucketing of owned candidates. EDHREC's own section is the most
  // reliable role signal we have for a card — it needs no oracle text, which the
  // local classifier depends on (and which is often missing on a cold cache).
  // So when an owned card EDHREC lists has a *function*-based header ("Mana
  // Artifacts" → Ramp, "Card Draw" → Draw), move it into that role and
  // tag it with EDHREC inclusion. Cards EDHREC doesn't list — or lists only under
  // a type-based header ("Creatures", "Instants") where edhrecHeaderToRole is
  // null — keep their local classification, so nothing the player owns vanishes.
  const rebucketed = new Map(ROLE_ORDER.map(r => [r, []]))
  for (const role of plan.roles) {
    for (const cand of role.ownedCandidates) {
      // byName is keyed by EDHREC names (front face for DFCs) — try both forms
      const entry = cardNameMatchKeys(cand.name).map(k => byName.get(k)).find(Boolean)
      const next = entry ? { ...cand, edhrecInclusion: edhrecInclusionPct(entry.cv) } : cand
      const edhrecRole = entry ? edhrecHeaderToRole(entry.header) : null
      ;(rebucketed.get(edhrecRole || role.role) || rebucketed.get(role.role)).push(next)
    }
  }

  // Safety net: top up a thin Win Cons pool with the deck's best creatures so
  // combat-combo / voltron commanders never see an empty step (see helper).
  backfillWinconUpgrades(upgradesByRole, (rebucketed.get(ROLE_WINCON) || []).length)

  // Return a cloned plan (new role objects + arrays) rather than mutating the
  // input in place: state-held arrays must not be mutated, and setPlan needs a
  // fresh reference to re-render. Per role:
  //   1) re-ranked owned candidates from the re-bucketed pool
  //   2) recompute current/gap (cards moved between roles), then attach the
  //      role's not-owned upgrade list, capped (under-built roles get headroom)
  const roles = plan.roles.map(role => {
    const ownedCandidates = (rebucketed.get(role.role) || [])
      .sort((a, b) =>
        (b.edhrecInclusion - a.edhrecInclusion) ||
        (a.cmc - b.cmc) ||
        a.name.localeCompare(b.name),
      )
    const current = ownedCandidates.filter(c => c.inDeck).length
    const gap = Math.max(0, role.target - current)
    const edhrecUpgrades = (upgradesByRole.get(role.role) || [])
      .sort((a, b) => b.edhrecInclusion - a.edhrecInclusion)
      .slice(0, upgradePoolDepth(gap))
    return { ...role, current, gap, ownedCandidates, edhrecUpgrades }
  })

  return { ...plan, roles }
}

// ── Recommander augmentation ──────────────────────────────────────────────────
// Attach deck-aware recommander.cards picks to a plan as a SEPARATE per-role
// list (role.recommenderUpgrades), so the UI can show EDHREC, recommander, or a
// blend. Each recRow is { name, type_line, oracle_text, cmc, colorIdentity,
// image, score } resolved from card_prints; we classify by real oracle text,
// drop owned cards, rank by score, and cap per role. Pure; returns a cloned
// plan (unchanged if nothing to add).
export function attachRecommenderUpgrades(plan, recRows) {
  if (!plan?.roles?.length || !recRows?.length) return plan

  const ownedNames = new Set()
  for (const role of plan.roles) {
    for (const c of role.ownedCandidates) for (const k of cardNameMatchKeys(c.name)) ownedNames.add(k)
  }

  const recByRole = new Map(ROLE_ORDER.map(r => [r, []]))
  const seen = new Set()
  let added = false
  for (const row of recRows) {
    const key = (row?.name || '').toLowerCase()
    if (!key || ownedNames.has(key) || seen.has(key)) continue
    seen.add(key)
    const role = granularToCoarse(getCardCategoryFromCard(
      { type_line: row.type_line, oracle_text: row.oracle_text || '' },
      { type_line: row.type_line, oracle_text: row.oracle_text || '' }))
    recByRole.get(role).push({
      name: row.name,
      slug: row.slug || null,
      cmc: row.cmc ?? 0,
      type: row.type_line || '',
      colorIdentity: row.colorIdentity || [],
      edhrecInclusion: 0,
      image: row.image || null,
      score: row.score ?? 0,
      source: 'recommander',
    })
    added = true
  }
  if (!added) return plan

  const roles = plan.roles.map(role => {
    const recs = (recByRole.get(role.role) || [])
      .sort((a, b) => (b.score - a.score) || (a.cmc - b.cmc) || a.name.localeCompare(b.name))
      .slice(0, upgradePoolDepth(role.gap || 0))
    return { ...role, recommenderUpgrades: recs }
  })
  return { ...plan, roles }
}

// The upgrade list to show for a role under a given suggestion source.
// 'edhrec' / 'recommander' return that source's list; 'both' merges them,
// de-duped by name (keeping the EDHREC entry for its inclusion %), ranked by
// the stronger of inclusion % / scaled score, capped to the role's headroom.
// `limit` caps the returned list. Default is the on-screen display cap; the
// auto-fill path passes a deep limit (or Infinity) so it can draw from the full
// retained pool after its own budget/bracket exclusions.
export function selectUpgrades(role, source = 'both', limit) {
  const cap = limit == null ? upgradeDisplayLimit(role?.gap || 0) : limit
  const edhrec = role?.edhrecUpgrades || []
  const rec = role?.recommenderUpgrades || []
  if (source === 'edhrec') return edhrec.slice(0, cap)
  if (source === 'recommander') return rec.slice(0, cap)
  const byName = new Map()
  for (const u of edhrec) byName.set(u.name.toLowerCase(), u)
  for (const u of rec) if (!byName.has(u.name.toLowerCase())) byName.set(u.name.toLowerCase(), u)
  return [...byName.values()]
    .sort((a, b) => (recRank(b) - recRank(a)) || (a.cmc - b.cmc) || a.name.localeCompare(b.name))
    .slice(0, cap)
}

// ── Mana curve targeting ──────────────────────────────────────────────────────
// The "right" average mana value differs by deck type: an aggressive or
// spellslinger list wants a low curve, a ramp / control / superfriends list
// tolerates a higher one. We target EDHREC's own data when we have it (the
// inclusion-weighted mean mana value of the cards real decks for this commander
// run — already theme-specific when a theme page was fetched), and fall back to
// a per-archetype heuristic otherwise.

// Per-archetype fallback target average mana value (nonland). First matching
// rule wins; default is a middling 3.2.
const CURVE_TARGET_RULES = [
  { match: /aggro|aggression|\bhaste\b|\bblitz\b/, avg: 2.6 },
  { match: /voltron|aura|equipment|hatebear|weenie/, avg: 2.8 },
  { match: /spell|storm|magecraft|prowess|cantrip/, avg: 2.9 },
  { match: /token|\bgo.?wide\b|swarm|sacrifice|aristocrat/, avg: 3.0 },
  { match: /\bcombo\b/, avg: 3.0 },
  { match: /control|tempo|stax|prison|\btax(es)?\b/, avg: 3.4 },
  { match: /reanimat|graveyard|recursion|self.?mill/, avg: 3.4 },
  { match: /land|landfall|ramp|big.?mana|superfriends|planeswalker/, avg: 3.6 },
]
export function archetypeTargetAvgCmc(themeSlug = '') {
  const slug = String(themeSlug || '').toLowerCase()
  const rule = slug && CURVE_TARGET_RULES.find(r => r.match.test(slug))
  return rule ? rule.avg : 3.2
}

// Inclusion-weighted mean nonland mana value across an EDHREC commander payload's
// cardviews. Returns null when the payload is missing or too sparse (< 15 nonland
// cardviews), so the caller falls back to the archetype heuristic.
export function edhrecTargetAvgCmc(edhrec) {
  let wsum = 0
  let w = 0
  let n = 0
  for (const cat of edhrec?.categories || []) {
    for (const cv of cat.cards || []) {
      if (/\bland\b/i.test(cv.type || '')) continue
      const cmc = cv.cmc ?? 0
      const weight = Math.max(1, cv.inclusion ?? 0)
      wsum += cmc * weight
      w += weight
      n++
    }
  }
  // wsum <= 0 means the payload carried no usable cmc (EDHREC dropped per-card
  // cmc from the commander page) — fall back to the archetype heuristic rather
  // than targeting an impossible average of 0 (which flags every deck as "high").
  if (n < 15 || w <= 0 || wsum <= 0) return null
  return wsum / w
}

// The target average mana value for a plan: EDHREC data first, archetype
// heuristic as the fallback. `themeSlug` narrows the heuristic when EDHREC is
// unavailable.
export function planTargetAvgCmc(edhrec, themeSlug = '') {
  return edhrecTargetAvgCmc(edhrec) ?? archetypeTargetAvgCmc(themeSlug)
}

// Deck's current average nonland mana value (commander excluded). Returns null
// for an empty nonland deck.
export function deckAvgCmc(deckCards, sfMapOrGetter) {
  const getSf = typeof sfMapOrGetter === 'function'
    ? sfMapOrGetter
    : (c) => (sfMapOrGetter || {})[c?.scryfall_id] || null
  let sum = 0
  let n = 0
  for (const c of deckCards || []) {
    if (c?.is_commander) continue
    const sf = getSf(c)
    const type = (sf?.type_line || c?.type_line || '').toLowerCase()
    if (type.includes('land')) continue
    const cmc = sf?.cmc ?? c?.cmc ?? 0
    const qty = c?.qty || 1
    sum += cmc * qty
    n += qty
  }
  return n ? sum / n : null
}

// Verdict comparing a deck's average mana value to its target. `tolerance` is
// the half-width of the "on curve" band. status ∈ 'low' | 'on' | 'high'.
export function curveVerdict(avg, target, tolerance = 0.35) {
  if (avg == null || target == null) return { status: 'on', delta: 0 }
  const delta = avg - target
  if (delta > tolerance) return { status: 'high', delta }
  if (delta < -tolerance) return { status: 'low', delta }
  return { status: 'on', delta }
}

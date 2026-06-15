// Commander "build from collection" assistant.
//
// This module is pure and synchronous (except `enrichPlanWithEdhrec`, which
// wraps a single network call): given a commander, the user's owned cards, and
// Scryfall metadata, it sorts color-legal owned cards into a small set of
// *coarse build roles* (Ramp, Card Advantage, Removal, …) and compares each
// role's count against a target quota, surfacing the gaps a player should fill.
//
// It deliberately reuses the existing functional classifier in cardCategory.js
// rather than re-deriving roles — `coarseRole()` is just a bucketing layer over
// `getCardCategoryFromCard`.

import { getCardCategoryFromCard } from './cardCategory'
import { getCardLegalityWarnings } from './deckLegality'
import { isMassLandDenial, isExtraTurn } from './commanderBracket'

// ── Coarse role taxonomy ──────────────────────────────────────────────────────
// Collapses the ~30 granular categories from getCardCategory into the 8 build
// roles a deckbuilder reasons about. Anything not listed (Creature, Artifact,
// Enchantment, Instant, Sorcery, Planeswalker, Other type-fallbacks) falls
// through to Synergy — those are the deck's "stuff" that fills the remainder.

export const ROLE_RAMP = 'Ramp'
export const ROLE_DRAW = 'Card Advantage'
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
// we have ("Mana Artifacts" → Ramp, "Card Draw" → Card Advantage, …). Returns a
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
  [ROLE_WIPE]: { min: 2, ideal: 4 },
  [ROLE_PROTECTION]: { min: 3, ideal: 5 },
  [ROLE_WINCON]: { min: 3, ideal: 5 },
  [ROLE_SYNERGY]: 'remainder',
}

// ── Bracket flags ─────────────────────────────────────────────────────────────
// Does a card raise the deck's Commander Bracket? Game Changers are matched by
// name (works for unowned EDHREC upgrades too, where we have no oracle text);
// mass land denial / extra turns need oracle text (owned cards). Returns
// { label, level } (the bracket floor the card implies) or null.
export function bracketFlagFor(name, sfCard, gameChangerNames) {
  const lower = String(name || '').toLowerCase()
  if (gameChangerNames && (gameChangerNames.has(lower) || gameChangerNames.has(lower.split('//')[0].trim()))) {
    return { label: 'Game Changer', level: 3 }
  }
  const oracle = sfCard?.oracle_text || ''
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
    const oracle = sf?.oracle_text || c?.oracle_text || ''
    const typeLine = sf?.type_line || c?.type_line || ''
    const qty = c?.qty || 1
    if (typeLine.toLowerCase().includes('land')) lands += qty
    if (!isManaSource(oracle, typeLine)) continue
    for (const col of producedColors(oracle, typeLine)) counts[col] += qty
  }
  return { ...counts, lands }
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
    currentDeckCards.map(c => (c?.name || '').toLowerCase()).filter(Boolean),
  )

  // ── Classify owned cards into roles, filtered by commander legality ─────────
  const buckets = new Map(ROLE_ORDER.map(r => [r, []]))
  let totalOwnedLegal = 0
  const seenNames = new Set() // de-dupe owned copies by name (singleton format)

  for (const card of ownedCards) {
    const sfCard = sfMap[card?.scryfall_id] || sfMap[card?.scryfall_id?.toString?.()] || null
    const name = card?.name || sfCard?.name || ''
    const lowerName = name.toLowerCase()
    if (!lowerName || seenNames.has(lowerName)) continue

    // Legality check needs color_identity + legalities; prefer the richer
    // Scryfall metadata, fall back to the owned row.
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

    const granularCat = getCardCategoryFromCard(card, sfCard)
    const role = granularToCoarse(granularCat)
    buckets.get(role).push({
      card,
      sfCard,
      name,
      granularCat,
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
    const min = spec === 'remainder' ? synergyTarget : (spec?.min ?? 0)
    const candidates = buckets.get(role)
    const current = candidates.filter(c => c.inDeck).length
    return {
      role,
      target,
      min,
      current,
      gap: Math.max(0, target - current),
      underMin: current < min,
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
export async function enrichPlanWithEdhrec(plan, fetchEdhrec) {
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

  const ownedNames = new Set()
  for (const role of plan.roles) {
    for (const c of role.ownedCandidates) ownedNames.add(c.name.toLowerCase())
  }

  // 1) Boost owned candidates by EDHREC inclusion, then re-rank each role.
  for (const role of plan.roles) {
    for (const cand of role.ownedCandidates) {
      const entry = byName.get(cand.name.toLowerCase())
      if (entry) cand.edhrecInclusion = entry.cv.inclusion ?? 0
    }
    role.ownedCandidates.sort((a, b) =>
      (b.edhrecInclusion - a.edhrecInclusion) ||
      (a.cmc - b.cmc) ||
      a.name.localeCompare(b.name),
    )
  }

  // 2) Bucket NOT-owned EDHREC cards into coarse roles. EDHREC cardviews lack
  //    oracle text, so we infer the role from the section header first
  //    (functional, e.g. "Mana Artifacts" → Ramp) and fall back to the type
  //    line for type-based sections. Best-effort — the user confirms each pick.
  const upgradesByRole = new Map(ROLE_ORDER.map(r => [r, []]))
  for (const [key, { cv, header }] of byName) {
    if (ownedNames.has(key)) continue
    const role = edhrecHeaderToRole(header) ||
      granularToCoarse(getCardCategoryFromCard({ type_line: cv.type }, { type_line: cv.type }))
    upgradesByRole.get(role).push({
      name: cv.name,
      slug: cv.slug,
      cmc: cv.cmc ?? 0,
      type: cv.type ?? '',
      colorIdentity: cv.colorIdentity || [],
      edhrecInclusion: cv.inclusion ?? 0,
      synergy: cv.synergy ?? 0,
      owned: false,
    })
  }
  for (const role of plan.roles) {
    const list = upgradesByRole.get(role.role) || []
    list.sort((a, b) => b.edhrecInclusion - a.edhrecInclusion)
    // Cap to keep the wizard tidy; under-built roles get more headroom.
    role.edhrecUpgrades = list.slice(0, Math.max(8, role.gap + 4))
  }

  return plan
}

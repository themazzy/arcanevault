// Command-zone variant rules: Companion deckbuilding restrictions and the
// Oathbreaker format (Oathbreaker planeswalker + Signature Spell).
//
// Pure + dependency-free so it can be unit-tested and reused. Callers pass
// "card" objects shaped like the merge of a deck row and its Scryfall data:
//   { name, type_line, mana_cost, cmc, oracle_text, color_identity }
// Backgrounds/Partners already live in deckBuilderHelpers; this module only
// covers Companion + Oathbreaker.

// ── card-shape helpers ──────────────────────────────────────────────────────
const lc = s => String(s || '').toLowerCase()

export function cardTypes(card) {
  // Types are the words before the em/en dash in the type line.
  const left = lc(card?.type_line).split(/[—-]/)[0]
  return new Set(left.split(/\s+/).filter(Boolean))
}

export function cardSubtypes(card) {
  const parts = lc(card?.type_line).split(/[—-]/)
  if (parts.length < 2) return new Set()
  return new Set(parts[1].split(/\s+/).filter(Boolean))
}

export const isLand      = card => cardTypes(card).has('land')
export const isCreature  = card => cardTypes(card).has('creature')
export const isPlaneswalker = card => cardTypes(card).has('planeswalker')
const PERMANENT_TYPES = ['artifact', 'creature', 'enchantment', 'planeswalker', 'land', 'battle']
export const isPermanent = card => { const t = cardTypes(card); return PERMANENT_TYPES.some(x => t.has(x)) }
export const isInstantOrSorcery = card => { const t = cardTypes(card); return t.has('instant') || t.has('sorcery') }

const mv = card => (typeof card?.cmc === 'number' ? card.cmc : Number(card?.cmc) || 0)

// Count colored/colorless pips per symbol in a mana cost ("{R}{R}{G}" → R:2,G:1).
export function manaSymbolCounts(manaCost) {
  const counts = {}
  for (const m of String(manaCost || '').matchAll(/\{([^}]+)\}/g)) {
    for (const sym of m[1].toUpperCase().split('/')) {
      if ('WUBRGC'.includes(sym)) counts[sym] = (counts[sym] || 0) + 1
    }
  }
  return counts
}

export function hasActivatedAbility(card) {
  // Approximate: an activated ability is written "[cost]: [effect]". Loyalty
  // abilities (planeswalkers) and mana abilities count. Exclude lines that are
  // really keyword/triggered text by requiring a ':' that isn't part of "—".
  return /(\{[^}]+\}|[+−-]?\d+|[a-z, ]+)\s*:\s/i.test(String(card?.oracle_text || ''))
}

// ── Companions ──────────────────────────────────────────────────────────────
// Each restriction validates the *starting deck* (main board, including the
// commander/oathbreaker, excluding the companion itself). Returns
// { ok, offenders: [names], note }.

const KAHEERA_TYPES = new Set(['cat', 'elemental', 'nightmare', 'dinosaur', 'beast'])

export const COMPANIONS = {
  'gyruda, doom of depths': {
    note: 'Every card in your deck has an even mana value.',
    validate: cards => offenders(cards, c => mv(c) % 2 === 0),
  },
  'jegantha, the wellspring': {
    note: 'No card in your deck has more than one of the same mana symbol in its cost.',
    validate: cards => offenders(cards, c => Object.values(manaSymbolCounts(c.mana_cost)).every(n => n <= 1)),
  },
  'kaheera, the orphanguard': {
    note: 'Each creature in your deck is a Cat, Elemental, Nightmare, Dinosaur, or Beast.',
    validate: cards => offenders(cards, c => !isCreature(c) || [...cardSubtypes(c)].some(t => KAHEERA_TYPES.has(t))),
  },
  'keruga, the macrosage': {
    note: 'Each non-land card in your deck has mana value 3 or greater.',
    validate: cards => offenders(cards, c => isLand(c) || mv(c) >= 3),
  },
  'lurrus of the dream-den': {
    note: 'Each permanent card in your deck has mana value 2 or less.',
    validate: cards => offenders(cards, c => !isPermanent(c) || mv(c) <= 2),
  },
  'lutri, the spellchaser': {
    note: 'Your deck is singleton (no duplicate cards except basic lands).',
    validate: cards => singletonOffenders(cards),
  },
  'obosh, the preypiercer': {
    note: 'Each non-land card in your deck has an odd mana value.',
    validate: cards => offenders(cards, c => isLand(c) || mv(c) % 2 === 1),
  },
  'umori, the collector': {
    note: 'Each non-land card in your deck shares a single card type.',
    validate: cards => umoriOffenders(cards),
  },
  'yorion, sky nomad': {
    note: 'Your deck has at least 20 cards above the minimum size.',
    validate: () => ({ ok: true, offenders: [] }),   // size-based; handled by caller via companionDeckSizeBonus
    sizeBonus: 20,
  },
  'zirda, the dawnwaker': {
    note: 'Each permanent card in your deck has an activated ability.',
    validate: cards => offenders(cards, c => !isPermanent(c) || hasActivatedAbility(c)),
  },
}

function offenders(cards, predicate) {
  const bad = []
  for (const c of cards || []) {
    if (!predicate(c)) bad.push(c.name)
  }
  return { ok: bad.length === 0, offenders: [...new Set(bad)] }
}

function singletonOffenders(cards) {
  const seen = new Map()
  for (const c of cards || []) {
    if (isLand(c) && cardSubtypes(c).has('basic') || /^(plains|island|swamp|mountain|forest|wastes)$/.test(lc(c.name))) continue
    seen.set(lc(c.name), (seen.get(lc(c.name)) || 0) + (c.qty || 1))
  }
  const bad = [...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name)
  return { ok: bad.length === 0, offenders: bad }
}

function umoriOffenders(cards) {
  const nonland = (cards || []).filter(c => !isLand(c))
  if (!nonland.length) return { ok: true, offenders: [] }
  let common = cardTypes(nonland[0])
  for (const c of nonland.slice(1)) {
    const t = cardTypes(c)
    common = new Set([...common].filter(x => t.has(x)))
  }
  if (common.size > 0) return { ok: true, offenders: [] }
  // No shared type — report the minority types as offenders (best effort).
  return { ok: false, offenders: nonland.map(c => c.name) }
}

export function isCompanionCard(card) {
  if (!card) return false
  if (COMPANIONS[lc(card.name)]) return true
  const kw = (card.keywords || []).map(lc)
  return kw.includes('companion') || /\bcompanion\s*[—-]/i.test(card.oracle_text || '')
}

export function getCompanionRule(card) {
  return COMPANIONS[lc(card?.name)] || null
}

export function companionDeckSizeBonus(card) {
  return getCompanionRule(card)?.sizeBonus || 0
}

/**
 * Validate a companion against the starting deck.
 * @param companion  the companion card
 * @param deckCards  the starting-deck cards (main board, commander included,
 *                   companion excluded)
 * @returns { ok, offenders, note }
 */
export function validateCompanion(companion, deckCards) {
  const rule = getCompanionRule(companion)
  if (!rule) return { ok: true, offenders: [], note: 'Unknown companion — restriction not checked.' }
  const list = (deckCards || []).filter(c => lc(c.name) !== lc(companion?.name))
  const res = rule.validate(list)
  return { ...res, note: rule.note }
}

// ── Oathbreaker ───────────────────────────────────────────────────────────────
export const OATHBREAKER_FORMAT = { id: 'oathbreaker', label: 'Oathbreaker', isEDH: true, deckSize: 60 }

export function isOathbreaker(card) { return isPlaneswalker(card) }
export function isSignatureSpell(card) { return isInstantOrSorcery(card) }

const ci = card => (Array.isArray(card?.color_identity) ? card.color_identity : [])

/**
 * Validate the Oathbreaker command zone: exactly one planeswalker (the
 * Oathbreaker) plus optionally one instant/sorcery (the Signature Spell) whose
 * color identity is within the Oathbreaker's. Returns an issue string or null.
 */
export function getOathbreakerPairIssue(cards) {
  const list = cards || []
  if (!list.length) return null
  const walkers = list.filter(isOathbreaker)
  const spells = list.filter(isSignatureSpell)
  const others = list.filter(c => !isOathbreaker(c) && !isSignatureSpell(c))

  if (others.length) return `${others[0].name} can't be in the command zone — use a planeswalker Oathbreaker and an instant/sorcery Signature Spell.`
  if (walkers.length > 1) return 'Oathbreaker allows only one planeswalker in the command zone.'
  if (spells.length > 1) return 'Oathbreaker allows only one Signature Spell.'
  if (spells.length && !walkers.length) return 'A Signature Spell needs an Oathbreaker (planeswalker).'

  if (walkers.length && spells.length) {
    const allowed = ci(walkers[0])
    const outside = ci(spells[0]).filter(c => !allowed.includes(c))
    if (outside.length) return `${spells[0].name} is outside the Oathbreaker's color identity (${outside.join('')}).`
  }
  return null
}

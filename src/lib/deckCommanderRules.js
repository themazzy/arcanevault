// Commander text that changes what you may put in the deck.
//
// Two unrelated families live here because they answer the same question —
// "is this card legal under this commander?" — and every caller needs both.
//
// 1. RULEBREAKER (Mystery Booster Commander Edition, MBC 2026-11) — an ability
//    word on eight legendary cards that EXEMPTS A SUBSET of cards from the
//    color-identity rule, or removes the deck-size maximum:
//
//      Rulebreaker — A deck with this commander can have <subject> of any color
//                    identity and any basic land cards.
//      Rulebreaker — A deck with this commander can have any land cards.
//      Rulebreaker — A deck with this commander has no maximum deck size.
//      Rulebreaker — If <name> is your commander, the color identity of instant
//                    and sorcery cards in your deck can include one color of
//                    your choice not in your commander's color identity, …
//
// 2. CHOSEN-COLOR COMMANDERS — a characteristic-defining ability that sets the
//    commander's own color, which WIDENS THE WHOLE DECK'S identity:
//
//      If <name> is your commander, choose a color before the game begins.
//      <name> is the chosen color.
//
//    The Prismatic Piper, Faceless One, and Clara Oswald. CR 903.4 folds
//    "colors defined by its characteristic-defining abilities" into color
//    identity, and CR 604.3 makes CDAs function outside the game — so the
//    chosen color is a deckbuilding color, exactly like Transguild Courier's
//    "is all colors" giving it a WUBRG identity off a {4} mana cost.
//
//    Scryfall reports these three as `color_identity: []` because it cannot
//    encode "whatever the player picks". That is a data-model limit, NOT a
//    rules statement — do not read it as "colorless" and skip the choice.
//
// Both are parsed from oracle text so a future printing needs no code change.
// COMMANDER_RULE_OVERRIDES is the escape hatch for wording the parser can't
// safely read.
//
// Pure + dependency-light so it can be unit-tested; callers pass card objects
// shaped like { name, type_line, cmc, color_identity, oracle_text, card_faces }.

import { cardTypes, cardSubtypes } from './commandZone'

// Words that appear to the LEFT of the type line's dash: card types plus
// supertypes. Anything else in a parsed subject is treated as a subtype.
const TYPE_WORDS = new Set([
  'artifact', 'battle', 'creature', 'enchantment', 'instant', 'kindred',
  'land', 'planeswalker', 'sorcery', 'tribal',
  'basic', 'legendary', 'ongoing', 'snow', 'world',
])

// Filler that carries no matching information once a subject is tokenized.
const SUBJECT_NOISE = new Set(['any', 'card', 'cards', 'a', 'an', 'the', 'other'])

const MANA_COLORS = ['W', 'U', 'B', 'R', 'G']

const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 }

const lc = s => String(s || '').toLowerCase()
const norm = name => lc(name).split('//')[0].trim()

// ── Subject parsing ─────────────────────────────────────────────────────────

// A subject term ("Angel cards", "artifact creature", "creature cards with mana
// value 7 or greater") compiles to a matcher: every listed type and subtype must
// be present, and the mana value must satisfy the optional bound.
function buildTermMatcher(term) {
  let rest = String(term || '').trim()
  if (!rest) return null

  let mv = null
  const mvMatch = rest.match(/\bwith mana value (\d+) or (greater|more|less|fewer)\b/i)
  if (mvMatch) {
    const n = Number(mvMatch[1])
    mv = /greater|more/i.test(mvMatch[2]) ? { min: n } : { max: n }
    rest = rest.replace(mvMatch[0], ' ')
  }

  const tokens = lc(rest)
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t && !SUBJECT_NOISE.has(t))

  const types = tokens.filter(t => TYPE_WORDS.has(t))
  const subtypes = tokens.filter(t => !TYPE_WORDS.has(t))
  if (!types.length && !subtypes.length && !mv) return null
  return { types, subtypes, mv }
}

// "artifact creature and Equipment cards" → two matchers.
function buildSubjectMatchers(phrase) {
  return String(phrase || '')
    .split(/\s+and\s+/i)
    .map(buildTermMatcher)
    .filter(Boolean)
}

// A double-faced card has only its front face's characteristics outside the
// game (CR 712.4a), which is exactly the context a deckbuilding rule applies in.
function frontFace(card) {
  const faces = Array.isArray(card?.card_faces) ? card.card_faces : []
  return faces.length ? { ...card, ...faces[0] } : (card || {})
}

// Splitting a type line allocates two Sets, so it's done once per card and
// shared across every matcher. This loop runs over the whole owned collection
// in analyzeBuildPlan — recomputing it per matcher measured 77x slower than the
// plain identity check on a 20k-card collection.
function cardShape(card) {
  const face = frontFace(card)
  return {
    types: cardTypes(face),
    subs: cardSubtypes(face),
    mv: typeof card?.cmc === 'number' ? card.cmc : Number(card?.cmc),
  }
}

function shapeMatches(shape, matcher) {
  if (!matcher || !shape) return false
  for (const t of matcher.types) if (!shape.types.has(t)) return false
  for (const t of matcher.subtypes) if (!shape.subs.has(t)) return false
  if (matcher.mv) {
    if (!Number.isFinite(shape.mv)) return false
    if (matcher.mv.min != null && shape.mv < matcher.mv.min) return false
    if (matcher.mv.max != null && shape.mv > matcher.mv.max) return false
  }
  return true
}

function matchesTerm(card, matcher) {
  return shapeMatches(cardShape(card), matcher)
}

// ── Oracle-text parsing ─────────────────────────────────────────────────────

const emptyRule = () => ({
  note: '', exempt: [], extend: null, identityColors: false,
  chooseColors: 0, noMaxDeckSize: false,
})

function rulebreakerClauses(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/rulebreaker\s*[—–-]\s*(.+)$/i)
    if (m) out.push(m[1].trim())
  }
  return out
}

// Parse one "Rulebreaker — …" clause into a rule, or null when the wording
// isn't one this module understands (the override table covers those).
export function parseRulebreakerClause(clause) {
  const text = String(clause || '').trim()
  if (!text) return null

  if (/\bno maximum deck size\b/i.test(text)) {
    return { ...emptyRule(), note: text, noMaxDeckSize: true }
  }

  const canHave = text.match(/can have\s+(.+?)\s*\.?\s*$/i)
  if (!canHave) return null
  const body = canHave[1]

  // "<subject> of any color identity[ and <extra subject>]" — the identity
  // exemption covers the head, and any trailing allowance is its own subject.
  const split = body.split(/\s+of any color identity\s*/i)
  const phrases = split.length > 1
    ? [split[0], split.slice(1).join(' ').replace(/^\s*and\s+/i, '')]
    : [body]

  const exempt = phrases.flatMap(buildSubjectMatchers)
  if (!exempt.length) return null
  return { ...emptyRule(), note: text, exempt }
}

// "If <name> is your commander, choose a color before the game begins.
//  <name> is the chosen color." — a CDA that sets the commander's color, so the
// chosen color joins the deck's color identity (CR 903.4 + 604.3).
//
// The pairing of "before the game begins" with "is the chosen color" is what
// makes this safe to match: in-game "choose a color" effects (Iona, Painter's
// Servant) have neither phrase, and Alloy Golem / Shimmerwilds Growth say "is
// the chosen color" about a permanent on the battlefield, not about a commander
// before the game.
export function parseChosenColorClause(text) {
  const t = String(text || '')
  if (!/\bis your commander\b/i.test(t)) return null
  if (!/\bbefore the game begins\b/i.test(t)) return null
  if (!/\bis the chosen colors?\b/i.test(t)) return null

  const m = t.match(/\bchoose (a|an|one|two|three|four|five) colors?\b/i)
  const count = m ? (NUMBER_WORDS[lc(m[1])] || 1) : 1
  const note = (t.split('\n').find(line => /before the game begins/i.test(line)) || t).trim()
  return { ...emptyRule(), note, identityColors: true, chooseColors: count }
}

// Cards whose wording doesn't fit the parseable templates. Keyed by lowercased
// card name; the value replaces whatever parsing produced.
export const COMMANDER_RULE_OVERRIDES = {
  // "the color identity of instant and sorcery cards in your deck can include
  // one color of your choice not in your commander's color identity, and your
  // deck can have any basic land cards."
  //
  // Unlike the chosen-color commanders above, this widens the identity only for
  // the cards it names, so it uses `extend` rather than `identityColors`.
  'tolabow, loch rascal': {
    ...emptyRule(),
    note: 'Instant and sorcery cards may include one color of your choice outside the commander\'s color identity, and the deck can have any basic land cards.',
    exempt: buildSubjectMatchers('any basic land cards'),
    extend: { matchers: buildSubjectMatchers('instant and sorcery cards') },
    chooseColors: 1,
  },
}

// All deckbuilding rules a single card grants. Reads the oracle text off either
// a Scryfall card or a deck row; double-faced text lives on `card_faces`.
export function getCardCommanderRules(card) {
  if (!card) return []
  const override = COMMANDER_RULE_OVERRIDES[norm(card.name)]
  if (override) return [{ ...override, source: card.name }]

  const text = [
    card.oracle_text || '',
    ...(Array.isArray(card.card_faces) ? card.card_faces.map(f => f?.oracle_text || '') : []),
  ].filter(Boolean).join('\n')

  const rules = rulebreakerClauses(text)
    .map(parseRulebreakerClause)
    .filter(Boolean)

  const chosen = parseChosenColorClause(text)
  if (chosen) rules.push(chosen)

  return rules.map(rule => ({ ...rule, source: card.name }))
}

// ── Context ─────────────────────────────────────────────────────────────────

/**
 * Collect the deckbuilding rules in force for a command zone.
 *
 * @param commanders    the commander card objects (merged deck row + Scryfall)
 * @param chosenColors  colors the player picked, keyed by lowercased commander
 *                      name: { 'the prismatic piper': ['R'] }
 * @returns { active, rules, noMaxDeckSize, identityColors, colorChoices, chosenColors }
 *          `identityColors` are the colors to union into the commander's own
 *          color identity; `colorChoices` describes every picker the UI shows.
 */
export function getCommanderRuleContext({ commanders = [], chosenColors = {} } = {}) {
  const rules = []
  for (const card of commanders || []) {
    for (const rule of getCardCommanderRules(card)) rules.push(rule)
  }
  if (!rules.length) {
    return {
      active: false, rules: [], noMaxDeckSize: false,
      identityColors: [], colorChoices: [], chosenColors: {},
    }
  }

  const pickedFor = rule =>
    sanitizeColors(chosenColors?.[norm(rule.source)]).slice(0, rule.chooseColors)

  const colorChoices = rules
    .filter(r => r.chooseColors > 0)
    .map(r => ({
      source: r.source,
      key: norm(r.source),
      count: r.chooseColors,
      note: r.note,
      // Distinguishes "this color joins the deck's identity" from "this color
      // only widens the cards the Rulebreaker names" in the picker's label.
      label: r.identityColors ? 'Commander color' : 'Rulebreaker color',
      selected: pickedFor(r),
    }))

  const identityColors = []
  for (const rule of rules) {
    if (!rule.identityColors) continue
    for (const c of pickedFor(rule)) if (!identityColors.includes(c)) identityColors.push(c)
  }

  return {
    active: true,
    rules,
    noMaxDeckSize: rules.some(r => r.noMaxDeckSize),
    identityColors,
    colorChoices,
    chosenColors: chosenColors || {},
  }
}

export function sanitizeColors(colors) {
  const seen = new Set()
  const out = []
  for (const c of Array.isArray(colors) ? colors : []) {
    const up = String(c || '').toUpperCase()
    if (MANA_COLORS.includes(up) && !seen.has(up)) { seen.add(up); out.push(up) }
  }
  return out
}

// ── The rule these all feed ─────────────────────────────────────────────────

/**
 * Colors of `card` that fall outside what the deck is allowed to run.
 *
 * @param card     the card being checked
 * @param allowed  the commander color identity
 * @param ctx      optional context from getCommanderRuleContext(); omitting it
 *                 gives the plain Commander rule
 * @returns array of offending color letters — empty means legal
 */
export function offColorIdentity(card, allowed = [], ctx = null) {
  const identity = Array.isArray(card?.color_identity) ? card.color_identity : []
  if (!identity.length) return []

  let permitted = Array.isArray(allowed) ? allowed : []
  if (ctx?.active) {
    // Chosen-color commanders widen the identity itself. Callers are expected to
    // have folded these in already, but doing it here too keeps the function
    // correct standalone — it's a set membership test, so adding twice is free.
    if (ctx.identityColors?.length) permitted = [...permitted, ...ctx.identityColors]
    // Built once per card, only when a rule actually has matchers to test — a
    // pure chosen-color command zone (Piper) never pays for it.
    let shape = null
    for (const rule of ctx.rules) {
      const matchers = rule.exempt?.length ? rule.exempt : null
      const extend = rule.extend?.matchers?.length ? rule.extend.matchers : null
      if (!matchers && !extend) continue
      if (!shape) shape = cardShape(card)
      if (matchers && matchers.some(m => shapeMatches(shape, m))) return []
      if (extend && extend.some(m => shapeMatches(shape, m))) {
        const picked = sanitizeColors(ctx.chosenColors?.[norm(rule.source)]).slice(0, rule.chooseColors)
        if (picked.length) permitted = [...permitted, ...picked]
      }
    }
  }
  return identity.filter(c => !permitted.includes(c))
}

/**
 * Which rule (if any) is letting a card sit outside the commander's identity.
 * Used for UI copy — returns null when the card needs no exemption.
 */
export function explainExemption(card, allowed = [], ctx = null) {
  if (!ctx?.active) return null
  const identity = Array.isArray(card?.color_identity) ? card.color_identity : []
  if (!identity.some(c => !(allowed || []).includes(c))) return null
  for (const rule of ctx.rules) {
    if (rule.exempt?.some(m => matchesTerm(card, m))) return rule
    if (rule.extend?.matchers?.some(m => matchesTerm(card, m))) {
      const picked = sanitizeColors(ctx.chosenColors?.[norm(rule.source)]).slice(0, rule.chooseColors)
      if (picked.length && identity.every(c => (allowed || []).includes(c) || picked.includes(c))) return rule
    }
  }
  return null
}

export { MANA_COLORS }

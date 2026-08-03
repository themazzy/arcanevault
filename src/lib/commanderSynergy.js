// Commander-keyword synergy scoring for the experimental Build Assistant.
//
// The method is lifted straight from the deckbuilding process in the source
// video: read the commander line by line, pull out the mechanical hooks it
// names ("enters", "attacks", "sacrifice", "+1/+1 counters"), then look for
// cards that touch SEVERAL of those hooks rather than just one. Overlapping
// synergies are what make a 99 hang together.
//
// Why this earns its place next to EDHREC inclusion %: inclusion is a
// popularity signal that requires the network AND requires the card to be on
// the commander's page at all. In the binder-only build path — where the pool is
// whatever the player happens to own, much of it off-meta — inclusion is 0 for
// most candidates and they all tie. Keyword overlap is computable offline from
// oracle text we already cache, and it ranks exactly the cards a human would
// pick out of their own binder.
//
// Deliberately NOT a card-quality signal. A card can overlap heavily and still
// be weak; overlap is a tiebreaker layered on top of recommendation strength,
// never a replacement for it.

import { CREATURE_TYPES } from './creatureTypes'

// ── Concept vocabulary ────────────────────────────────────────────────────────
// Each concept is a mechanical hook a commander can care about.
//
//   re       concept is present in the text (used on BOTH the commander and the
//            candidate — shared vocabulary is the whole idea)
//   enables  the card FEEDS the concept without naming it. This asymmetry is the
//            transcript's "cards that make things you don't care about
//            sacrificing": a token-maker is a sacrifice card even though its
//            text never says "sacrifice".
//   cardType candidate's TYPE LINE satisfies the concept. Needed for
//            spellslinger: Counterspell synergizes with Talrand by being an
//            instant, and its rules text says nothing about instants.
//   weight   narrow mechanical hooks count full; broad ones that appear on a
//            large share of all cards count half, so they can't wash out the
//            signal by matching everything.
export const SYNERGY_CONCEPTS = [
  {
    id: 'etb', label: 'enters the battlefield', weight: 1,
    re: /\b(when|whenever)\b[^.\n]{0,60}\benters\b/,
    // "entering" (gerund) is the templating ETB doublers use — Panharmonicon and
    // Yarok read "If an artifact or creature entering causes a triggered
    // ability … that ability triggers an additional time", never "when ~
    // enters". They are the archetypal enters-payoff enabler, so missing them
    // would be the worst possible false negative for this concept.
    enables: /\bentering\b|exile[^.\n]{0,60}return (it|them|that card)[^.\n]{0,40}to the battlefield|\bblink\b/,
  },
  {
    id: 'attack', label: 'attacking', weight: 1,
    re: /\b(when|whenever)\b[^.\n]{0,60}\battacks?\b/,
    enables: /(additional|extra) combat phase|\bgoad\b|attacks? each combat if able/,
  },
  {
    id: 'sacrifice', label: 'sacrifice', weight: 1,
    // `dying` / `sacrificing` (gerunds) are not stylistic variants — they are
    // the templating death-trigger DOUBLERS use: Teysa Karlov reads "If a
    // creature dying causes a triggered ability … that ability triggers an
    // additional time", and never says "dies". Missing them scored the single
    // best card in a sacrifice deck at zero hooks. Same trap as `entering` on
    // the etb concept above; check the gerund whenever a concept has doublers.
    re: /\bsacrific(es?|ing)\b|\bdies\b|\bdied\b|\bdying\b/,
    // Fodder: anything that manufactures bodies/permanents you don't mind losing.
    enables: /create [^.\n]{0,60}tokens?/,
  },
  {
    id: 'counters', label: '+1/+1 counters', weight: 1,
    re: /\+1\/\+1 counters?|\bproliferate\b/,
    enables: /twice that many of those counters/,
  },
  {
    id: 'leaves', label: 'leaving the battlefield', weight: 1,
    re: /leaves the battlefield/,
    enables: /exile[^.\n]{0,60}return (it|them|that card)[^.\n]{0,40}to the battlefield|\bsacrifices?\b/,
  },
  {
    id: 'tokens', label: 'tokens', weight: 1,
    re: /create [^.\n]{0,60}tokens?|\bpopulate\b/,
    enables: /twice that many of those tokens/,
  },
  {
    id: 'spellcast', label: 'instants & sorceries', weight: 1,
    re: /\bcast (an|your first) (instant or sorcery|noncreature)|instant (or|and) sorcery spells?|\bmagecraft\b|\bprowess\b/,
    // No cardType: every instant and sorcery in the format would match, which
    // says nothing about whether it's a good Talrand card. EDHREC synergy is the
    // signal that actually distinguishes Opt from a random removal spell here.
  },
  {
    id: 'landfall', label: 'lands entering', weight: 1,
    re: /\blandfall\b|\bland\b[^.\n]{0,40}\benters\b|play an additional land/,
    enables: /search your library for [a-z ,]{0,40}lands?|put [^.\n]{0,40}land cards? onto the battlefield/,
  },
  {
    id: 'equipment', label: 'equipment & auras', weight: 1,
    re: /\bequipped?\b|\bequip\b|enchant creature|\bauras?\b/,
  },
  {
    id: 'lifeloss', label: 'opponents losing life', weight: 1,
    re: /(each opponent|target (opponent|player)|opponents?) loses? [a-z\d ]{0,30}life/,
  },
  {
    id: 'counterspell', label: 'countering spells', weight: 1,
    re: /counter target [a-z', ]{0,60}(spell|ability)/,
  },
  // ── Broader hooks (half weight) ────────────────────────────────────────────
  { id: 'graveyard', label: 'graveyard', weight: 0.5, re: /\bgraveyard\b/, enables: /\bmills?\b/ },
  { id: 'lifegain', label: 'lifegain', weight: 0.5, re: /you gain [a-z\d ]{0,20}life|whenever you gain life|\blifelink\b/ },
  { id: 'draw', label: 'drawing cards', weight: 0.5, re: /draws? [a-z\d ]{0,20}cards?/ },
  { id: 'discard', label: 'discard', weight: 0.5, re: /discards?\b/ },
  // These three used to carry `cardType: /artifact/` etc., which made them fire
  // on EVERY artifact / enchantment / instant in the pool — a type filter, not
  // a synergy signal. On an artifact commander that tagged roughly a third of
  // the candidates indiscriminately. Matching rules text only means a card has
  // to actually TALK about the type to count.
  { id: 'artifacts', label: 'artifacts', weight: 0.5, re: /\bartifacts?\b/ },
  { id: 'enchantments', label: 'enchantments', weight: 0.5, re: /\benchantments?\b/ },
  { id: 'evasion', label: 'evasion', weight: 0.5, re: /\bflying\b|can'?t be blocked|\bmenace\b|\btrample\b/ },
  { id: 'combatdamage', label: 'combat damage', weight: 0.5, re: /combat damage/ },
  { id: 'treasure', label: 'treasure', weight: 0.5, re: /\btreasure\b/ },
]

const CONCEPT_BY_ID = new Map(SYNERGY_CONCEPTS.map(c => [c.id, c]))

function norm(text = '') {
  // Reminder text is stripped for the same reason as in cardRoles: Scryfall
  // inlines it, and it names mechanics the card doesn't actually care about.
  return String(text).replace(/\([^)]*\)/g, ' ').toLowerCase()
}

// Creature types that are never a tribal theme — they appear on the type line of
// most legendary commanders and would make every deck read as "Human tribal".
const NON_TRIBAL_TYPES = new Set(['human', 'creature', 'legendary', 'god', 'noble', 'artificer', 'advisor', 'shaman', 'wizard', 'warrior', 'scout', 'cleric', 'rogue', 'druid', 'knight', 'soldier', 'monk', 'ranger', 'pirate', 'assassin', 'berserker', 'peasant', 'citizen'])

/**
 * The tribal theme a commander cares about, or null.
 *
 * Tribal was the single biggest hole in this vocabulary: it had no creature-type
 * concept at all, so Edgar Markov read as tokens/attack/counters with nothing
 * about VAMPIRES, and a pure tribal payoff scored zero on a tribal deck.
 *
 * The type has to come from the commander's rules text ("other Vampires you
 * control"), not just its own type line — a Human Vampire commander that never
 * mentions Vampires isn't a tribal commander, and plenty of tribal lords are
 * themselves a different type than the tribe they buff.
 */
export function extractTribe(oracleText = '', typeLine = '') {
  const o = norm(oracleText)
  const counts = new Map()
  // "other Vampires you control", "Vampire creature card", "Vampires you control get"
  const re = /\b(?:other |each |another )?([a-z][a-z-]{2,15})s?\b(?= (?:you control|creature|spell|card))/g
  let m
  while ((m = re.exec(o))) {
    const t = m[1].replace(/s$/, '')
    // Must be an ACTUAL creature type. Position in the sentence is not enough:
    // "sacrifice a land card" / "whenever you cast a spell" / "equipped creature"
    // all put a non-type word exactly where a tribe would sit, and the harness
    // duly demanded 25 "lands", 25 "casts" and 25 "equippeds" from real decks.
    if (!CREATURE_TYPES.has(t) || NON_TRIBAL_TYPES.has(t)) continue
    counts.set(t, (counts.get(t) || 0) + 1)
  }
  if (!counts.size) return null
  // The type the commander's own type line ALSO carries wins ties — a Vampire
  // that says "Vampires" is unambiguous.
  const t = norm(typeLine)
  let best = null, bestN = 0
  for (const [type, n] of counts) {
    const score = n + (t.includes(type) ? 2 : 0)
    if (score > bestN) { best = type; bestN = score }
  }
  return bestN >= 2 ? best : null
}

/**
 * The mechanical hooks a commander names. This is the "read your commander line
 * by line and pull out the keywords" step.
 *
 * @returns {Set<string>} concept ids
 */
export function extractCommanderKeywords(oracleText = '', typeLine = '') {
  const o = norm(oracleText)
  const t = norm(typeLine)
  const out = new Set()
  if (!o && !t) return out
  for (const c of SYNERGY_CONCEPTS) {
    // Only the concept's own `re` counts on the commander side. `enables` is a
    // one-way relation (a card feeds a commander's hook, not the reverse), and
    // `cardType` describes candidates — a legendary creature commander would
    // otherwise pick up 'artifacts' just for being an artifact creature.
    if (c.re.test(o)) out.add(c.id)
  }
  return out
}

/**
 * How many of the commander's hooks a candidate card touches.
 *
 * @param {string} oracleText     candidate's whole-card oracle text
 * @param {string} typeLine       candidate's whole-card type line
 * @param {Set<string>} keywords  from extractCommanderKeywords
 * @returns {{ score: number, matched: string[], labels: string[] }}
 *   score  — summed concept weights (broad hooks count half)
 *   labels — human-readable, for the "why is this here" line on a card tile
 */
export function synergyScore(oracleText = '', typeLine = '', keywords = new Set(), tribe = null) {
  const empty = { score: 0, matched: [], labels: [] }
  if (!keywords?.size && !tribe) return empty
  const o = norm(oracleText)
  const t = norm(typeLine)
  if (!o && !t) return empty

  const matched = []
  let score = 0

  // Tribal: a candidate counts if it IS the tribe (type line) or CARES about it
  // (rules text). Weighted like a narrow hook — on a tribal deck, being the
  // creature type is the single most load-bearing synergy there is.
  if (tribe) {
    const re = new RegExp(`\\b${tribe}s?\\b`)
    if (re.test(t) || re.test(o)) {
      matched.push('tribe')
      score += 1
    }
  }

  for (const id of keywords) {
    const c = CONCEPT_BY_ID.get(id)
    if (!c) continue
    const hit =
      c.re.test(o) ||
      (c.enables && c.enables.test(o)) ||
      (c.cardType && c.cardType.test(t))
    if (!hit) continue
    matched.push(id)
    score += c.weight
  }
  return {
    score,
    matched,
    labels: matched.map(id => (id === 'tribe' ? `${tribe}s` : CONCEPT_BY_ID.get(id).label)),
  }
}

/**
 * Concept histogram across cards already in the deck. Backs the transcript's
 * second-order point — cards in the 99 should synergize with EACH OTHER, not
 * only with the commander — by letting a candidate score for reinforcing what
 * the list is already doing.
 *
 * @param {Array} cards  [{ oracle, type }]
 * @returns {Map<string, number>} concept id → how many deck cards touch it
 */
export function deckKeywordProfile(cards = []) {
  const counts = new Map()
  for (const c of cards) {
    const o = norm(c?.oracle)
    const t = norm(c?.type)
    if (!o && !t) continue
    for (const concept of SYNERGY_CONCEPTS) {
      if (concept.re.test(o) || (concept.cardType && concept.cardType.test(t))) {
        counts.set(concept.id, (counts.get(concept.id) || 0) + 1)
      }
    }
  }
  return counts
}

/**
 * Bonus for reinforcing themes the deck already runs, as a 0..1 fraction of the
 * caller's weight. Only concepts the COMMANDER cares about count — otherwise a
 * deck full of incidental "graveyard" mentions would start pulling in unrelated
 * graveyard cards. Saturates at `saturation` copies so an already-deep theme
 * stops attracting more.
 */
export function deckAffinity(matched = [], profile = new Map(), saturation = 8) {
  if (!matched.length || !profile.size) return 0
  let total = 0
  for (const id of matched) {
    total += Math.min(1, (profile.get(id) || 0) / saturation)
  }
  return total / matched.length
}

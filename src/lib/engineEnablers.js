// Engine enabler detection — "does this card do the job the commander needs?"
//
// Every ranking signal measured so far moves ~2-3 cards out of 99, because the
// baseline already picks the top-N by EDHREC inclusion from a commander-specific
// pool: you cannot out-popularity a popularity ranking. The signals that DID
// work (top-end cap, draw quality) all worked by imposing structure the crowd
// doesn't follow. This module is that idea taken to its conclusion.
//
// The problem it addresses: a deck of 99 individually-popular cards can still
// fail to function. A Korvold or Hei Bai deck needs SACRIFICE OUTLETS — if
// auto-fill lands two of them, every card is defensible and the engine still
// doesn't run. No popularity ranking will ever fix that, because the average
// deck has the same hole.
//
// So the commander's hooks are used here as a COVERAGE QUOTA rather than a
// ranking bonus — the same vocabulary that measured useless as a tiebreaker,
// applied where it actually says something reliable: "this commander says
// sacrifice" is a solid statement about what the deck needs, even though it is
// a useless statement about which card should rank higher.

// From oracleText, NOT cardRoles: cardRoles imports the role constants from
// deckBuildAssistant, which imports this module — reaching into cardRoles here
// closes that loop and breaks module init. See oracleText.js.
import { stripReminders } from './oracleText'

// ── Detectors ─────────────────────────────────────────────────────────────────
// Precision matters more than recall here: a false positive makes the deck look
// covered when it isn't, which is worse than having no quota at all. Every
// detector below is pinned by adversarial fixtures in the test file — pairs of
// cards whose text looks the same to a naive regex but which behave completely
// differently.

/**
 * A repeatable sacrifice outlet: something that lets you sacrifice OTHER
 * permanents, at will, more than once.
 *
 * The discriminator is subtle and load-bearing. All of these contain the string
 * "sacrifice a creature":
 *
 *   Ashnod's Altar     "Sacrifice a creature: Add {C}{C}"              ✓ outlet
 *   Woe Strider        "Sacrifice another creature: Scry 1"            ✓ outlet
 *   Yawgmoth           "Pay 1 life, Sacrifice another creature: ..."   ✓ outlet
 *   Sakura-Tribe Elder "Sacrifice this creature: Search your..."       ✗ sacrifices ITSELF, once
 *   Evolving Wilds     "{T}, Sacrifice this land: Search..."           ✗ same
 *   Village Rites      "As an additional cost..., sacrifice a creature" ✗ one-shot spell
 *   Deadly Dispute     "As an additional cost..., sacrifice an artifact" ✗ same
 *
 * Two rules separate them: the sacrificed thing must not be "this" (self-sac is
 * a one-shot), and the clause must be an activated-ability COST — i.e. followed
 * by a colon before any sentence break. An additional casting cost has no colon.
 */
const SAC_OUTLET = /sacrifice (a|an|another|two|three|x|\d+) [a-z ]{0,20}?(creature|artifact|permanent|token|enchantment)[^:.\n]{0,40}:/

/**
 * Blink / flicker: exile something YOU control and return it. Distinguished
 * from removal by the return clause — Swords to Plowshares exiles a creature
 * and never brings it back, and it targets an opponent's.
 */
const BLINK = /exile[^.\n]{0,80}(you control|your control)[^.\n]{0,60}return[^.\n]{0,60}to the battlefield/

/** Self-mill: fills YOUR graveyard. "Target player mills" is an attack, not fuel. */
const MILL_ANY = /\bmills?\b/
const MILL_OPPONENT = /(target (player|opponent)|each (player|opponent)|opponents?) mills?/

/** Graveyard recursion: pulls a card back out of a graveyard. */
const RECURSION = /return [^.\n]{0,70}from (your|a|target player's) graveyard to (your hand|the battlefield|your library)/

/** Extra land drops, the engine a landfall commander actually runs on. */
const EXTRA_LAND = /play (an|one|two|three|up to (one|two|three)) additional lands?/

/**
 * Untapper — the engine behind a "{T}:" commander (Krenko, Kinnan).
 * "untap all creatures" (Intruder Alarm) counts too; it was missed by requiring
 * a targeted untap.
 */
const UNTAPPER = /untap (target|another target|up to (one|two)|all|each) [a-z ]{0,25}(creature|permanent|artifact)/

/**
 * Sacrifice fodder: things you don't mind losing.
 *
 * A sacrifice deck needs BOTH halves — outlets and things to feed them. The
 * source video makes the point explicitly ("cards that make things we don't
 * care about sacrificing"), and a deck with six outlets and nothing to sacrifice
 * is as broken as the reverse. Artifact tokens count: the common templating is
 * "sacrifice another creature or artifact" (Hei Bai) or "another permanent"
 * (Korvold), so Treasures are fodder too.
 */
const FODDER = /create [^.\n]{0,60}(creature|artifact|treasure|clue|food|blood) tokens?/

/**
 * Haste GRANTED to others — what an attack-triggered commander needs to do
 * anything the turn it lands.
 *
 * Must be granted, not possessed: Gishath's own type line reads "Vigilance,
 * trample, haste", which makes it a haste creature, not a haste enabler. The
 * grant templating always has has/have/gains, or Thousand-Year Elixir's "as
 * though those creatures had haste".
 */
const HASTE_GRANT = /(creatures? you control|equipped creature|enchanted creature|target creature|they|it) (has|have|gains?) [a-z, ]{0,30}haste|as though (those|these) creatures had haste/

export const ENABLERS = {
  sacOutlet: {
    id: 'sacOutlet',
    label: 'sacrifice outlets',
    why: 'Your commander wants to sacrifice permanents — without repeatable outlets the engine only runs on your own turn, if at all.',
    test: (o) => SAC_OUTLET.test(o),
  },
  blink: {
    id: 'blink',
    label: 'blink effects',
    why: 'Your commander pays off enter-the-battlefield or leave-the-battlefield triggers, which need ways to re-trigger them.',
    test: (o) => BLINK.test(o),
  },
  selfMill: {
    id: 'selfMill',
    label: 'self-mill',
    why: 'Your commander uses the graveyard as a resource, so it needs filling.',
    test: (o) => MILL_ANY.test(o) && !MILL_OPPONENT.test(o),
  },
  recursion: {
    id: 'recursion',
    label: 'recursion',
    why: 'Your commander rewards cards leaving and returning — recursion turns each one into repeated value.',
    test: (o) => RECURSION.test(o),
  },
  extraLand: {
    id: 'extraLand',
    label: 'extra land drops',
    why: 'Your commander triggers on lands entering; one land per turn barely uses it.',
    test: (o) => EXTRA_LAND.test(o),
  },
  untapper: {
    id: 'untapper',
    label: 'untappers',
    why: 'Your commander has a tap ability worth using more than once per turn.',
    test: (o) => UNTAPPER.test(o),
  },
  fodder: {
    id: 'fodder',
    label: 'sacrifice fodder',
    why: "Your commander sacrifices permanents — it needs a supply of things you don't mind losing, or the outlets have nothing to eat.",
    test: (o) => FODDER.test(o),
  },
  haste: {
    id: 'haste',
    label: 'haste enablers',
    why: 'Your commander pays off attacking, so it wants to attack the turn it lands rather than surviving a rotation first.',
    test: (o) => HASTE_GRANT.test(o),
  },
}

/** Every enabler a card provides. Tribe membership is handled separately. */
export function cardEnablers(oracleText = '', typeLine = '') {
  const o = stripReminders(String(oracleText)).toLowerCase()
  const out = new Set()
  if (!o) return out
  // Lands are excluded from enabler counting: a fetchland "sacrifices" itself
  // and would otherwise pad the sacrifice-outlet count with the manabase.
  if (String(typeLine).toLowerCase().includes('land')) return out
  for (const e of Object.values(ENABLERS)) if (e.test(o)) out.add(e.id)
  return out
}

/** Is this card a member of the given tribe? */
export function isTribeMember(typeLine = '', tribe = null) {
  if (!tribe) return false
  return new RegExp(`\\b${tribe}s?\\b`).test(String(typeLine).toLowerCase())
}

// ── Need derivation ───────────────────────────────────────────────────────────
// Commander hook → the enabler that hook implies, with a target count.
//
// Targets are starting points from common Commander deckbuilding guidance
// (aristocrats lists run 6-10 outlets; blink lists 6-8; a tribal deck wants
// roughly a third of the deck on-type). They are tunable, and the harness is
// what should ultimately set them — treat these as hypotheses, not findings.
const HOOK_NEEDS = [
  { hook: 'sacrifice', enabler: 'sacOutlet', target: 6 },
  { hook: 'sacrifice', enabler: 'fodder', target: 8 },
  { hook: 'attack', enabler: 'haste', target: 4 },
  { hook: 'tapAbility', enabler: 'untapper', target: 3 },
  { hook: 'leaves', enabler: 'sacOutlet', target: 4 },
  { hook: 'etbOthers', enabler: 'blink', target: 5 },
  { hook: 'graveyard', enabler: 'selfMill', target: 4 },
  { hook: 'graveyard', enabler: 'recursion', target: 5 },
  { hook: 'landfall', enabler: 'extraLand', target: 4 },
]

/**
 * Does the commander care about OTHER permanents entering, as opposed to just
 * having its own enters trigger?
 *
 * This distinction decides whether the deck wants blink effects, and getting it
 * wrong is expensive: the bare `etb` hook fires on "Whenever Korvold enters or
 * attacks", which is a self-trigger and implies nothing about blink. The step-0
 * sweep demanded 5 blink effects each from Korvold, Hei Bai, Omnath and Breya —
 * and real decks for all four run ZERO, which is the correct answer.
 *
 * A genuine blink payoff (Brago, Roon, Panharmonicon) talks about *another*
 * creature, *a* creature you control, or entering in general.
 */
export function caresAboutOthersEntering(oracleText = '') {
  const o = stripReminders(String(oracleText)).toLowerCase()
  if (/\bentering\b/.test(o)) return true // Panharmonicon/Yarok-style doubler
  // `enters?` — a plural subject drops the s ("one or more creatures you control
  // enter"), and those are exactly the go-wide payoffs that most want blink.
  return /\b(when|whenever)\b[^.\n]{0,50}\b(another|a|one or more|other)\b[^.\n]{0,40}(creature|permanent|artifact)[^.\n]{0,30}\benters?\b/.test(o)
}

/**
 * Does this commander actually want repeatable sacrifice outlets?
 *
 * The `sacrifice` hook matches any "dies", which over-fires on two common
 * templates that are not death-matters engines:
 *   • equipment/aura self-protection — "Whenever equipped creature dies, return
 *     it to its owner's hand" (Halvar's back face)
 *   • a creature's own death trigger — "When this creature dies, draw a card"
 *
 * A real sacrifice commander either instructs you to sacrifice, or pays off
 * OTHER permanents dying.
 */
/** Does the commander's own engine run off a {T} ability? */
export function hasTapAbility(oracleText = '') {
  const o = stripReminders(String(oracleText)).toLowerCase()
  return /\{t\}[^:\n]{0,40}:/.test(o)
}

export function wantsSacrificeOutlets(oracleText = '') {
  const o = stripReminders(String(oracleText)).toLowerCase()
  if (!o) return false
  if (/\bsacrifice (a|an|another|two|three|x|\d+)\b/.test(o)) return true
  // "whenever another creature you control dies" / "whenever a creature dies"
  return /\b(when|whenever)\b[^.\n]{0,60}\b(another|a|one or more|other)\b[^.\n]{0,40}(creature|permanent|artifact|token)[^.\n]{0,40}\bdies\b/.test(o)
    && !/\b(equipped|enchanted) creature dies/.test(o)
}

// Retired. Across 51 commanders this quota never once identified a real
// shortfall: every genuine tribal deck ran far past it (Edgar 50, Slivers 56,
// Gishath 52, Krenko 45, Ur-Dragon 39) because a tribal EDHREC page is already
// almost entirely on-type. Its only effect was a false alarm on Omnath, which
// reads as "Elemental-matters" but MAKES its elementals as tokens and correctly
// runs 13. Zero true positives, one false positive — so it is not a quota.
// `extractTribe` / `isTribeMember` stay: they still feed the keyword fallback.
export const TRIBE_TARGET = 25

/**
 * What this commander's engine needs, derived from its hooks.
 * Several hooks can imply the same enabler — the highest target wins rather
 * than summing, since one outlet serves every hook that wants one.
 *
 * @returns {Array<{ enabler, label, why, target, hooks: string[] }>}
 */
/**
 * Derive per-commander enabler targets from EDHREC, instead of guessing.
 *
 * The expected number of an enabler in an average deck for this commander is the
 * inclusion-weighted sum over its page. Crowd data answers this specific
 * question well — a deck missing the outlets it needs doesn't function, so it
 * doesn't survive to be uploaded — unlike mana curve, where the crowd is
 * measurably wrong.
 *
 * Measured on 51 commanders, the constants below were wrong in both directions
 * and the variance is far too large for any constant: sacrifice outlets range
 * from 2.3 (Hei Bai) to 8.6 (Meren). That split is not noise, it's the
 * self-trigger distinction — Korvold and Hei Bai sacrifice via their own
 * ability and need few outlets, Meren and Marchesa pay off OTHER things dying
 * and need many. Deriving per commander captures that without a rule for it.
 *
 * @param {Array} cards  [{ inclusionPct (0..1), oracle, type }] — every cardview
 *                       on the page for which oracle text could be resolved
 * @param {number} deckSize
 * @returns {Object} enabler id → target count, or {} when there's too little data
 */
export function deriveEnablerTargets(cards = [], deckSize = 99) {
  const totals = {}
  let covered = 0
  for (const c of cards) {
    const incl = Math.min(1, Math.max(0, c?.inclusionPct ?? 0))
    if (!incl || !c?.oracle) continue
    // Numerator and denominator must range over the SAME cards: the app can
    // only resolve oracle text for the top slice of the page, and counting
    // unclassifiable cards toward coverage would bias every target downward.
    covered += incl
    for (const e of cardEnablers(c.oracle, c.type || '')) {
      totals[e] = (totals[e] || 0) + incl
    }
  }
  // An EDHREC page lists 240-320 cards whose inclusion sums to only ~46-64 of a
  // 99-card deck — the rest of every real deck is long-tail cards it never
  // shows. Scaling by coverage converts "expected among the cards we can see"
  // into "expected in the whole deck".
  if (covered < deckSize * 0.25) return {} // too thin to extrapolate from
  const scale = deckSize / covered
  const out = {}
  for (const [k, v] of Object.entries(totals)) out[k] = Math.round(v * scale * 10) / 10
  return out
}

export function commanderNeeds(hooks = new Set(), tribe = null, commanderOracle = '', measuredTargets = null) {
  const effective = new Set(hooks)
  // Synthetic hook: only a commander that pays off OTHERS entering wants blink.
  if (caresAboutOthersEntering(commanderOracle)) effective.add('etbOthers')
  // Synthetic hook: a commander whose engine is a {T} ability (Krenko, Kinnan)
  // gets far more out of untappers than one that just has a static buff.
  if (hasTapAbility(commanderOracle)) effective.add('tapAbility')
  // The bare `sacrifice` hook fires on any "dies", including equipment
  // self-protection — Halvar's back face reads "Whenever equipped creature dies,
  // return it to its owner's hand", and the sweep duly demanded 6 sacrifice
  // outlets from an equipment voltron deck that wants none.
  if (!wantsSacrificeOutlets(commanderOracle)) {
    effective.delete('sacrifice')
    effective.delete('leaves')
  }
  hooks = effective
  const byEnabler = new Map()
  for (const { hook, enabler, target } of HOOK_NEEDS) {
    if (!hooks?.has?.(hook)) continue
    // A measured target always wins over the constant. The constants are only a
    // fallback for when EDHREC is unavailable or its page is too thin to
    // extrapolate from; measured across 51 commanders they were wrong in both
    // directions and by up to 4x. Rounded up: a fractional expectation of 3.6
    // outlets means a real deck runs 3 or 4, and undershooting is what breaks
    // the engine.
    const measured = measuredTargets?.[enabler]
    const effective = measured != null ? Math.ceil(measured) : target
    const prev = byEnabler.get(enabler)
    if (prev) {
      prev.target = Math.max(prev.target, effective)
      prev.hooks.push(hook)
    } else {
      const def = ENABLERS[enabler]
      byEnabler.set(enabler, {
        enabler, label: def.label, why: def.why,
        target: effective, measured: measured ?? null, hooks: [hook],
      })
    }
  }
  // No tribe quota — see the note on TRIBE_TARGET. `tribe` is still accepted so
  // callers don't have to change, and so it can be reinstated if a future sweep
  // finds a tribal archetype that actually comes up short.
  return [...byEnabler.values()]
}

// ── Coverage ──────────────────────────────────────────────────────────────────

/**
 * How well a card list covers the commander's needs. Pure, so the summary
 * readout and the auto-fill pass can never disagree about what's covered.
 *
 * @param {Array} cards  [{ name, oracle, type }]
 * @param {Array} needs  from commanderNeeds
 * @returns {Array<{ ...need, have, short, providers: string[] }>}
 */
export function analyzeEngineCoverage(cards = [], needs = []) {
  return needs.map(need => {
    const providers = []
    for (const c of cards) {
      const type = c?.type || ''
      const hit = need.enabler === 'tribe'
        ? isTribeMember(type, need.tribe)
        : cardEnablers(c?.oracle || '', type).has(need.enabler)
      if (hit) providers.push(c.name)
    }
    return {
      ...need,
      have: providers.length,
      short: Math.max(0, need.target - providers.length),
      providers,
    }
  })
}

// Multi-role card tagging for the experimental Build Assistant.
//
// `getCardCategory` (cardCategory.js) is a first-match ladder: it answers "what
// IS this card" with exactly one label, which is right for deck grouping and
// DeckStats. This module answers a different question — "how many of the deck's
// jobs does this card do at once" — so every predicate here is INDEPENDENT and
// a card can come back tagged Ramp + Draw + Game Plan.
//
// That distinction is the whole point: a card doing two or three jobs off one
// slot (Solemn Simulacrum ramps and draws; Kastral cheats creatures in, grows
// the board, and draws) is worth more than a card doing one, and the shipped
// single-label classifier cannot express it.
//
// Deliberately coarse. These predicates sort cards into the same eight build
// roles the assistant already reasons about — they are NOT a second, competing
// taxonomy, and nothing here feeds deck grouping or stats.

import { stripReminders } from './oracleText'
import {
  ROLE_RAMP,
  ROLE_DRAW,
  ROLE_REMOVAL,
  ROLE_WIPE,
  ROLE_PROTECTION,
  ROLE_WINCON,
  ROLE_LANDS,
} from './buildRoles'

// Roles that count toward "multi-engine". Lands are excluded — every land is
// trivially a mana source, so counting Lands would rate the whole manabase as
// multi-role and drown out the signal.
export const ENGINE_ROLES = [
  ROLE_RAMP,
  ROLE_DRAW,
  ROLE_REMOVAL,
  ROLE_WIPE,
  ROLE_PROTECTION,
  ROLE_WINCON,
]

// ── Text normalization ────────────────────────────────────────────────────────

// Re-exported for the callers that already import it from here. The
// implementation moved to oracleText.js to break an import cycle — see the note
// in that file.
export { stripReminders }

// Whole-card text: front face plus every card_faces entry, reminder-stripped
// and lowercased. A back-face Armageddon or an MDFC's land half is part of what
// the card does, so it must be in scope.
export function roleText(sfCard, card) {
  const parts = []
  const top = sfCard?.oracle_text ?? card?.oracle_text
  if (top) parts.push(top)
  for (const f of sfCard?.card_faces || []) if (f?.oracle_text) parts.push(f.oracle_text)
  return stripReminders(parts.join('\n')).toLowerCase()
}

export function roleTypeLine(sfCard, card) {
  const parts = []
  const top = sfCard?.type_line ?? card?.type_line
  if (top) parts.push(top)
  for (const f of sfCard?.card_faces || []) if (f?.type_line) parts.push(f.type_line)
  return parts.join(' // ').toLowerCase()
}

// ── Number words ──────────────────────────────────────────────────────────────

const NUM_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
}

// An "X cards" draw is unbounded — treated as 3 so it clears the burst floor.
const X_DRAW = 3

function toCount(word) {
  if (word == null) return 0
  const w = String(word).trim().toLowerCase()
  if (w === 'x') return X_DRAW
  if (/^\d+$/.test(w)) return Number(w)
  return NUM_WORDS[w] ?? 0
}

// ── Repeatability ─────────────────────────────────────────────────────────────

// Does the effect recur, rather than happening once on resolution? Triggered
// abilities ("whenever", "at the beginning of") and activated abilities
// (a cost followed by ":") both keep paying out. This is what makes Phyrexian
// Arena's single card per turn genuine advantage while Ponder's is not.
export function isRepeatable(o = '') {
  if (/\bwhenever\b|\bat the beginning of\b|\bat end of turn\b/.test(o)) return true
  // Activated ability: something before a colon that looks like a cost.
  if (/(\{[^}]+\}|sacrifice|discard|pay|tap an untapped)[^:\n]{0,60}:/.test(o)) return true
  return false
}

// ── Draw quality ──────────────────────────────────────────────────────────────
// The transcript's rule, which the shipped 'Card Draw' category does not model:
// a card is card ADVANTAGE only if it nets you cards. It must replace itself and
// then draw more — so a one-shot needs an effective draw of 2+. Cantrips
// (Ponder), loot/rummage (Faithless Looting) and Brainstorm-style shuffling are
// card SELECTION: useful, but they don't fill the Draw quota.

// Largest single "draw N cards" in the text. Handles "draw a/two/X cards",
// "you draw two cards", "target player draws X cards", "draws that many cards".
export function drawAmount(o = '') {
  let max = 0
  const re = /draws? (a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|\d+)(?: more)? cards?/g
  let m
  while ((m = re.exec(o))) max = Math.max(max, toCount(m[1]))
  if (/draws? cards? equal to|draws? that many cards?/.test(o)) max = Math.max(max, X_DRAW)
  return max
}

// Cards handed back on the same one-shot: "then discard two cards", "put two
// cards from your hand on top of your library". These cancel out the draw.
export function drawGiveback(o = '') {
  let max = 0
  const discard = /then discards? (a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|\d+)(?: more)? cards?/g
  let m
  while ((m = discard.exec(o))) max = Math.max(max, toCount(m[1]))
  if (/then discards? (your hand|that many cards?)/.test(o)) max = Math.max(max, X_DRAW)
  // Brainstorm-style: "put two cards from your hand on top of your library"
  const putBack = /put (a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|\d+) cards? from your hand on top of your library/g
  while ((m = putBack.exec(o))) max = Math.max(max, toCount(m[1]))
  return max
}

/**
 * Classify a card's card-flow.
 * @returns {{ kind: 'none'|'selection'|'advantage', net: number, burst: boolean }}
 *   kind 'advantage' → counts toward the Draw quota
 *   kind 'selection' → filters but doesn't net cards (loot, rummage, cantrip)
 *   burst            → draws 3+ at once, which is what justifies a 4+ MV draw slot
 */
export function drawQuality(o = '') {
  const drew = drawAmount(o)
  const looksLikeSelection = /\bscry\b|\bsurveil\b|look at the top/.test(o)
  if (!drew) return { kind: looksLikeSelection ? 'selection' : 'none', net: 0, burst: false }

  const net = drew - drawGiveback(o)
  const burst = drew >= 3

  // A repeatable draw pays out every turn / every trigger, so even one card at a
  // time is advantage — provided it isn't a repeatable looter (net <= 0).
  if (isRepeatable(o)) {
    return { kind: net > 0 ? 'advantage' : 'selection', net, burst }
  }
  // One-shot: must replace itself AND add. Net 1 is a cantrip, net 0 is a loot.
  return { kind: net >= 2 ? 'advantage' : 'selection', net, burst }
}

// ── Ramp ──────────────────────────────────────────────────────────────────────

// Produces or accelerates mana. Broader than cardCategory's Ramp because it must
// fire independently (a card that ramps AND draws should match both).
function tagsRamp(o, t) {
  if (/search your library for [a-z ,]{0,40}(basic |snow |basic snow )?(lands?|forests?|plains|islands?|swamps?|mountains?|wastes?)/.test(o)) return true
  if (/put (a|an|all|up to (one|two|three|four)|\d+) [a-z ]{0,40}(land|forest|island|plains|swamp|mountain|wastes?) cards? [a-z ]{0,30}onto the battlefield/.test(o)) return true
  if (/play (an additional|two additional|up to two additional|up to three additional) lands?/.test(o)) return true
  if (/create [a-z\d ]{0,40}(treasure|powerstone|gold) tokens?/.test(o)) return true
  if (/untap target [a-z ]{0,15}(land|forest|island|swamp|mountain|plains|wastes?)/.test(o)) return true
  if (/costs? (\{[\dx]+\}|one|two|three|four|five|six|seven|x|\d+) less to cast/.test(o)) return true
  // Direct mana production. Lands are excluded — they're ROLE_LANDS, and every
  // land trivially makes mana.
  if (!t.includes('land')) {
    if (/adds? [a-z ]{0,30}\{[wubrgc\d]/.test(o)) return true
    if (/adds? [a-z ]{0,30}(one|two|three|x|\d+) mana/.test(o)) return true
  }
  return false
}

// "Explosive ramp" from both transcripts: not +1 mana per turn, but doubling /
// tripling output, a burst ritual, or casting things for free. The concept both
// videos independently name as the thing they scale hardest with bracket.
export function isExplosiveRamp(o = '', t = '') {
  if (/produces? (twice|three times|double|triple) as much/.test(o)) return true
  if (/adds? (twice|three times|double|triple)/.test(o)) return true
  // "Add {B} for each Swamp you control" / "Add {R} for each card in ... hand"
  if (/adds? [^.\n]{0,30}for each/.test(o)) return true
  if (/whenever a player taps a (land|permanent) for mana/.test(o)) return true
  if (/without paying (its|their) mana cost/.test(o)) return true
  if (/takes? (an?|another|this|one|two|three|four|five|\d+) extra turns?/.test(o)) return true
  // Rituals: an instant/sorcery that just adds mana (no {T} to tap, so it's a
  // one-shot burst rather than a rock).
  if ((t.includes('instant') || t.includes('sorcery')) && /adds? [a-z ]{0,30}\{[wubrgc\d]/.test(o) && !/\{t\}/.test(o)) return true
  // Mass land untap (Turnabout / Early Harvest style).
  if (/untap all lands|untap up to [a-z]+ lands/.test(o)) return true
  return false
}

// ── Interaction ───────────────────────────────────────────────────────────────

function tagsRemoval(o) {
  if (/(exile|destroy) (x |\d+ )?target [a-z ]{0,40}(creatures?|permanents?|artifacts?|enchantments?|planeswalkers?|battles?|lands?)/.test(o)) return true
  if (/counter target [a-z', ]{0,60}(spell|ability)/.test(o)) return true
  if (/counter (that|the next) (spell|ability)/.test(o)) return true
  if (/return target [a-z' ]{0,40}(creature|permanent|artifact|enchantment|planeswalker|nonland) [a-z',' ]{0,60}to (its|their) owner[s'’]+ hand/.test(o)) return true
  if (/deals? [a-z\d' ]{0,30}damage [a-z\d' ]{0,40}to (any target|target creature|target creature or planeswalker)/.test(o)) return true
  if (/target creature gets -[x\d]+\/-[x\d]+/.test(o)) return true
  if (/owner of target [a-z ]{0,40}(permanent|creature|artifact|enchantment|planeswalker|nonland) shuffles? it into/.test(o)) return true
  if (/target (player|opponent) sacrifices? a/.test(o)) return true
  return false
}

function tagsWipe(o) {
  if (/(destroy|exile) all [a-z ]{0,40}(creatures|permanents|nonland)/.test(o)) return true
  if (/(destroy|exile) each [a-z ]{0,40}(creature|permanent|nonland)/.test(o)) return true
  if (/all creatures get -[x\d]+\/-[x\d]+/.test(o)) return true
  if (/each creature gets -[x\d]+\/-[x\d]+/.test(o)) return true
  if (/deals? \d+ damage to each (creature|other creature)/.test(o)) return true
  if (/return all [a-z' -]{0,40}(creatures|permanents|nonland)[^.]{0,40}to (their|its) owner[s'’]+ hands?/.test(o)) return true
  if (/each player sacrifices (all|half)/.test(o)) return true
  if (/then sacrifices the rest/.test(o)) return true
  return false
}

function tagsProtection(o) {
  if (/(gain|gains|have|has) [a-z, ]{0,40}(hexproof|indestructible|shroud|protection|ward)/.test(o)) return true
  if (/protection from/.test(o)) return true
  if (/(choose new targets for|change the targets? of) target [a-z ]{0,30}(spell|ability)/.test(o)) return true
  if (/prevent all (combat )?damage/.test(o)) return true
  if (/sacrifice [a-z ]{0,20}: (regenerate|return)/.test(o)) return true
  return false
}

// ── Win conditions ────────────────────────────────────────────────────────────

function tagsWincon(o) {
  if (/\bwins? the game\b|you win the game/.test(o)) return true
  if (/(each opponent|target (opponent|player)|opponents?) loses? [a-z\d ]{0,30}life/.test(o)) return true
  if (/deals? (five times )?x damage to (any target|target player|target opponent|each opponent|each player)/.test(o)) return true
  if (/deals? x damage divided [a-z,'\d ]{0,40}among/.test(o)) return true
  if (/creatures you control get \+[\dx]+\/\+[\dx]+ and gain [a-z, ]{0,40}trample/.test(o)) return true
  if (/creatures you control gain trample[a-z, ]{0,40}get \+[\dx]+\/\+[\dx]+/.test(o)) return true
  if (/(additional|extra) combat phase/.test(o)) return true
  if (/creatures you control (have|gain) double strike/.test(o)) return true
  if (/takes? (an?|another|this|one|two|three|four|five|\d+) extra turns?/.test(o)) return true
  if (/mills? half (of )?(their|his or her|its) library/.test(o)) return true
  if (/each opponent mills/.test(o)) return true
  return false
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Every build role a card fills, plus descriptive sub-tags.
 *
 * Returns TWO role sets, because "which quota does this fill" and "how many
 * jobs does this do" are different questions and conflating them is wrong in
 * both directions:
 *
 *   roles — strict quota membership. Solemn Simulacrum is NOT Draw: you spend a
 *           card and draw a card, so it nets zero and must not be counted
 *           against the card-advantage quota (that is the whole point of the
 *           net-positive rule).
 *   jobs  — everything the card actually does, including riders. Solemn IS a
 *           two-job card — it ramps and it replaces itself — which is exactly
 *           the multi-engine quality the ranking wants to reward.
 *
 * @param {string} oracle    whole-card oracle text (already face-joined)
 * @param {string} typeLine  whole-card type line
 * @returns {{ roles: Set<string>, jobs: Set<string>, tags: Set<string>, draw: object }}
 *   tags ⊆ { 'net-draw', 'selection', 'burst-draw', 'explosive-ramp', 'repeatable' }
 */
export function cardRoleTags(oracle = '', typeLine = '') {
  const o = String(oracle).toLowerCase()
  const t = String(typeLine).toLowerCase()
  const roles = new Set()
  const tags = new Set()

  // Lands are their own role and never counted as multi-engine (see ENGINE_ROLES).
  if (t.includes('land')) roles.add(ROLE_LANDS)

  if (tagsRamp(o, t)) roles.add(ROLE_RAMP)
  if (isExplosiveRamp(o, t)) {
    // A land that makes explosive mana (Cabal Coffers, Nykthos) still belongs to
    // the manabase, not the ramp quota — adding ROLE_RAMP here would let one
    // card fill two quotas and inflate its multi-engine count. The tag stays so
    // the manabase step can still surface it.
    if (!t.includes('land')) roles.add(ROLE_RAMP)
    tags.add('explosive-ramp')
  }

  const draw = drawQuality(o)
  if (draw.kind === 'advantage') {
    roles.add(ROLE_DRAW)
    tags.add('net-draw')
  } else if (draw.kind === 'selection') {
    tags.add('selection')
  }
  if (draw.burst) tags.add('burst-draw')

  // Tutors are card advantage in the coarse taxonomy (COARSE_ROLE_MAP maps
  // Tutor → Draw), so they fill the Draw role even without drawing.
  //
  // The negative lookahead keeps LAND searches out. A land fetch is ramp and
  // only ramp — without this, Cultivate matches both the ramp predicate and the
  // tutor predicate and reads as a two-job card, which would hand every
  // land-fetch spell in the format a multi-engine bonus it hasn't earned. The
  // shipped ladder avoids this by ordering (land fetch is checked before Tutor);
  // independent predicates have no ordering to lean on, so it must be explicit.
  if (/search your library (and\/or graveyard )?for (a|an|up to (one|two|three|four)) (?![a-z, ]{0,30}\b(lands?|forests?|islands?|plains|swamps?|mountains?|wastes?)\b)[a-z, ]{0,40}(card|instant|sorcery|creature|artifact|enchantment|planeswalker|legendary)/.test(o)) {
    roles.add(ROLE_DRAW)
  }

  if (tagsWipe(o)) roles.add(ROLE_WIPE)
  else if (tagsRemoval(o)) roles.add(ROLE_REMOVAL) // a wipe is not also spot removal
  if (tagsProtection(o)) roles.add(ROLE_PROTECTION)
  if (tagsWincon(o)) roles.add(ROLE_WINCON)

  if (isRepeatable(o)) tags.add('repeatable')

  // Jobs = quota roles plus the work that doesn't clear a quota bar. Any draw
  // at all counts as a job: a card that ramps and cantrips off a death trigger
  // is doing two things even though neither the ramp nor the draw is
  // "dedicated" card advantage.
  const jobs = new Set(roles)
  if (draw.kind !== 'none') jobs.add(ROLE_DRAW)

  return { roles, jobs, tags, draw }
}

/** Adapter for the (card, sfCard) shape every assistant call site already has. */
export function cardRoleTagsFromCard(card, sfCard) {
  return cardRoleTags(roleText(sfCard, card), roleTypeLine(sfCard, card))
}

/**
 * How many of the deck's jobs this card does at once — the "multi-engine piece"
 * count. Lands excluded (see ENGINE_ROLES). 0 for pure synergy/theme cards.
 */
export function engineRoleCount(roles) {
  let n = 0
  for (const r of ENGINE_ROLES) if (roles?.has?.(r)) n++
  return n
}

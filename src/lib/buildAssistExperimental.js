// Experimental scoring layer for the Build Assistant "lab" mode.
//
// Nothing here runs unless the assistant is opened with `experimental` set —
// the shipped Build Assistant and auto-fill paths never import this module's
// behavior, they only gain an optional injection point. Every function is pure
// so the signals can be A/B'd from tests without a component.
//
// The five signals implemented here come from two Commander deckbuilding
// videos and are, in the order they matter:
//   1. multi-role   — a card doing two jobs off one slot beats a card doing one
//   2. keywords     — overlap with the commander's own mechanical hooks
//   3. top-end cap  — a hard ceiling on 6+ MV cards, not just a target average
//   5. draw quality — loot/cantrips are card selection, not card advantage
//   6. combo type   — prefer resource loops over "you win" loops below bracket 4
// (4 — explosive ramp as a separate quota — is scaffolded via the
// 'explosive-ramp' tag in cardRoles but is not one of the five wired here.)

import { recRank, curveFitKey } from './deckBuildAssistant'
import { ROLE_LANDS } from './buildRoles'
import {
  cardRoleTagsFromCard,
  cardRoleTags,
  engineRoleCount,
  drawQuality,
  roleText,
  roleTypeLine,
} from './cardRoles'
import { extractCommanderKeywords, extractTribe, synergyScore, deckKeywordProfile, deckAffinity } from './commanderSynergy'

// ── Config ────────────────────────────────────────────────────────────────────
// Surfaced verbatim in the assistant's debug panel. Weights are in the same
// units as recRank (0-100, roughly "EDHREC inclusion %"), so a weight of 8 means
// "worth as much as 8 percentage points of inclusion".
export const EXPERIMENTAL_DEFAULTS = {
  multiRole: true,
  multiRoleWeight: 8,      // per extra engine role, capped at MULTI_ROLE_CAP roles
  // EDHREC's empirical synergy score — the primary theme signal.
  //
  // Measured against the regex keyword vocabulary on 51 commanders across 20
  // archetypes, the vocabulary moved ~1.6 cards and was completely blind on 9
  // archetypes (tribal, spellslinger, enchantress, blink, mill, stax, big mana,
  // burn, vanilla). Synergy is derived from what people actually play, so it
  // covers all of them, and it uniquely PENALISES off-plan cards — a negative
  // score means the card is played less here than in generic decks of the same
  // colours, which no oracle-text rule can express.
  edhrecSynergy: true,
  synergyWeight: 30,       // rank points per 1.0 of synergy (observed range -0.26..0.75)
  synergyFloor: -0.30,     // clamp, so one outlier can't dominate
  synergyCeil: 0.80,
  // Keyword overlap is now a FALLBACK, used only for candidates EDHREC has no
  // synergy figure for (recommander picks, cards off the commander's page).
  commanderKw: true,
  commanderKwMax: 12,      // ceiling on the keyword-overlap bonus
  deckAffinity: true,
  affinityWeight: 5,       // bonus for reinforcing themes the deck already runs
  topEndCap: true,
  topEndThreshold: 6,      // "expensive" starts here (transcript: 6+ MV)
  topEndMax: 4,            // at most this many expensive cards in the deck
  drawQuality: true,       // loot/cantrips don't fill the Draw quota
  // OFF by default: measured counterproductive. The A/B harness (36 commanders)
  // showed this rule makes its OWN target metric worse — "weak expensive draw"
  // rose in every bucket with 2+ commander hooks (+0.48, and +1.50 for text-rich
  // commanders). Blocking a non-burst 4+ MV draw spell frees the slot for the
  // spillover pass, which refills it with something no cheaper. Left switchable
  // so the panel can re-test it after the rule is reworked.
  drawCurve: false,        // cap expensive draw slots (transcript: 8 of 12 at <=3 MV)
  drawExpensiveThreshold: 4, // "expensive" for a draw slot starts here
  drawExpensiveShare: 1 / 3,
  comboType: true,         // prefer resource loops below bracket 4
  // Engine pass: after the fill, top up whatever the commander's own text says
  // the deck needs to function (sacrifice outlets, blink, self-mill…). Measured
  // on 51 commanders, ~1 in 10 auto-filled decks is short of something its
  // commander requires — a correctness problem no ranking signal can see.
  enginePass: true,
  engineMaxAdd: 6,
  // Cap on cards the crowd never plays for this commander (recommander picks
  // with no EDHREC inclusion). Novelty is WANTED — surprise cards are a large
  // part of why building a deck is fun, and the recommender surfaces synergistic
  // cards that are simply underplayed. But it has to supplement the strategy,
  // not replace it.
  //
  // Measured across 51 commanders the distribution was bimodal and the mean
  // (12.7%) hid it completely: median 0%, but Muldrotha 71%, Korvold 69%,
  // Hei Bai 61%, Alesha 60%. Recommander returns ~200 picks for some commanders
  // and none for others; where it returns them they outnumber the EDHREC tail
  // and take the deck over. This bounds that tail without touching the many
  // decks already at 0.
  noveltyMaxShare: 0.15,         // ceiling on additions, so one need can't eat the deck
  // Roles the commander-keyword bonus applies to. null = every role.
  //
  // The distinction matters because the roles want different things: in Synergy
  // you want on-theme cards, but in Removal you want the BEST removal and
  // Swords to Plowshares does not care what your commander does. Measured on 36
  // commanders with this unscoped, the picked cards' average recommendation
  // strength fell in EVERY role — including Protection, where hooks went down
  // too, so it was paying quality for nothing.
  keywordRoles: null,
}

/**
 * The subset promoted to the SHIPPED Build Assistant — everyone, not just admins.
 *
 * Only the signals that survived measurement across 51 commanders and 20
 * archetypes, and only the ones that impose STRUCTURE rather than re-rank by
 * taste. Measured effect vs the previous shipped ranking:
 *
 *   top-end cap    cards at 6+ MV   6.57 → 3.35   the shipped build was putting
 *                                                 SEVEN uncastable bombs in a deck
 *   draw quality   loot in Draw     6.06 → 2.80   the Draw quota was being filled
 *                                                 with rummaging that nets no cards
 *   multi-role     2+ job cards     9.69 → 12.51
 *
 * Excluded on evidence, not caution:
 *   • EDHREC synergy + keyword overlap — both move ~2 cards of 99. Inside a
 *     commander-specific pool, synergy correlates 0.63-0.84 with inclusion, so
 *     re-ranking by it changes almost nothing.
 *   • drawCurve — made its own target metric worse.
 *   • the commander-cost curve shift — unproven, and it moved the wrong way.
 * The engine pass IS included: its targets are now derived per commander from
 * EDHREC (deriveEnablerTargets) instead of guessed, which was the condition for
 * promoting it.
 *
 * Known trade-off: multi-role slightly worsens draw quality on its own
 * (selection-only +0.65 in isolation) because a two-job card often does its
 * second job as looting. Net of the three together it still comes out ahead.
 */
export const SHIPPED_SIGNALS = {
  ...EXPERIMENTAL_DEFAULTS,
  multiRole: true,
  topEndCap: true,
  drawQuality: true,
  drawCurve: false,
  edhrecSynergy: false,
  // ON. Dismissed after measuring only the ownership-blind path, where it moves
  // ~1.7 cards of 99 and looks useless. Measured on the BINDER path against a
  // real 8,199-card collection it is the single strongest signal there: cards
  // hitting no commander hook 73.9% -> 64.0%, better than every other signal and
  // better than all of them combined. That is the situation it was designed for
  // and the one never tested -- most of a real collection is not on the
  // commander's EDHREC page, so inclusion is 0 for the bulk of the pool and every
  // candidate ties. Kept on for both paths: strongly positive on one, ~neutral
  // on the other, and source-conditional config is not worth the complexity.
  commanderKw: true,
  deckAffinity: true,
  comboType: false,
  noveltyMaxShare: 0.15,
  // Promoted: with per-commander targets derived from EDHREC rather than
  // guessed, this takes engine coverage from 57.8% to ~99% across 51
  // commanders — and specifically reverses the 6.4-point coverage regression
  // the three ranking signals above introduce by preferring generically
  // stronger cards over narrow enablers.
  enginePass: true,
}

// Beyond three roles the signal is almost certainly a classifier false positive
// (a card matching five predicates is usually one card with a lot of text), so
// the bonus stops compounding.
const MULTI_ROLE_CAP = 3

// ── Candidate text access ─────────────────────────────────────────────────────
// Owned candidates carry a full Scryfall entry; unowned suggestions carry only
// what the upgrade pool resolved. `oracle` is attached by the EDHREC enrichment
// when card metadata was fetched — absent for suggestions past the meta batch,
// which score 0 on the text-based signals and fall back to recommendation
// strength alone. Owned cards always have text, which is where these signals
// matter most (the binder pool is where EDHREC inclusion is uninformative).
export function candidateOracle(cand) {
  if (cand?.sfCard || cand?.card) return roleText(cand.sfCard, cand.card)
  return String(cand?.oracle || cand?.oracle_text || '').toLowerCase()
}

export function candidateType(cand) {
  if (cand?.sfCard || cand?.card) return roleTypeLine(cand.sfCard, cand.card)
  return String(cand?.type || cand?.type_line || '').toLowerCase()
}

/** Role tags for a candidate in either shape. */
export function candidateRoleTags(cand) {
  if (cand?.sfCard || cand?.card) return cardRoleTagsFromCard(cand.card, cand.sfCard)
  return cardRoleTags(candidateOracle(cand), candidateType(cand))
}

// ── Scoring context ───────────────────────────────────────────────────────────

/**
 * Precompute everything shared across candidates: the commander's keyword set
 * and the deck's current concept histogram. Built once per render, not per card.
 *
 * @param {Object} commander  { name, oracle, type } — oracle/type of the commander card
 * @param {Array}  deckCards  [{ oracle, type }] already in the deck
 */
export function buildScoringContext({ commanderOracle = '', commanderType = '', commanderCmc = null, deckTexts = [] } = {}) {
  return {
    keywords: extractCommanderKeywords(commanderOracle, commanderType),
    // Tribal theme, if any — read off the commander's rules text. Used by the
    // keyword fallback so a tribal deck's payoffs aren't invisible to it.
    tribe: extractTribe(commanderOracle, commanderType),
    profile: deckKeywordProfile(deckTexts),
    commanderCmc,
  }
}

/**
 * Experimental rank for one candidate, with a breakdown for the debug panel.
 * Base is the shipped `recRank` (EDHREC inclusion % or scaled recommander
 * score), so this can only reorder within/near a quality band — it never
 * invents quality for a card the data says nobody plays.
 *
 * @returns {{ rank: number, base: number, parts: Object, labels: string[] }}
 */
/** Has EDHREC published a synergy figure for this candidate? */
export function hasSynergyData(cand) {
  return typeof cand?.edhrecSynergy === 'number' && cand.edhrecSynergy !== 0
}

/** Rank points from EDHREC synergy, clamped. Negative for off-plan cards. */
export function synergyBonus(cand, cfg = EXPERIMENTAL_DEFAULTS) {
  if (!cfg.edhrecSynergy || !hasSynergyData(cand)) return 0
  const s = Math.max(cfg.synergyFloor, Math.min(cfg.synergyCeil, cand.edhrecSynergy))
  return Math.round(s * (cfg.synergyWeight || 0))
}

export function scoreCandidate(cand, ctx, cfg = EXPERIMENTAL_DEFAULTS) {
  const base = recRank(cand)
  const parts = { synergy: 0, multiRole: 0, keyword: 0, affinity: 0, drawPenalty: 0 }
  let labels = []

  if (cfg.multiRole || cfg.drawQuality) {
    const { jobs, tags } = candidateRoleTags(cand)
    if (cfg.multiRole) {
      // `jobs`, not `roles` — a card that ramps and replaces itself is a
      // two-job card even though its draw doesn't clear the quota bar.
      const n = Math.min(MULTI_ROLE_CAP, engineRoleCount(jobs))
      parts.multiRole = Math.max(0, n - 1) * (cfg.multiRoleWeight || 0)
    }
    // A card whose only "draw" is looting or a cantrip is card selection. It's
    // demoted rather than removed — it may still be a fine synergy card, it just
    // shouldn't outrank real card advantage when the Draw quota is what's short.
    if (cfg.drawQuality && tags.has('selection') && !tags.has('net-draw')) {
      parts.drawPenalty = -(cfg.multiRoleWeight || 8)
    }
  }

  parts.synergy = synergyBonus(cand, cfg)

  // Keyword overlap only where EDHREC has nothing to say. Running both would
  // double-count the same theme signal for cards on the commander's page, and
  // the empirical one is strictly better informed there.
  if (cfg.commanderKw && (ctx?.keywords?.size || ctx?.tribe) && !(cfg.edhrecSynergy && hasSynergyData(cand))) {
    const syn = synergyScore(candidateOracle(cand), candidateType(cand), ctx.keywords, ctx.tribe)
    parts.keyword = Math.min(cfg.commanderKwMax || 0, Math.round(syn.score * 4))
    labels = syn.labels
    if (cfg.deckAffinity && ctx.profile?.size) {
      parts.affinity = Math.round(deckAffinity(syn.matched, ctx.profile) * (cfg.affinityWeight || 0))
    }
  }

  const rank = base + parts.synergy + parts.multiRole + parts.keyword + parts.affinity + parts.drawPenalty
  return { rank, base, parts, labels }
}

/**
 * Drop-in replacement for deckBuildAssistant's private `rankComparator`, kept
 * structurally identical (bucketed rank first, then curve fit) so the only
 * variable under test is the rank itself.
 */
/**
 * Config with the keyword bonus disabled when `role` is outside `keywordRoles`.
 * Everything else (multi-role, draw quality) still applies — only the theme
 * bonus is scoped.
 */
export function cfgForRole(cfg = EXPERIMENTAL_DEFAULTS, role = null) {
  if (!cfg.keywordRoles || role == null) return cfg
  if (cfg.keywordRoles.includes(role)) return cfg
  return { ...cfg, commanderKw: false, deckAffinity: false }
}

/**
 * Per-role comparator factory for planAutoFill's `comparatorFor`. Returns the
 * same comparator for every role unless `cfg.keywordRoles` scopes the theme
 * bonus, in which case the excluded roles rank on quality alone.
 */
export function makeExperimentalComparatorFor({ ctx, cfg = EXPERIMENTAL_DEFAULTS, targetCmc = null, curveStatus = 'on' } = {}) {
  const cache = new Map()
  return role => {
    // Lands are exempt: the caller has already ordered them by which colours the
    // deck is short of, which is the only thing that matters about a land, and
    // no amount of multi-role or keyword score changes that. Returning null
    // tells planAutoFill to keep that order.
    if (role === ROLE_LANDS) return null
    if (!cache.has(role)) {
      cache.set(role, makeExperimentalComparator({ ctx, cfg: cfgForRole(cfg, role), targetCmc, curveStatus }))
    }
    return cache.get(role)
  }
}

export function makeExperimentalComparator({ ctx, cfg = EXPERIMENTAL_DEFAULTS, targetCmc = null, curveStatus = 'on' } = {}) {
  const RANK_BUCKET = 6
  const rankOf = entry => scoreCandidate(entry.cand, ctx, cfg).rank
  if (targetCmc == null) {
    return (a, b) =>
      (rankOf(b) - rankOf(a)) ||
      ((a.cand.cmc ?? 0) - (b.cand.cmc ?? 0)) ||
      String(a.cand.name || '').localeCompare(b.cand.name || '')
  }
  return (a, b) =>
    (Math.round(rankOf(b) / RANK_BUCKET) - Math.round(rankOf(a) / RANK_BUCKET)) ||
    (curveFitKey(a.cand.cmc, curveStatus, targetCmc) - curveFitKey(b.cand.cmc, curveStatus, targetCmc)) ||
    (rankOf(b) - rankOf(a)) ||
    String(a.cand.name || '').localeCompare(b.cand.name || '')
}

// ── #3 Top-end cap ────────────────────────────────────────────────────────────
// The transcript's cut rubric is a shape constraint the shipped assistant can't
// express: it targets an average mana value, which a barbell curve satisfies
// while playing eight 7-drops. "Only three or four of these big cards" is a
// count, so it needs a count.

/** Cards at or above the expensive threshold currently in the deck. */
export function countTopEnd(deckCards = [], sfMap = {}, threshold = 6) {
  let n = 0
  for (const dc of deckCards) {
    if (dc?.is_commander) continue
    const sf = sfMap?.[dc?.scryfall_id] || null
    const type = (sf?.type_line || dc?.type_line || '').toLowerCase()
    if (type.includes('land')) continue
    const cmc = sf?.cmc ?? dc?.cmc ?? 0
    if (cmc >= threshold) n += dc.qty || 1
  }
  return n
}

// ── #5 Draw sub-curve ─────────────────────────────────────────────────────────
// "Of 12 card advantage pieces, about 8 should be 3 MV or less, and the
// expensive ones must draw explosively." Expressed as a share so it scales with
// whatever the Draw quota ends up being after bracket/archetype flexing.

/** Is this an expensive draw slot that isn't paying for itself with burst? */
export function isWeakExpensiveDraw(cand, cfg = EXPERIMENTAL_DEFAULTS) {
  if ((cand?.cmc ?? 0) < (cfg?.drawExpensiveThreshold ?? 4)) return false
  const q = drawQuality(candidateOracle(cand))
  return !q.burst
}

/**
 * The exclusion gate auto-fill applies on top of the caller's own filters.
 * Returns a function matching planAutoFill's `exclude(cand, { role, picks })`
 * contract, so it composes with the live budget/bracket/already-added gates.
 *
 * Stateless: every decision is derived from the picks made so far in THIS
 * planAutoFill run plus the deck snapshot, never from mutable module state —
 * the component dry-runs planAutoFill several times per render.
 */
export function makeExperimentalExclude({
  cfg = EXPERIMENTAL_DEFAULTS,
  deckTopEnd = 0,
  drawRole = null,
  drawTarget = 0,
  nonlandBudget = 62,
  deckNovelty = 0,
} = {}) {
  return (cand, info = {}) => {
    const picks = info.picks || []

    // #3 — hard ceiling on expensive cards, counting what's already in the deck.
    if (cfg.topEndCap) {
      const threshold = cfg.topEndThreshold ?? 6
      const cmc = cand?.cmc ?? 0
      if (cmc >= threshold) {
        const picked = picks.filter(p => (p.cand?.cmc ?? 0) >= threshold).length
        if (deckTopEnd + picked >= (cfg.topEndMax ?? 4)) return true
      }
    }

    // Novelty ceiling: keep off-meta SUGGESTIONS a supplement rather than the
    // deck. Owned cards are exempt — on the binder path "the crowd never plays
    // this" describes most of a real collection, and capping it made the build
    // reject the user's own cards to reach for EDHREC staples they happen to
    // own, which defeats the point of building from binders. Measured on a real
    // 8,199-card pool, the cap was cutting off-meta owned cards from 23% to 13%.
    // The risk this guards against is the recommender taking over, and the
    // recommender only ever supplies unowned candidates.
    const isOwned = !!(cand?.sfCard || cand?.card)
    if (cfg.noveltyMaxShare != null && !isOwned && !(cand?.edhrecInclusion > 0)) {
      const allowed = Math.floor(nonlandBudget * cfg.noveltyMaxShare)
      const taken = deckNovelty + picks.filter(p => !(p.cand?.sfCard || p.cand?.card) && !(p.cand?.edhrecInclusion > 0)).length
      if (taken >= allowed) return true
    }

    // #5 — the Draw quota is for cards that NET cards. A looter or cantrip is
    // card selection; it can still make the deck as synergy, just not here.
    if (info.role && drawRole && info.role === drawRole) {
      const tags = candidateRoleTags(cand).tags
      if (cfg.drawQuality && tags.has('selection') && !tags.has('net-draw')) return true

      // …and the draw package needs its own curve: only a minority of it may be
      // expensive, and those must draw explosively.
      if (cfg.drawCurve && isWeakExpensiveDraw(cand, cfg)) {
        const maxExpensive = Math.max(1, Math.floor((drawTarget || 0) * (cfg.drawExpensiveShare ?? 1 / 3)))
        const expensivePicked = picks.filter(
          p => p.role === drawRole && (p.cand?.cmc ?? 0) >= (cfg.drawExpensiveThreshold ?? 4),
        ).length
        if (expensivePicked >= maxExpensive) return true
      }
    }

    return false
  }
}

// ── #6 Combo outcome typing ───────────────────────────────────────────────────
// The "soft combo" idea: a loop producing infinite mana / tokens / ETB triggers
// is a resource you play around with; a loop that reads "you win the game" ends
// the table. Commander Spellbook already tells us which is which via each
// combo's produced features — `mapAlmostCombos` extracts them and the shipped
// pass then ignores them.

const WIN_FEATURE = /win the game|loses? the game|infinite damage|infinite loops? of damage|each opponent loses/i

/** 'win' when the combo ends the game outright, 'resource' otherwise. */
export function classifyComboOutcome(produces = []) {
  for (const f of produces) {
    if (WIN_FEATURE.test(String(f || ''))) return 'win'
  }
  return 'resource'
}

/**
 * Reorder near-complete combos for the post-fill pass. Below bracket 4 the
 * resource loops sort first, so a casual build gets an engine rather than a
 * "press here to end the game" button. At bracket 4+ the order is untouched —
 * a high-power deck wants the kill.
 *
 * Stable within each group, so the caller's existing owned-first / fewest-
 * missing ordering survives.
 */
export function preferResourceCombos(combos = [], targetBracket = null, cfg = EXPERIMENTAL_DEFAULTS) {
  if (!cfg.comboType) return combos
  if (targetBracket != null && targetBracket >= 4) return combos
  const resource = []
  const win = []
  for (const c of combos) {
    ;(classifyComboOutcome(c?.produces) === 'win' ? win : resource).push(c)
  }
  return [...resource, ...win]
}

// ── Commander-cost-aware curve target ─────────────────────────────────────────
// "My commander costs four and I want a board before I cast it, so I load up on
// one, two and three drops." An expensive commander pulls the rest of the deck
// cheaper; a one- or two-mana commander leaves room for a higher curve.
export function adjustTargetForCommander(targetCmc, commanderCmc) {
  if (targetCmc == null || commanderCmc == null) return targetCmc
  const shift = Math.max(-0.3, Math.min(0.5, (commanderCmc - 3) * 0.15))
  return Math.max(1.5, targetCmc - shift)
}

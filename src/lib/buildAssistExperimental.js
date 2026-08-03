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
import { ROLE_LANDS, ROLE_DRAW } from './buildRoles'
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
  commanderKw: true,
  commanderKwMax: 12,      // ceiling on the keyword-overlap bonus
  deckAffinity: true,
  affinityWeight: 5,       // bonus for reinforcing themes the deck already runs
  topEndCap: true,
  topEndThreshold: 6,      // "expensive" starts here (transcript: 6+ MV)
  topEndMax: 4,            // at most this many expensive cards in the deck
  drawQuality: true,       // loot/cantrips don't fill the Draw quota
  drawExpensiveThreshold: 4, // "expensive" for a draw slot starts here
  // Fallback only. The share is normally DERIVED per commander from the EDHREC
  // page (deriveDrawExpensiveShare); this flat third is what a very thin page
  // falls back to, and it is the figure the rule shipped off because of — as one
  // number for every deck it capped big-mana and tribal lists at roughly half
  // the expensive draw their crowd actually runs, while letting enchantress and
  // voltron lists run more.
  drawExpensiveShare: 1 / 3,
  // Engine pass: after the fill, top up whatever the commander's own text says
  // the deck needs to function (sacrifice outlets, blink, self-mill…). Measured
  // on 51 commanders, ~1 in 10 auto-filled decks is short of something its
  // commander requires — a correctness problem no ranking signal can see.
  enginePass: true,
  engineMaxAdd: 10,
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
  // …and a floor, so they don't vanish entirely. Reported from the app: with
  // only a ceiling, a commander with a rich EDHREC page produced a deck with no
  // off-meta cards at all, because every slot went to a better-ranked staple.
  //
  // Lives here rather than only on SHIPPED_SIGNALS: defined on the override
  // alone, lab mode ran with NO novelty floor and was strictly worse than what
  // every other user got — the opposite of what a lab is for.
  noveltyMinShare: 0.08,
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
 * The draw sub-curve was the last hold-out here, switched off because as a flat
 * one-third it made its own target metric worse. It is no longer flat: the share
 * is derived per commander (deriveDrawExpensiveShare), which is what that rule
 * needed, so it is on for everyone with no switch.
 *
 * The engine pass IS included: its targets are now derived per commander from
 * EDHREC (deriveEnablerTargets) instead of guessed, which was the condition for
 * promoting it.
 *
 * Deleted outright, after measurement (see git history for the numbers):
 *   • EDHREC synergy re-ranking — 4.2 cards of 99, its own target metric +0.01,
 *     and engine coverage, enablers missing and net card advantage all slightly
 *     worse. Inside a commander-specific pool synergy correlates 0.63-0.84 with
 *     inclusion, so re-ranking by it re-states the ranking it started from. It
 *     also suppressed recommander picks (6.6% -> 4.0%), fighting the novelty
 *     floor. The `edhrecSynergy` FIELD survives on candidates — the harness uses
 *     it as an independent quality metric, which is the one job it is good at.
 *   • the commander-cost curve shift — double counting. The curve target is
 *     EDHREC's inclusion-weighted mean for THAT commander, so how real decks
 *     respond to an expensive commander is already in the number; shifting it
 *     again moved Ur-Dragon's observed 3.2 down to 2.7.
 *   • combo outcome typing — unmeasured, and it reordered ahead of
 *     mapAlmostCombos' owned-first / fewest-missing sort, so it could pick a
 *     combo needing three unowned pieces over one needing a single owned piece.
 *     The bracket cap already limits how many combos a <=3 deck completes.
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
const ORACLE_CACHE = new WeakMap()
export function candidateOracle(cand) {
  if (cand && typeof cand === 'object') {
    const hit = ORACLE_CACHE.get(cand)
    if (hit !== undefined) return hit
  }
  const text = (cand?.sfCard || cand?.card)
    ? roleText(cand.sfCard, cand.card)
    : String(cand?.oracle || cand?.oracle_text || '').toLowerCase()
  if (cand && typeof cand === 'object') ORACLE_CACHE.set(cand, text)
  return text
}

export function candidateType(cand) {
  if (cand?.sfCard || cand?.card) return roleTypeLine(cand.sfCard, cand.card)
  return String(cand?.type || cand?.type_line || '').toLowerCase()
}

// Role tagging runs ~10 independent regex predicates over the whole card text,
// and scoreCandidate is called from inside a sort comparator — so the same card
// gets classified O(log n) times per sort, per role, per render. Caching by
// candidate identity turns that back into once. WeakMap so pools that go out of
// scope are collectable.
const ROLE_TAG_CACHE = new WeakMap()

/** Role tags for a candidate in either shape. */
export function candidateRoleTags(cand) {
  if (cand && typeof cand === 'object') {
    const hit = ROLE_TAG_CACHE.get(cand)
    if (hit) return hit
  }
  const tags = (cand?.sfCard || cand?.card)
    ? cardRoleTagsFromCard(cand.card, cand.sfCard)
    : cardRoleTags(candidateOracle(cand), candidateType(cand))
  if (cand && typeof cand === 'object') ROLE_TAG_CACHE.set(cand, tags)
  return tags
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
/**
 * An off-meta pick: something the crowd doesn't play for this commander. Only
 * unowned suggestions qualify — an owned card with no EDHREC inclusion is just a
 * card from your collection, and treating those as novelty made the binder path
 * reject its own pool (see noveltyMaxShare).
 */
export function isNoveltyPick(cand) {
  return !(cand?.sfCard || cand?.card) && !(cand?.edhrecInclusion > 0)
}

export function scoreCandidate(cand, ctx, cfg = EXPERIMENTAL_DEFAULTS) {
  const base = recRank(cand)
  const parts = { multiRole: 0, keyword: 0, affinity: 0, drawPenalty: 0 }
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

  if (cfg.commanderKw && (ctx?.keywords?.size || ctx?.tribe)) {
    const syn = synergyScore(candidateOracle(cand), candidateType(cand), ctx.keywords, ctx.tribe)
    parts.keyword = Math.min(cfg.commanderKwMax || 0, Math.round(syn.score * 4))
    labels = syn.labels
    if (cfg.deckAffinity && ctx.profile?.size) {
      parts.affinity = Math.round(deckAffinity(syn.matched, ctx.profile) * (cfg.affinityWeight || 0))
    }
  }

  const rank = base + parts.multiRole + parts.keyword + parts.affinity + parts.drawPenalty
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
  // A comparator is called O(n log n) times; without this every comparison
  // re-ran the full classification. This was the cause of multi-second handlers
  // in the assistant once the experimental ranking became the shipped one.
  const cache = new Map()
  const rankOf = entry => {
    const c = entry.cand
    if (cache.has(c)) return cache.get(c)
    const v = scoreCandidate(c, ctx, cfg).rank
    cache.set(c, v)
    return v
  }
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
  // Per-commander allowance from EDHREC; falls back to cfg.topEndMax.
  topEndAllowance = null,
  drawRole = null,
  drawTarget = 0,
  // Per-commander share of the draw package allowed to be expensive, from
  // deriveDrawExpensiveShare. Null falls back to cfg.drawExpensiveShare.
  drawExpensiveShare = null,
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
        if (deckTopEnd + picked >= (topEndAllowance ?? cfg.topEndMax ?? 4)) return true
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
    if (cfg.noveltyMaxShare != null && isNoveltyPick(cand)) {
      const allowed = Math.floor(nonlandBudget * cfg.noveltyMaxShare)
      const taken = deckNovelty + picks.filter(p => isNoveltyPick(p.cand)).length
      if (taken >= allowed) return true
    }

    // #5 — the Draw quota is for cards that NET cards. A looter or cantrip is
    // card selection; it can still make the deck as synergy, just not here.
    if (info.role && drawRole && info.role === drawRole) {
      // Must be the SAME test the live count uses (roleOfDeck keeps a card in
      // Draw only when cardRoleTags puts it there). Rejecting merely the cards
      // tagged 'selection' let two other kinds through that also don't count: a
      // card whose oracle text couldn't be resolved (tagged neither way) and a
      // tutor. Both filled Draw slots and then registered as nothing, so a full
      // 100-card deck sat at "Draw 7/12" and was genuinely short of card
      // advantage rather than merely mis-displaying it.
      // Only judge when there is text to judge. An EDHREC suggestion past the
      // metadata batch has no oracle text at all, and rejecting those emptied
      // the role: a five-colour deck with a huge pool came out at Draw 3/12,
      // worse than the mismatch this was meant to fix. Unverifiable is not the
      // same as disqualified — the shipped classifier's word stands.
      if (cfg.drawQuality && candidateOracle(cand)
          && !candidateRoleTags(cand).roles.has(ROLE_DRAW)) return true

      // …and the draw package needs its own curve: only a minority of it may be
      // expensive, and those must draw explosively. The share is derived per
      // commander (a spellslinger deck draws on cantrips, a big-mana or tribal
      // one draws off its six-drops), falling back to the flat figure only when
      // the EDHREC page is too thin to measure.
      if (isWeakExpensiveDraw(cand, cfg)) {
        const share = drawExpensiveShare ?? cfg.drawExpensiveShare ?? 1 / 3
        const maxExpensive = Math.max(1, Math.floor((drawTarget || 0) * share))
        const expensivePicked = picks.filter(
          p => p.role === drawRole && (p.cand?.cmc ?? 0) >= (cfg.drawExpensiveThreshold ?? 4),
        ).length
        if (expensivePicked >= maxExpensive) return true
      }
    }

    return false
  }
}


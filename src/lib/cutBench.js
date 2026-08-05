// The cut helper's "bench": for each role, the best card that is available and
// NOT in the deck. A deck card clearly weaker than its own bench is bad in a way
// that has nothing to do with category counts, which is what puts it in
// CUT_TIER.BENCHED — see analyzeCut.
//
// Pure, and separate from the component, for two reasons. It is the only part of
// the cut path that walks the user's whole candidate pool, so it is where the
// cost lives and where the cost has to be tested. And it was previously inline
// in a 3,400-line component, which meant none of it could be tested at all.

import { ROLE_LANDS, ROLE_SYNERGY } from './buildRoles'

// Roles the bench refuses to reason about, because "you have a better card for
// this slot" needs the slot to mean something.
//
//   • Lands — land candidates are ordered by which colours the deck is short of,
//     not by card quality, so a "better land" compares them on the one axis that
//     doesn't decide a land.
//   • Synergy — the REMAINDER bucket (COMMANDER_TEMPLATE has it as 'remainder').
//     It holds everything that isn't ramp, draw, removal, a wipe, protection or
//     a wincon, so two cards sharing it have nothing in common by construction.
//     Measured against a real deck, every unfair pairing the bench produced was
//     here and only here: Rise of the Witch-king (sacrifice/reanimate) "replaced
//     by" Hardened Scales (+1/+1 counter multiplier), Crippling Fear (tribal
//     wipe) by Bloodline Pretender (changeling lord), Wilderland Scrounger
//     (counters on attack) by Graveshifter (recursion). Every pairing in a real
//     role held up: Removal for Removal, Ramp for Ramp, Draw for Draw.
//
// Cards here are not exempt from the cut — an overfilled Synergy count still
// puts its weakest in CUT_TIER.EXCESS, which is an honest reason. They just
// stop being offered a replacement that was never comparable.
const UNBENCHABLE_ROLES = new Set([ROLE_LANDS, ROLE_SYNERGY])

/**
 * A deck row in the shape `scoreCandidate` reads, so a card already in the deck
 * is judged by exactly the ranking that would have picked it.
 *
 * `card`/`sfCard` are what candidateOracle and candidateRoleTags look for — they
 * memoise per candidate object, so callers should cache the result per deck row
 * rather than rebuilding it (rebuilding misses both caches and re-runs ~20
 * regexes per card per render).
 */
export function deckCardToCutCandidate({ dc, sfCard = null, inclusion = 0, score = 0 } = {}) {
  return {
    name: dc?.name || '',
    cmc: sfCard?.cmc ?? dc?.cmc ?? 0,
    card: dc,
    sfCard,
    edhrecInclusion: inclusion || 0,
    score: score || 0,
  }
}

// What the UI needs to name a replacement and show its card. Candidates arrive
// in two shapes — an owned one carries the collection row and its Scryfall entry
// (`card` / `sfCard`), an unowned suggestion carries a resolved `image` — so
// both are passed through and the caller uses whichever it gets.
function benchEntry(cand, strength) {
  return {
    name: cand?.name || '',
    strength,
    scryfall_id: cand?.sfCard?.id || cand?.card?.scryfall_id || null,
    image: cand?.image || null,
  }
}

/**
 * The `limit` strongest available candidates in `pool` that are not in the deck,
 * strongest first.
 *
 * A LIST, not a single card, because the caller spends each one on a different
 * deck card: an unplayed Hardened Scales can replace one card, not every card in
 * its role. `limit` is therefore the most benchings that role could ever
 * justify — the caller passes its deck count for that role.
 *
 * The pool is the user's whole collection bucketed by role on the binder path —
 * uncapped, and measured at ~10ms per 1,000 candidates to score. Scoring all of
 * it on every deck change was ~80ms for a large binder, so this scores as few as
 * it can and proves it never needs more:
 *
 *   `rank(c) = baseOf(c) + bonuses`, and `ceiling` is the largest those bonuses
 *   can be (scoreBonusCeiling). Walking the pool in descending `baseOf` order,
 *   once `baseOf(next) + ceiling <= weakest kept`, no remaining candidate can
 *   displace anything already held — every one of them has a smaller base, and
 *   the ceiling is the most any base can gain.
 *
 * So the answer is identical to scoring the whole pool; only the work differs.
 * Pass `ceiling = Infinity` to disable the early exit (a caller whose `rankOf`
 * is not `baseOf` plus bounded bonuses must do this, or the result is wrong).
 *
 * @param {Object}   args
 * @param {Array}    args.pool        candidates for one role
 * @param {Function} args.rankOf      (cand) => full score. Expensive.
 * @param {Function} args.baseOf      (cand) => cheap lower-bound term of rankOf
 * @param {number}   args.ceiling     max of `rankOf - baseOf`
 * @param {number}   args.limit       how many to return
 * @param {Function} [args.isExcluded] (cand) => true to skip (budget, bracket,
 *   shape caps, already added). Applied before scoring, so the bench can never
 *   suggest a card the fill itself would have refused.
 * @returns {Array<{ name: string, strength: number }>}
 */
export function bestBenchCandidates({ pool = [], rankOf, baseOf, ceiling = Infinity, limit = 1, isExcluded = null } = {}) {
  if (!pool.length || limit <= 0 || typeof rankOf !== 'function' || typeof baseOf !== 'function') return []
  // Sort a copy: the pool belongs to the plan and other readers depend on its
  // order (auto-fill's own ordering, most visibly).
  const ordered = pool
    .map(cand => ({ cand, base: baseOf(cand) }))
    .sort((a, b) => b.base - a.base)

  const kept = [] // strongest first, length <= limit
  for (const { cand, base } of ordered) {
    if (kept.length >= limit && base + ceiling <= kept[kept.length - 1].strength) break
    if (cand?.inDeck) continue
    if (isExcluded && isExcluded(cand)) continue
    const strength = rankOf(cand)
    if (kept.length >= limit && strength <= kept[kept.length - 1].strength) continue
    const at = kept.findIndex(k => strength > k.strength)
    kept.splice(at === -1 ? kept.length : at, 0, benchEntry(cand, strength))
    if (kept.length > limit) kept.pop()
  }
  return kept
}

/**
 * Bench for every role, as a Map of role → ordered replacement list.
 *
 * `source` mirrors auto-fill's: on the binder path the bench is cards you own
 * and are not playing, so the same rule that decided what went in decides what
 * comes out. UNBENCHABLE_ROLES are skipped entirely — see there.
 *
 * `limitFor(role)` bounds each list. The caller passes how many cards the deck
 * holds in that role, since a role can never need more replacements than it has
 * cards — and a tighter limit is also less work, because it lets the top-K walk
 * stop sooner.
 */
export function buildCutBench({
  roles = [], source = 'owned', rankOf, baseOf, ceiling = Infinity,
  limitFor = null, isExcluded = null,
} = {}) {
  const bench = new Map()
  for (const role of roles) {
    if (!role || UNBENCHABLE_ROLES.has(role.role)) continue
    const limit = limitFor ? limitFor(role.role) : 1
    if (limit <= 0) continue
    const pool = source === 'owned'
      ? (role.ownedCandidates || [])
      : [...(role.ownedCandidates || []), ...(role.edhrecUpgrades || []), ...(role.recommenderUpgrades || [])]
    const best = bestBenchCandidates({
      pool,
      rankOf,
      baseOf,
      ceiling,
      limit,
      isExcluded: isExcluded ? cand => isExcluded(cand, role.role) : null,
    })
    if (best.length) bench.set(role.role, best)
  }
  return bench
}

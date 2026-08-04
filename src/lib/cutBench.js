// The cut helper's "bench": for each role, the best card that is available and
// NOT in the deck. A deck card clearly weaker than its own bench is bad in a way
// that has nothing to do with category counts, which is what puts it in
// CUT_TIER.BENCHED — see analyzeCut.
//
// Pure, and separate from the component, for two reasons. It is the only part of
// the cut path that walks the user's whole candidate pool, so it is where the
// cost lives and where the cost has to be tested. And it was previously inline
// in a 3,400-line component, which meant none of it could be tested at all.

import { ROLE_LANDS } from './buildRoles'

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

/**
 * Best available candidate in `pool` that is not already in the deck.
 *
 * The pool is the user's whole collection bucketed by role on the binder path —
 * uncapped, and measured at ~10ms per 1,000 candidates to score. Scoring all of
 * it on every deck change was ~80ms for a large binder, so this scores as few as
 * it can and proves it never needs more:
 *
 *   `rank(c) = baseOf(c) + bonuses`, and `ceiling` is the largest those bonuses
 *   can be (scoreBonusCeiling). Walking the pool in descending `baseOf` order,
 *   once `baseOf(next) + ceiling <= best`, no remaining candidate can beat the
 *   best already found — every one of them has a smaller base, and the ceiling
 *   is the most any base can gain.
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
 * @param {Function} [args.isExcluded] (cand) => true to skip (budget, bracket,
 *   shape caps, already added). Applied before scoring, so the bench can never
 *   suggest a card the fill itself would have refused.
 * @returns {{ name: string, strength: number } | null}
 */
export function bestBenchCandidate({ pool = [], rankOf, baseOf, ceiling = Infinity, isExcluded = null } = {}) {
  if (!pool.length || typeof rankOf !== 'function' || typeof baseOf !== 'function') return null
  // Sort a copy: the pool belongs to the plan and other readers depend on its
  // order (auto-fill's own ordering, most visibly).
  const ordered = pool
    .map(cand => ({ cand, base: baseOf(cand) }))
    .sort((a, b) => b.base - a.base)

  let best = null
  for (const { cand, base } of ordered) {
    if (best && base + ceiling <= best.strength) break
    if (cand?.inDeck) continue
    if (isExcluded && isExcluded(cand)) continue
    const strength = rankOf(cand)
    if (!best || strength > best.strength) best = { name: cand.name, strength }
  }
  return best
}

/**
 * Bench for every role, as a Map keyed by role.
 *
 * `source` mirrors auto-fill's: on the binder path the bench is cards you own
 * and are not playing, so the same rule that decided what went in decides what
 * comes out. Lands are exempt — land candidates are ordered by which colours the
 * deck is short of, not by card quality, so "a better land is available" would
 * compare them on the one axis that doesn't decide a land.
 */
export function buildCutBench({ roles = [], source = 'owned', rankOf, baseOf, ceiling = Infinity, isExcluded = null } = {}) {
  const bench = new Map()
  for (const role of roles) {
    if (!role || role.role === ROLE_LANDS) continue
    const pool = source === 'owned'
      ? (role.ownedCandidates || [])
      : [...(role.ownedCandidates || []), ...(role.edhrecUpgrades || []), ...(role.recommenderUpgrades || [])]
    const best = bestBenchCandidate({
      pool,
      rankOf,
      baseOf,
      ceiling,
      isExcluded: isExcluded ? cand => isExcluded(cand, role.role) : null,
    })
    if (best) bench.set(role.role, best)
  }
  return bench
}

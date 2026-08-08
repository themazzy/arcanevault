/**
 * Escalation-ladder tests.
 *
 * Two rules, both broken once and both visible in the same device log
 * (2026-08-08), where one stationary card produced six consecutive misses that
 * each read `frames 1:9x/8+` — a single frame, a plausible gap, and a distance
 * the ceiling was always going to refuse:
 *
 *   1. Nothing above MATCH_ACCEPT_CEILING may be treated as good enough to
 *      stop looking. The ladder's distance gates predate the ceiling dropping
 *      to 93 and were still comparing against 108/122/134.
 *   2. A candidate is judged on its OWN gap and cluster flag. The vote map used
 *      to carry only the card, so the gate could accept the most-voted
 *      candidate while reading the lowest-distance candidate's evidence.
 */

import { describe, it, expect } from 'vitest'
import { isDecisiveCandidate, getStableVote, shouldAcceptMatch } from './CardScanner.jsx'

const card = (distance, name = 'Test Card') => ({ distance, name, id: `${name}-${distance}` })

describe('isDecisiveCandidate', () => {
  it('never calls a distance the ceiling refuses decisive', () => {
    // The whole band that used to stop the ladder AND break the stability loop.
    for (const distance of [94, 99, 105, 108]) {
      expect(isDecisiveCandidate(card(distance), 40), `distance ${distance}`).toBe(false)
      // …and the acceptance gate agrees it was never acceptable, which is the
      // point: stopping there could only ever produce a miss.
      expect(shouldAcceptMatch({ best: card(distance), gap: 40, stableCount: 3 }).accepted).toBe(false)
    }
  })

  it('still exits early on a real hit, so hits do not get slower', () => {
    // Every distance logged as a correct match on device.
    for (const [distance, gap] of [[47, 58], [57, 46], [72, 22], [86, 16], [90, 20], [93, 20]]) {
      expect(isDecisiveCandidate(card(distance), gap), `distance ${distance}`).toBe(true)
    }
  })

  it('needs a gap as well as a distance', () => {
    expect(isDecisiveCandidate(card(50), 7)).toBe(false)
    expect(isDecisiveCandidate(card(50), 8)).toBe(true)
  })

  it('handles a missing candidate', () => {
    expect(isDecisiveCandidate(null, 40)).toBe(false)
  })
})

describe('getStableVote', () => {
  const vote = (best, count, gap, sameNameCluster = false) => [best.id, { count, best, gap, sameNameCluster }]

  it('keeps gap and cluster attached to the winning candidate', () => {
    // Card A wins on votes; card B is closer but was seen once. The gate must
    // read A's gap of 30, not B's gap of 2.
    const a = card(80, 'Voted Card')
    const b = card(60, 'Closer Card')
    const winner = getStableVote(new Map([vote(a, 2, 30), vote(b, 1, 2)]))
    expect(winner.best).toBe(a)
    expect(winner.gap).toBe(30)
  })

  it('breaks a vote tie on distance', () => {
    const near = card(60, 'Near')
    const far = card(90, 'Far')
    expect(getStableVote(new Map([vote(far, 1, 20), vote(near, 1, 20)])).best).toBe(near)
  })

  it('returns null with no votes', () => {
    expect(getStableVote(new Map())).toBe(null)
  })

  it('a voted candidate carrying a weak gap is refused', () => {
    // The failure this pairing prevents: accepting the voted card because a
    // DIFFERENT card, in another frame, happened to have a clean gap.
    const voted = getStableVote(new Map([vote(card(88, 'Ambiguous'), 2, 3)]))
    const r = shouldAcceptMatch({
      best: voted.best, gap: voted.gap, stableCount: voted.count,
      sameNameCluster: voted.sameNameCluster,
    })
    expect(r.accepted).toBe(false)
  })
})

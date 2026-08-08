/**
 * Acceptance-gate tests.
 *
 * The ceiling exists because of a real false accept observed on device
 * (2026-08-08): a card that does not exist in the user's collection was
 * accepted at distance 104 with gap 3, via a sameNameCluster branch that
 * requires no gap at all. Two independent sources say nothing above ~90 is a
 * real match — the gate harness (correct p95 62.3, held-out cards min 92.0) and
 * that device log (true hits 57/71/72/79/86, misses 103-107).
 */

import { describe, it, expect } from 'vitest'
import { shouldAcceptMatch } from './CardScanner.jsx'

const card = (distance, name = 'Test Card') => ({ distance, name, id: `id-${name}-${distance}` })

describe('shouldAcceptMatch — ceiling', () => {
  it('rejects the exact device false-accept case', () => {
    // "Sentinel's Eyes", distance 104, gap 3, 3 stable frames, same-name runner-up.
    const r = shouldAcceptMatch({
      best: card(104), gap: 3, stableCount: 3, sameNameCluster: true,
    })
    expect(r.accepted).toBe(false)
    expect(r.reason).toMatch(/ceiling/)
  })

  it('rejects a same-name cluster above the ceiling no matter how many votes', () => {
    // The branch this closes required no gap and reached MATCH_STRONG_THRESHOLD.
    for (const stableCount of [1, 2, 3]) {
      const r = shouldAcceptMatch({ best: card(130), gap: 0, stableCount, sameNameCluster: true })
      expect(r.accepted).toBe(false)
    }
  })

  it('rejects a high-distance match even with a large gap', () => {
    expect(shouldAcceptMatch({ best: card(115), gap: 40, stableCount: 3 }).accepted).toBe(false)
  })

  it('still accepts every distance observed as a real hit on device', () => {
    // Across three sessions. The last entry is "Mayhem Devil" at 90 — a
    // correctly identified card that landed one point under a ceiling of 90,
    // which is why the ceiling moved to 93.
    const realHits = [
      [47, 58], [48, 57], [51, 56], [52, 56], [57, 46], [67, 43], [68, 43],
      [71, 31], [72, 22], [73, 31], [79, 29], [86, 16], [90, 20],
    ]
    for (const [distance, gap] of realHits) {
      const r = shouldAcceptMatch({ best: card(distance), gap, stableCount: 1 })
      expect(r.accepted, `distance ${distance} gap ${gap} should still accept`).toBe(true)
    }
  })

  it('rejects every wrong match observed on device', () => {
    // 97 and 99 are the two "Blood Sun" false accepts a ceiling of 100 missed;
    // 103/104/105 are the rest. All had plausible-looking gaps, which is
    // exactly why distance has to be the gate.
    const wrongMatches = [[97, 7], [99, 9], [103, 10], [104, 3], [105, 8]]
    for (const [distance, gap] of wrongMatches) {
      const r = shouldAcceptMatch({ best: card(distance), gap, stableCount: 3, sameNameCluster: true })
      expect(r.accepted, `distance ${distance} gap ${gap} must be rejected`).toBe(false)
    }
  })

  it('sits inside the observed corridor between real and wrong matches', () => {
    // Worst true hit 90 ("Mayhem Devil"), best false one 97 ("Blood Sun").
    // The ceiling must accept the former and reject the latter, with the two
    // unattributed 95s left deliberately on the reject side until a logged
    // rejection says which they were.
    expect(shouldAcceptMatch({ best: card(90), gap: 20, stableCount: 2 }).accepted).toBe(true)
    expect(shouldAcceptMatch({ best: card(93), gap: 20, stableCount: 2 }).accepted).toBe(true)
    expect(shouldAcceptMatch({ best: card(95), gap: 11, stableCount: 2 }).accepted).toBe(false)
    expect(shouldAcceptMatch({ best: card(97), gap: 7, stableCount: 2 }).accepted).toBe(false)
  })

  it('still accepts a genuine same-art reprint cluster below the ceiling', () => {
    // Same-art reprints sit at gap ~0 by nature; that branch must survive.
    const r = shouldAcceptMatch({ best: card(70), gap: 0, stableCount: 2, sameNameCluster: true })
    expect(r.accepted).toBe(true)
  })

  it('returns a reason naming the distance and the ceiling', () => {
    const r = shouldAcceptMatch({ best: card(140), gap: 30, stableCount: 3 })
    expect(r.reason).toContain('140')
    expect(r.reason).toContain('93')
  })

  it('handles a missing candidate', () => {
    expect(shouldAcceptMatch({ best: null, gap: 0, stableCount: 0 }).accepted).toBe(false)
  })

  // The multi-frame fusion rescue in handleScan used to inline its own
  // distance/gap/cluster test (`distance <= MATCH_THRESHOLD && …`) instead of
  // calling this function, which let it accept the whole 94-122 band the
  // ceiling exists to refuse. It now calls shouldAcceptMatch with the fused
  // candidate and the sampled frame count as its vote, so these cases pin the
  // band the rescue must not be able to talk its way through.
  describe('the fusion rescue is subordinate to the ceiling', () => {
    for (const stableCount of [2, 3]) {
      it(`rejects the old inline-gate band on ${stableCount} fused frames`, () => {
        for (const distance of [94, 99, 105, 122]) {
          const withGap = shouldAcceptMatch({ best: card(distance), gap: 20, stableCount })
          expect(withGap.accepted, `distance ${distance} with a wide gap`).toBe(false)
          const withCluster = shouldAcceptMatch({
            best: card(distance), gap: 0, stableCount, sameNameCluster: true,
          })
          expect(withCluster.accepted, `distance ${distance} as a same-name cluster`).toBe(false)
        }
      })
    }

    it('still lets a genuinely clean fused hash through', () => {
      expect(shouldAcceptMatch({ best: card(72), gap: 22, stableCount: 2 }).accepted).toBe(true)
      expect(shouldAcceptMatch({
        best: card(72), gap: 0, stableCount: 2, sameNameCluster: true,
      }).accepted).toBe(true)
    })
  })
})

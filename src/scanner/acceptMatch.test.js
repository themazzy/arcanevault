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
    // 57 / 71 / 72 / 79 / 86 all had gaps well above MATCH_MIN_GAP.
    for (const [distance, gap] of [[57, 46], [71, 31], [72, 22], [79, 29], [86, 16]]) {
      const r = shouldAcceptMatch({ best: card(distance), gap, stableCount: 1 })
      expect(r.accepted, `distance ${distance} gap ${gap} should still accept`).toBe(true)
    }
  })

  it('leaves headroom above the highest observed real hit', () => {
    // 86 was the worst true hit; the ceiling must not sit on top of it, or a
    // slightly harder capture of a real card starts failing.
    const r = shouldAcceptMatch({ best: card(95), gap: 20, stableCount: 2 })
    expect(r.accepted).toBe(true)
  })

  it('still accepts a genuine same-art reprint cluster below the ceiling', () => {
    // Same-art reprints sit at gap ~0 by nature; that branch must survive.
    const r = shouldAcceptMatch({ best: card(70), gap: 0, stableCount: 2, sameNameCluster: true })
    expect(r.accepted).toBe(true)
  })

  it('returns a reason naming the distance and the ceiling', () => {
    const r = shouldAcceptMatch({ best: card(140), gap: 30, stableCount: 3 })
    expect(r.reason).toContain('140')
    expect(r.reason).toContain('100')
  })

  it('handles a missing candidate', () => {
    expect(shouldAcceptMatch({ best: null, gap: 0, stableCount: 0 }).accepted).toBe(false)
  })
})

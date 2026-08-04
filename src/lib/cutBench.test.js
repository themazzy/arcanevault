import { describe, it, expect } from 'vitest'
import { deckCardToCutCandidate, bestBenchCandidate, buildCutBench } from './cutBench'
import { ROLE_LANDS, ROLE_RAMP, ROLE_DRAW } from './buildRoles'
import { scoreCandidate, scoreBonusCeiling, SHIPPED_SIGNALS, buildScoringContext } from './buildAssistExperimental'
import { recRank } from './deckBuildAssistant'

describe('deckCardToCutCandidate', () => {
  it('carries the fields scoreCandidate reads', () => {
    const dc = { id: 'a', name: 'Sol Ring', cmc: 1 }
    const sfCard = { cmc: 1, oracle_text: '{T}: Add {C}{C}.', type_line: 'Artifact' }
    const cand = deckCardToCutCandidate({ dc, sfCard, inclusion: 80, score: 0.4 })
    expect(cand).toMatchObject({ name: 'Sol Ring', cmc: 1, card: dc, sfCard, edhrecInclusion: 80, score: 0.4 })
  })

  it('prefers the Scryfall mana value over the row and defaults the rest', () => {
    const cand = deckCardToCutCandidate({ dc: { name: 'X', cmc: 9 }, sfCard: { cmc: 3 } })
    expect(cand.cmc).toBe(3)
    expect(cand.edhrecInclusion).toBe(0)
    expect(cand.score).toBe(0)
  })
})

describe('bestBenchCandidate', () => {
  // base = the cheap term; rank = base + a bonus bounded by `ceiling`.
  const pool = [
    { name: 'Weak', base: 10, bonus: 0 },
    { name: 'Mid', base: 40, bonus: 5 },
    { name: 'Strong', base: 70, bonus: 2 },
    { name: 'Played', base: 95, bonus: 0, inDeck: true },
  ]
  const baseOf = c => c.base
  const rankOf = c => c.base + c.bonus

  it('returns the strongest candidate that is not in the deck', () => {
    const best = bestBenchCandidate({ pool, rankOf, baseOf, ceiling: 10 })
    expect(best).toEqual({ name: 'Strong', strength: 72 })
  })

  it('gives the same answer with and without the early exit', () => {
    const withExit = bestBenchCandidate({ pool, rankOf, baseOf, ceiling: 10 })
    const exhaustive = bestBenchCandidate({ pool, rankOf, baseOf, ceiling: Infinity })
    expect(withExit).toEqual(exhaustive)
  })

  it('actually stops early instead of scoring the whole pool', () => {
    // 5,000 candidates, all weaker than the first. With a ceiling of 10 the walk
    // must stop almost immediately — this is the whole point of the module.
    const big = [{ name: 'Best', base: 100, bonus: 0 }].concat(
      Array.from({ length: 5000 }, (_, i) => ({ name: `C${i}`, base: 50 - (i % 40), bonus: 0 })),
    )
    let scored = 0
    bestBenchCandidate({ pool: big, rankOf: c => { scored++; return c.base }, baseOf, ceiling: 10 })
    expect(scored).toBe(1)
  })

  it('skips excluded candidates before scoring them', () => {
    const scoredNames = []
    const best = bestBenchCandidate({
      pool, baseOf, ceiling: 10,
      rankOf: c => { scoredNames.push(c.name); return c.base + c.bonus },
      isExcluded: c => c.name === 'Strong',
    })
    expect(best.name).toBe('Mid')
    expect(scoredNames).not.toContain('Strong')
  })

  it('does not reorder the caller pool', () => {
    const original = [...pool]
    bestBenchCandidate({ pool, rankOf, baseOf, ceiling: 10 })
    expect(pool).toEqual(original)
  })

  it('returns null for an empty or fully excluded pool', () => {
    expect(bestBenchCandidate({ pool: [], rankOf, baseOf })).toBeNull()
    expect(bestBenchCandidate({ pool, rankOf, baseOf, ceiling: 10, isExcluded: () => true })).toBeNull()
  })
})

describe('buildCutBench', () => {
  const roles = [
    {
      role: ROLE_RAMP,
      ownedCandidates: [{ name: 'Owned rock', base: 30 }],
      edhrecUpgrades: [{ name: 'Better rock', base: 80 }],
      recommenderUpgrades: [{ name: 'Odd rock', base: 50 }],
    },
    { role: ROLE_DRAW, ownedCandidates: [{ name: 'Owned draw', base: 20 }], edhrecUpgrades: [] },
    { role: ROLE_LANDS, ownedCandidates: [{ name: 'Command Tower', base: 99 }] },
  ]
  const baseOf = c => c.base
  const rankOf = c => c.base

  it('draws only on owned cards for the binder path', () => {
    const bench = buildCutBench({ roles, source: 'owned', rankOf, baseOf, ceiling: 0 })
    expect(bench.get(ROLE_RAMP).name).toBe('Owned rock')
  })

  it('merges upgrades and recommender picks for the ownership-blind path', () => {
    const bench = buildCutBench({ roles, source: 'recommended', rankOf, baseOf, ceiling: 0 })
    expect(bench.get(ROLE_RAMP).name).toBe('Better rock')
  })

  it('never benches lands', () => {
    const bench = buildCutBench({ roles, source: 'recommended', rankOf, baseOf, ceiling: 0 })
    expect(bench.has(ROLE_LANDS)).toBe(false)
  })

  it('passes the role to the exclude gate', () => {
    const seen = []
    buildCutBench({
      roles, source: 'owned', rankOf, baseOf, ceiling: 0,
      isExcluded: (cand, role) => { seen.push(role); return false },
    })
    expect(seen).toContain(ROLE_RAMP)
    expect(seen).toContain(ROLE_DRAW)
    expect(seen).not.toContain(ROLE_LANDS)
  })
})

describe('scoreBonusCeiling', () => {
  // The early exit is only correct while this bound holds. If a new bonus term
  // is added to scoreCandidate without extending the ceiling, this fails.
  it('bounds what scoreCandidate can add to recRank', () => {
    const ctx = buildScoringContext({
      commanderOracle: 'Whenever a creature you control dies, each opponent loses 1 life. '
        + 'Sacrifice a creature: draw a card. Put a +1/+1 counter on target creature.',
      commanderType: 'Legendary Creature — Human Warlock',
      commanderCmc: 4,
      deckTexts: Array.from({ length: 30 }, () => ({
        oracle: 'sacrifice a creature: draw a card. whenever a creature dies, create a treasure token.',
        type: 'Enchantment',
      })),
    })
    const ceiling = scoreBonusCeiling(SHIPPED_SIGNALS)
    const cands = [
      { name: 'Plain', oracle: 'Destroy target creature.', type: 'Instant', edhrecInclusion: 40 },
      { name: 'Everything', edhrecInclusion: 20, score: 0.9, type: 'Legendary Creature — Human Cleric',
        oracle: 'Sacrifice a creature: draw a card and put a +1/+1 counter on target creature. '
          + '{T}: Add one mana of any color. Whenever a creature you control dies, create a Treasure token.' },
      { name: 'Looter', oracle: 'Draw a card, then discard a card.', type: 'Instant', edhrecInclusion: 55 },
      { name: 'Blank', oracle: '', type: 'Artifact' },
    ]
    for (const c of cands) {
      const { rank } = scoreCandidate(c, ctx, SHIPPED_SIGNALS)
      expect(rank - recRank(c)).toBeLessThanOrEqual(ceiling)
    }
  })

  it('is zero when every scoring signal is off', () => {
    expect(scoreBonusCeiling({ multiRole: false, commanderKw: false, deckAffinity: false })).toBe(0)
  })
})

import { describe, it, expect } from 'vitest'
import {
  EXPERIMENTAL_DEFAULTS,
  SHIPPED_SIGNALS,
  buildScoringContext,
  scoreCandidate,
  makeExperimentalComparator,
  makeExperimentalComparatorFor,
  makeExperimentalExclude,
  synergyBonus,
  countTopEnd,
  isWeakExpensiveDraw,
  classifyComboOutcome,
  preferResourceCombos,
  adjustTargetForCommander,
  candidateOracle,
  candidateType,
} from './buildAssistExperimental'
import { planAutoFill, rankOverallRecommendations, recRank, ROLE_RAMP, ROLE_DRAW, ROLE_LANDS } from './deckBuildAssistant'

const cfg = EXPERIMENTAL_DEFAULTS

// Korvold — enters / attacks / sacrifice / +1/+1 counters / draw.
const KORVOLD = {
  oracle: 'Flying\nWhenever Korvold enters or attacks, sacrifice another permanent.\nWhenever you sacrifice a permanent, put a +1/+1 counter on Korvold and draw a card.',
  type: 'Legendary Creature — Dragon Noble',
}

// Unowned-suggestion shape: name/cmc/type/oracle/edhrecInclusion, no sfCard.
const up = (name, { cmc = 2, type = 'Artifact', oracle = '', inclusion = 0, score = 0 } = {}) =>
  ({ name, cmc, type, oracle, edhrecInclusion: inclusion, score })

describe('candidate text access', () => {
  it('reads an owned candidate through its Scryfall entry', () => {
    const cand = { name: 'Sol Ring', sfCard: { oracle_text: '{T}: Add {C}{C}.', type_line: 'Artifact' } }
    expect(candidateOracle(cand)).toContain('add {c}{c}')
    expect(candidateType(cand)).toBe('artifact')
  })

  it('reads an unowned suggestion through its attached oracle field', () => {
    const cand = up('Skullclamp', { oracle: 'Whenever equipped creature dies, draw two cards.' })
    expect(candidateOracle(cand)).toContain('draw two cards')
  })

  it('degrades to empty text for a suggestion past the metadata batch', () => {
    expect(candidateOracle(up('Mystery Card'))).toBe('')
  })
})

describe('scoreCandidate', () => {
  const ctx = buildScoringContext({ commanderOracle: KORVOLD.oracle, commanderType: KORVOLD.type })

  it('never scores below the shipped base rank when signals are off', () => {
    const off = { ...cfg, multiRole: false, commanderKw: false, deckAffinity: false, drawQuality: false }
    const cand = up('Sol Ring', { inclusion: 63, oracle: '{T}: Add {C}{C}.' })
    expect(scoreCandidate(cand, ctx, off).rank).toBe(recRank(cand))
  })

  it('rewards a card that does two jobs off one slot', () => {
    const solemn = up('Solemn Simulacrum', {
      inclusion: 20, cmc: 4, type: 'Artifact Creature — Golem',
      oracle: 'When this creature enters, you may search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.\nWhen this creature dies, you may draw a card.',
    })
    const signet = up('Arcane Signet', {
      inclusion: 20, cmc: 2, oracle: "{T}: Add one mana of any color in your commander's color identity.",
    })
    expect(scoreCandidate(solemn, ctx, cfg).parts.multiRole)
      .toBeGreaterThan(scoreCandidate(signet, ctx, cfg).parts.multiRole)
  })

  it('rewards overlap with the commander hooks and explains why', () => {
    const clamp = up('Skullclamp', {
      inclusion: 10, type: 'Artifact — Equipment',
      oracle: 'Equipped creature gets +1/-1.\nWhenever equipped creature dies, draw two cards.\nEquip {1}',
    })
    const res = scoreCandidate(clamp, ctx, cfg)
    expect(res.parts.keyword).toBeGreaterThan(0)
    expect(res.labels).toContain('sacrifice')
  })

  it('caps the keyword bonus so overlap cannot dominate popularity', () => {
    const everything = up('Kitchen Sink', {
      inclusion: 0,
      oracle: 'When this enters or attacks, sacrifice a permanent, put a +1/+1 counter on it, draw a card, gain 1 life, create a token, return a card from your graveyard, it has flying and trample, and it deals combat damage.',
    })
    expect(scoreCandidate(everything, ctx, cfg).parts.keyword).toBeLessThanOrEqual(cfg.commanderKwMax)
  })

  it('demotes a looting spell that pretends to be card advantage', () => {
    const loot = up('Faithless Looting', { oracle: 'Draw two cards, then discard two cards.', type: 'Sorcery' })
    expect(scoreCandidate(loot, ctx, cfg).parts.drawPenalty).toBeLessThan(0)
  })

  it('does not demote real card advantage', () => {
    const div = up('Divination', { oracle: 'Draw two cards.', type: 'Sorcery' })
    expect(scoreCandidate(div, ctx, cfg).parts.drawPenalty).toBe(0)
  })

  it('scores zero bonuses for a commander with no keywords', () => {
    const blank = buildScoringContext({})
    const cand = up('Skullclamp', { oracle: 'Whenever equipped creature dies, draw two cards.' })
    expect(scoreCandidate(cand, blank, cfg).parts.keyword).toBe(0)
  })
})

// The guarantee the whole design rests on: with no comparator injected, the
// shipped ranking is bit-for-bit what it was.
describe('shipped path is unchanged', () => {
  const owned = [up('A', { inclusion: 50 }), up('B', { inclusion: 90 }), up('C', { inclusion: 70 })]

  it('rankOverallRecommendations ignores an absent comparator', () => {
    const before = rankOverallRecommendations({ ownedCandidates: owned }).map(e => e.cand.name)
    expect(before).toEqual(['B', 'C', 'A'])
  })

  it('planAutoFill picks identically with no comparator and no exclude', () => {
    const roles = [
      { role: ROLE_RAMP, target: 2, ownedCandidates: [up('Sol Ring', { inclusion: 60 }), up('Signet', { inclusion: 40 })] },
      { role: ROLE_DRAW, target: 1, ownedCandidates: [up('Divination', { inclusion: 30 })] },
      { role: ROLE_LANDS, target: 0, ownedCandidates: [] },
    ]
    const base = {
      roles,
      liveCounts: new Map([[ROLE_RAMP, 0], [ROLE_DRAW, 0]]),
      totalCards: 1, deckSize: 100, landsTarget: 0, currentLands: 0,
    }
    expect(planAutoFill(base).map(p => p.cand.name)).toEqual(['Sol Ring', 'Signet', 'Divination'])
  })

  it('a one-argument exclude still works after the signature grew', () => {
    const roles = [
      { role: ROLE_RAMP, target: 2, ownedCandidates: [up('Sol Ring'), up('Signet')] },
      { role: ROLE_LANDS, target: 0, ownedCandidates: [] },
    ]
    const picks = planAutoFill({
      roles,
      liveCounts: new Map([[ROLE_RAMP, 0]]),
      totalCards: 1, deckSize: 100, landsTarget: 0, currentLands: 0,
      exclude: cand => cand.name === 'Sol Ring',
    })
    expect(picks.map(p => p.cand.name)).toEqual(['Signet'])
  })
})

describe('makeExperimentalComparator', () => {
  const ctx = buildScoringContext({ commanderOracle: KORVOLD.oracle, commanderType: KORVOLD.type })

  // Inclusion values here are fixture numbers chosen to sit close together, not
  // real EDHREC figures — the point is that a modest popularity gap can be
  // overturned by a card that does two jobs AND hits two commander hooks, while
  // a large gap (see the next test) cannot.
  const cultivate = up('Cultivate', {
    inclusion: 30, cmc: 3, type: 'Sorcery',
    oracle: 'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.',
  })
  const dispute = up('Deadly Dispute', {
    inclusion: 22, cmc: 2, type: 'Instant',
    oracle: 'As an additional cost to cast this spell, sacrifice an artifact or creature.\nDraw two cards and create a Treasure token.',
  })

  it('can lift an on-theme multi-job card over a more popular off-theme one', () => {
    const cmp = makeExperimentalComparator({ ctx, cfg })
    const sorted = [{ cand: cultivate }, { cand: dispute }].sort(cmp)
    expect(sorted[0].cand.name).toBe('Deadly Dispute')
  })

  it('still puts a clearly stronger card first', () => {
    const staple = up('Sol Ring', { inclusion: 95, cmc: 1, oracle: '{T}: Add {C}{C}.' })
    const fringe = up('Fringe Sac Outlet', { inclusion: 2, cmc: 3, oracle: 'Sacrifice a creature: draw a card.' })
    const cmp = makeExperimentalComparator({ ctx, cfg })
    expect([{ cand: fringe }, { cand: staple }].sort(cmp)[0].cand.name).toBe('Sol Ring')
  })

  it('drops into planAutoFill as a comparator', () => {
    const picks = planAutoFill({
      roles: [{ role: ROLE_RAMP, target: 1, ownedCandidates: [cultivate, dispute] }],
      liveCounts: new Map([[ROLE_RAMP, 0]]),
      totalCards: 1, deckSize: 3, landsTarget: 0, currentLands: 0,
      source: 'recommended',
      comparator: makeExperimentalComparator({ ctx, cfg }),
    })
    expect(picks[0].cand.name).toBe('Deadly Dispute')
  })

  it('leaves the same pair in popularity order without the comparator', () => {
    const picks = planAutoFill({
      roles: [{ role: ROLE_RAMP, target: 1, ownedCandidates: [cultivate, dispute] }],
      liveCounts: new Map([[ROLE_RAMP, 0]]),
      totalCards: 1, deckSize: 3, landsTarget: 0, currentLands: 0,
      source: 'recommended',
    })
    expect(picks[0].cand.name).toBe('Cultivate')
  })
})

describe('#3 top-end cap', () => {
  it('counts expensive nonland cards already in the deck', () => {
    const deck = [
      { name: 'Big', cmc: 7, type_line: 'Creature' },
      { name: 'Bigger', cmc: 8, type_line: 'Creature', qty: 2 },
      { name: 'Small', cmc: 2, type_line: 'Creature' },
      { name: 'Land', cmc: 9, type_line: 'Land' }, // lands never count
      { name: 'Cmdr', cmc: 9, type_line: 'Creature', is_commander: true },
    ]
    expect(countTopEnd(deck, {}, 6)).toBe(3)
  })

  it('stops auto-fill adding more than the cap allows', () => {
    const bombs = Array.from({ length: 8 }, (_, i) => up(`Bomb ${i}`, { cmc: 7, inclusion: 90 - i }))
    const picks = planAutoFill({
      roles: [{ role: ROLE_RAMP, target: 8, ownedCandidates: bombs }],
      liveCounts: new Map([[ROLE_RAMP, 0]]),
      totalCards: 1, deckSize: 100, landsTarget: 0, currentLands: 0,
      exclude: makeExperimentalExclude({ cfg, deckTopEnd: 0 }),
    })
    expect(picks.length).toBe(cfg.topEndMax)
  })

  it('counts what the deck already has against the cap', () => {
    const bombs = Array.from({ length: 8 }, (_, i) => up(`Bomb ${i}`, { cmc: 7 }))
    const picks = planAutoFill({
      roles: [{ role: ROLE_RAMP, target: 8, ownedCandidates: bombs }],
      liveCounts: new Map([[ROLE_RAMP, 0]]),
      totalCards: 1, deckSize: 100, landsTarget: 0, currentLands: 0,
      exclude: makeExperimentalExclude({ cfg, deckTopEnd: 3 }),
    })
    expect(picks.length).toBe(1) // 3 already there + 1 = the cap of 4
  })

  it('leaves cheap cards alone', () => {
    const cheap = Array.from({ length: 8 }, (_, i) => up(`Cheap ${i}`, { cmc: 2 }))
    const picks = planAutoFill({
      roles: [{ role: ROLE_RAMP, target: 8, ownedCandidates: cheap }],
      liveCounts: new Map([[ROLE_RAMP, 0]]),
      totalCards: 1, deckSize: 100, landsTarget: 0, currentLands: 0,
      exclude: makeExperimentalExclude({ cfg, deckTopEnd: 0 }),
    })
    expect(picks.length).toBe(8)
  })
})

describe('#5 draw quota quality + sub-curve', () => {
  const exclude = makeExperimentalExclude({ cfg, drawRole: ROLE_DRAW, drawTarget: 12 })

  it('keeps loot spells out of the draw quota', () => {
    const picks = planAutoFill({
      roles: [{
        role: ROLE_DRAW, target: 2, ownedCandidates: [
          up('Faithless Looting', { cmc: 1, type: 'Sorcery', oracle: 'Draw two cards, then discard two cards.', inclusion: 99 }),
          up('Divination', { cmc: 3, type: 'Sorcery', oracle: 'Draw two cards.', inclusion: 10 }),
        ],
      }],
      liveCounts: new Map([[ROLE_DRAW, 0]]),
      totalCards: 1, deckSize: 4, landsTarget: 0, currentLands: 0,
      exclude,
    })
    expect(picks.map(p => p.cand.name)).toEqual(['Divination'])
  })

  it('identifies an expensive draw slot that does not pay for itself', () => {
    expect(isWeakExpensiveDraw(up('Slow Draw', { cmc: 5, oracle: 'Draw two cards.' }), cfg)).toBe(true)
    expect(isWeakExpensiveDraw(up('Harmonize', { cmc: 4, oracle: 'Draw three cards.' }), cfg)).toBe(false)
    expect(isWeakExpensiveDraw(up('Divination', { cmc: 3, oracle: 'Draw two cards.' }), cfg)).toBe(false)
  })

  // Measured counterproductive on a 36-commander sweep, so it ships off. The
  // mechanic still has to work when switched on in the tuning panel, which is
  // what this covers — hence the explicit drawCurve: true.
  it('is off by default', () => {
    expect(EXPERIMENTAL_DEFAULTS.drawCurve).toBe(false)
  })

  it('caps how many expensive non-burst draw spells the package takes when enabled', () => {
    const slow = Array.from({ length: 6 }, (_, i) =>
      up(`Slow Draw ${i}`, { cmc: 5, type: 'Sorcery', oracle: 'Draw two cards.', inclusion: 50 - i }))
    const picks = planAutoFill({
      roles: [{ role: ROLE_DRAW, target: 6, ownedCandidates: slow }],
      liveCounts: new Map([[ROLE_DRAW, 0]]),
      totalCards: 1, deckSize: 100, landsTarget: 0, currentLands: 0,
      exclude: makeExperimentalExclude({ cfg: { ...cfg, drawCurve: true }, drawRole: ROLE_DRAW, drawTarget: 6 }),
    })
    expect(picks.length).toBe(2) // floor(6 * 1/3)
  })

  it('lets burst draw through regardless of cost', () => {
    const burst = Array.from({ length: 5 }, (_, i) =>
      up(`Big Draw ${i}`, { cmc: 6, type: 'Sorcery', oracle: 'Draw five cards.', inclusion: 50 - i }))
    const picks = planAutoFill({
      roles: [{ role: ROLE_DRAW, target: 5, ownedCandidates: burst }],
      liveCounts: new Map([[ROLE_DRAW, 0]]),
      totalCards: 1, deckSize: 100, landsTarget: 0, currentLands: 0,
      // top-end cap off so this isolates the draw sub-curve
      exclude: makeExperimentalExclude({ cfg: { ...cfg, topEndCap: false }, drawRole: ROLE_DRAW, drawTarget: 5 }),
    })
    expect(picks.length).toBe(5)
  })

  it('only applies the draw rules to the draw role', () => {
    const picks = planAutoFill({
      roles: [{
        role: ROLE_RAMP, target: 1,
        ownedCandidates: [up('Frantic Search', { cmc: 3, type: 'Instant', oracle: 'Draw two cards, then discard two cards. Untap up to three lands.' })],
      }],
      liveCounts: new Map([[ROLE_RAMP, 0]]),
      totalCards: 1, deckSize: 3, landsTarget: 0, currentLands: 0,
      exclude,
    })
    expect(picks.length).toBe(1)
  })
})

describe('#6 combo outcome typing', () => {
  const winCombo = { id: 1, uses: ['A', 'B'], produces: ['Infinite damage', 'Win the game'] }
  const manaCombo = { id: 2, uses: ['C', 'D'], produces: ['Infinite colorless mana'] }
  const tokenCombo = { id: 3, uses: ['E', 'F'], produces: ['Infinite creature tokens'] }

  it('classifies produced features', () => {
    expect(classifyComboOutcome(winCombo.produces)).toBe('win')
    expect(classifyComboOutcome(manaCombo.produces)).toBe('resource')
    expect(classifyComboOutcome(['Each opponent loses the game'])).toBe('win')
    expect(classifyComboOutcome([])).toBe('resource')
  })

  it('floats resource loops above kill loops below bracket 4', () => {
    const out = preferResourceCombos([winCombo, manaCombo, tokenCombo], 3, cfg)
    expect(out.map(c => c.id)).toEqual([2, 3, 1])
  })

  it('leaves a high-power deck the kill', () => {
    const out = preferResourceCombos([winCombo, manaCombo], 4, cfg)
    expect(out.map(c => c.id)).toEqual([1, 2])
  })

  it('is a no-op when the signal is switched off', () => {
    const out = preferResourceCombos([winCombo, manaCombo], 2, { ...cfg, comboType: false })
    expect(out.map(c => c.id)).toEqual([1, 2])
  })

  it('preserves the caller ordering within each group', () => {
    const out = preferResourceCombos([manaCombo, winCombo, tokenCombo], 2, cfg)
    expect(out.map(c => c.id)).toEqual([2, 3, 1])
  })
})

describe('adjustTargetForCommander', () => {
  it('pulls the curve down for an expensive commander', () => {
    expect(adjustTargetForCommander(3.2, 6)).toBeLessThan(3.2)
  })
  it('allows a higher curve behind a cheap commander', () => {
    expect(adjustTargetForCommander(3.2, 1)).toBeGreaterThan(3.2)
  })
  it('leaves a mid-cost commander alone', () => {
    expect(adjustTargetForCommander(3.2, 3)).toBeCloseTo(3.2)
  })
  it('passes through nulls', () => {
    expect(adjustTargetForCommander(null, 4)).toBe(null)
    expect(adjustTargetForCommander(3.2, null)).toBe(3.2)
  })
})

// EDHREC's own synergy figure — how much more often a card appears in THIS
// commander's decks than in all decks of the same colours. Fetched by the app
// since forever and consumed by nothing until now. It is the only theme signal
// that covers archetypes oracle text can't reach (tribal, enchantress,
// spellslinger) and the only one that can say a card is actively off-plan.
describe('EDHREC synergy', () => {
  const ctx = buildScoringContext({ commanderOracle: KORVOLD.oracle, commanderType: KORVOLD.type })
  const withSyn = (name, syn, inclusion = 40) => ({ ...up(name, { inclusion }), edhrecSynergy: syn })

  it('rewards a high-synergy card', () => {
    expect(synergyBonus(withSyn('Captivating Vampire', 0.72), cfg)).toBeGreaterThan(15)
  })

  it('penalises a card played LESS here than in generic decks', () => {
    expect(synergyBonus(withSyn('Off Plan', -0.25), cfg)).toBeLessThan(0)
  })

  it('leaves a colour staple near neutral', () => {
    expect(Math.abs(synergyBonus(withSyn('Sol Ring', 0.04), cfg))).toBeLessThanOrEqual(2)
  })

  it('clamps outliers so one card cannot dominate', () => {
    const huge = synergyBonus(withSyn('Absurd', 5), cfg)
    expect(huge).toBe(Math.round(cfg.synergyCeil * cfg.synergyWeight))
  })

  it('is inert when the signal is off', () => {
    expect(synergyBonus(withSyn('X', 0.7), { ...cfg, edhrecSynergy: false })).toBe(0)
  })

  it('lifts an on-plan card over a more played generic one', () => {
    const staple = withSyn('Generic Staple', 0.02, 55)
    const payoff = withSyn('Tribal Payoff', 0.70, 45)
    const cmp = makeExperimentalComparator({ ctx, cfg })
    expect([{ cand: staple }, { cand: payoff }].sort(cmp)[0].cand.name).toBe('Tribal Payoff')
  })

  // Running both theme signals on the same card would double-count it, and the
  // empirical one is better informed wherever it exists.
  it('suppresses the keyword fallback when synergy data is present', () => {
    const clamp = { ...up('Skullclamp', { oracle: 'Whenever equipped creature dies, draw two cards.' }), edhrecSynergy: 0.5 }
    expect(scoreCandidate(clamp, ctx, cfg).parts.keyword).toBe(0)
    expect(scoreCandidate(clamp, ctx, cfg).parts.synergy).toBeGreaterThan(0)
  })

  it('still uses the keyword fallback when EDHREC has no figure', () => {
    const clamp = up('Skullclamp', { oracle: 'Whenever equipped creature dies, draw two cards.' })
    expect(scoreCandidate(clamp, ctx, cfg).parts.keyword).toBeGreaterThan(0)
  })
})

// SHIPPED_SIGNALS is what every user now gets. Pinning its contents so a future
// tweak to EXPERIMENTAL_DEFAULTS can't silently promote an unmeasured signal.
describe('SHIPPED_SIGNALS', () => {
  it('enables only the three measured structural signals', () => {
    expect(SHIPPED_SIGNALS.topEndCap).toBe(true)
    expect(SHIPPED_SIGNALS.drawQuality).toBe(true)
    expect(SHIPPED_SIGNALS.multiRole).toBe(true)
  })

  it('leaves EDHREC synergy off — it correlates 0.63-0.84 with inclusion', () => {
    expect(SHIPPED_SIGNALS.edhrecSynergy).toBe(false)
  })

  // On the binder path this is the strongest signal there is (no-hook 73.9% ->
  // 64.0%). It looked useless only because it was first measured on the
  // ownership-blind path, where inclusion already separates the candidates.
  it('enables keyword overlap for the binder path', () => {
    expect(SHIPPED_SIGNALS.commanderKw).toBe(true)
  })

  it('leaves the signals that measured negative or unproven off', () => {
    expect(SHIPPED_SIGNALS.drawCurve).toBe(false)   // worsened its own metric
    expect(SHIPPED_SIGNALS.comboType).toBe(false)   // not measured in isolation
  })

  // Promoted once its targets came from EDHREC rather than from me. It also
  // reverses the coverage regression the three ranking signals cause by
  // preferring generically stronger cards over narrow enablers.
  it('includes the engine pass', () => {
    expect(SHIPPED_SIGNALS.enginePass).toBe(true)
    expect(SHIPPED_SIGNALS.engineMaxAdd).toBeGreaterThan(0)
  })

  it('still gates the top end and the draw quota', () => {
    const bombs = Array.from({ length: 8 }, (_, i) => up(`Bomb ${i}`, { cmc: 7, inclusion: 90 - i }))
    const picks = planAutoFill({
      roles: [{ role: ROLE_RAMP, target: 8, ownedCandidates: bombs }],
      liveCounts: new Map([[ROLE_RAMP, 0]]),
      totalCards: 1, deckSize: 100, landsTarget: 0, currentLands: 0,
      exclude: makeExperimentalExclude({ cfg: SHIPPED_SIGNALS, deckTopEnd: 0 }),
    })
    expect(picks.length).toBe(SHIPPED_SIGNALS.topEndMax)
  })

  it('scores with no commander context, since the shipped path has none', () => {
    const cand = up('Solemn Simulacrum', {
      inclusion: 20,
      oracle: 'When this creature enters, you may search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.\nWhen this creature dies, you may draw a card.',
    })
    const res = scoreCandidate(cand, null, SHIPPED_SIGNALS)
    expect(res.parts.multiRole).toBeGreaterThan(0)
    expect(res.parts.keyword).toBe(0)
    expect(res.parts.synergy).toBe(0)
  })
})

// Novelty is wanted — surprise cards are much of why building a deck is fun, and
// the recommender finds genuinely synergistic cards that are just underplayed.
// It has to supplement the strategy rather than replace it: measured, the split
// was bimodal and the mean hid it entirely (median 0%, but Muldrotha 71%,
// Korvold 69%, Hei Bai 61%).
describe('novelty ceiling', () => {
  const novel = name => ({ name, cmc: 2, type: 'Artifact', oracle: '', edhrecInclusion: 0, score: 0.5 })
  const known = (name, inclusion) => up(name, { inclusion })

  it('lets novelty through up to the ceiling', () => {
    const picks = planAutoFill({
      roles: [{ role: ROLE_RAMP, target: 20, ownedCandidates: Array.from({ length: 20 }, (_, i) => novel(`N${i}`)) }],
      liveCounts: new Map([[ROLE_RAMP, 0]]),
      totalCards: 1, deckSize: 100, landsTarget: 0, currentLands: 0,
      exclude: makeExperimentalExclude({ cfg: SHIPPED_SIGNALS, nonlandBudget: 60 }),
    })
    expect(picks.length).toBe(Math.floor(60 * SHIPPED_SIGNALS.noveltyMaxShare))
  })

  it('never blocks cards the crowd does play', () => {
    const picks = planAutoFill({
      roles: [{ role: ROLE_RAMP, target: 30, ownedCandidates: Array.from({ length: 30 }, (_, i) => known(`K${i}`, 50)) }],
      liveCounts: new Map([[ROLE_RAMP, 0]]),
      totalCards: 1, deckSize: 100, landsTarget: 0, currentLands: 0,
      exclude: makeExperimentalExclude({ cfg: SHIPPED_SIGNALS, nonlandBudget: 60 }),
    })
    expect(picks.length).toBe(30)
  })

  // Re-running auto-fill on a part-built deck must not stack a second helping.
  it('counts novelty already in the deck against the ceiling', () => {
    const picks = planAutoFill({
      roles: [{ role: ROLE_RAMP, target: 20, ownedCandidates: Array.from({ length: 20 }, (_, i) => novel(`N${i}`)) }],
      liveCounts: new Map([[ROLE_RAMP, 0]]),
      totalCards: 1, deckSize: 100, landsTarget: 0, currentLands: 0,
      exclude: makeExperimentalExclude({ cfg: SHIPPED_SIGNALS, nonlandBudget: 60, deckNovelty: 8 }),
    })
    expect(picks.length).toBe(Math.floor(60 * SHIPPED_SIGNALS.noveltyMaxShare) - 8)
  })

  it('is inert when switched off', () => {
    const picks = planAutoFill({
      roles: [{ role: ROLE_RAMP, target: 20, ownedCandidates: Array.from({ length: 20 }, (_, i) => novel(`N${i}`)) }],
      liveCounts: new Map([[ROLE_RAMP, 0]]),
      totalCards: 1, deckSize: 100, landsTarget: 0, currentLands: 0,
      exclude: makeExperimentalExclude({ cfg: { ...SHIPPED_SIGNALS, noveltyMaxShare: null }, nonlandBudget: 60 }),
    })
    expect(picks.length).toBe(20)
  })
})

// The cap exists to stop the recommender taking over, and the recommender only
// ever supplies UNOWNED candidates. On the binder path "the crowd never plays
// this" describes most of a real collection, so capping it there made the build
// reject the user's own cards to reach for staples they happen to own.
describe('novelty ceiling exempts owned cards', () => {
  const ownedNovel = name => ({
    name, cmc: 2, edhrecInclusion: 0,
    card: { name }, sfCard: { name, type_line: 'Artifact', oracle_text: '{T}: Add {C}.', cmc: 2 },
  })

  it('does not cap cards from your own collection', () => {
    const picks = planAutoFill({
      roles: [{ role: ROLE_RAMP, target: 20, ownedCandidates: Array.from({ length: 20 }, (_, i) => ownedNovel(`Owned ${i}`)) }],
      liveCounts: new Map([[ROLE_RAMP, 0]]),
      totalCards: 1, deckSize: 100, landsTarget: 0, currentLands: 0,
      exclude: makeExperimentalExclude({ cfg: SHIPPED_SIGNALS, nonlandBudget: 60 }),
    })
    expect(picks.length).toBe(20)
  })

  it('still caps unowned suggestions', () => {
    const picks = planAutoFill({
      roles: [{ role: ROLE_RAMP, target: 20, ownedCandidates: Array.from({ length: 20 }, (_, i) => ({ name: `Sug ${i}`, cmc: 2, type: 'Artifact', oracle: '', edhrecInclusion: 0 })) }],
      liveCounts: new Map([[ROLE_RAMP, 0]]),
      totalCards: 1, deckSize: 100, landsTarget: 0, currentLands: 0,
      exclude: makeExperimentalExclude({ cfg: SHIPPED_SIGNALS, nonlandBudget: 60 }),
    })
    expect(picks.length).toBe(Math.floor(60 * SHIPPED_SIGNALS.noveltyMaxShare))
  })
})

// The caller sorts land candidates by which colours the deck is actually short
// of — the only thing that matters about a land. Re-ranking them by card quality
// threw that away: measured, it cost 0.12 colours per land and raised simulated
// colour screw by ~2 points.
describe('lands keep their fixer-first order', () => {
  const ctx = buildScoringContext({ commanderOracle: KORVOLD.oracle, commanderType: KORVOLD.type })

  it('returns no comparator for the Lands role', () => {
    const forRole = makeExperimentalComparatorFor({ ctx, cfg: SHIPPED_SIGNALS })
    expect(forRole(ROLE_LANDS)).toBeNull()
    expect(typeof forRole(ROLE_RAMP)).toBe('function')
  })

  it('picks lands in the order given, not by rank', () => {
    // A dual the deck needs, deliberately placed ahead of a more "popular" land.
    const dual = { name: 'Dual', cmc: 0, type: 'Land', oracle: '{T}: Add {B} or {G}.', edhrecInclusion: 5 }
    const popular = { name: 'Popular Land', cmc: 0, type: 'Land', oracle: '{T}: Add {C}.', edhrecInclusion: 95 }
    const picks = planAutoFill({
      roles: [{ role: ROLE_LANDS, target: 1, ownedCandidates: [] }],
      landCandidates: [dual, popular],
      liveCounts: new Map([[ROLE_LANDS, 0]]),
      totalCards: 1, deckSize: 100,
      landsTarget: 1, currentLands: 0, nonbasicTarget: 1, currentNonbasicLands: 0,
      comparatorFor: makeExperimentalComparatorFor({ ctx, cfg: SHIPPED_SIGNALS }),
    })
    expect(picks[0].cand.name).toBe('Dual')
  })
})

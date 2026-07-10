import { describe, it, expect } from 'vitest'
import {
  binderPlacedCardIds,
  buildBuyList,
  buyListText,
  tcgplayerMassEntryUrl,
  planAutoFill,
  karstenSourcesNeeded,
  karstenColorRequirements,
  granularToCoarse,
  edhrecHeaderToRole,
  coarseRole,
  analyzeBuildPlan,
  enrichPlanWithEdhrec,
  archetypeAdjustments,
  applyTemplateAdjustments,
  bracketFlagFor,
  producedColors,
  isManaSource,
  countManaSources,
  recommendedBasicCount,
  countColorPips,
  planBasicLands,
  isBasicLandName,
  rankCutCandidates,
  CUT_MODES,
  edhrecInclusionPct,
  attachRecommenderUpgrades,
  selectUpgrades,
  roleOfDeckCard,
  countByRole,
  pickCheapestEnglish,
  COMMANDER_TEMPLATE,
  ROLE_RAMP,
  ROLE_DRAW,
  ROLE_REMOVAL,
  ROLE_WIPE,
  ROLE_PROTECTION,
  ROLE_WINCON,
  ROLE_SYNERGY,
  ROLE_LANDS,
} from './deckBuildAssistant'

// ── Helpers ───────────────────────────────────────────────────────────────────
// Build an owned card row + matching Scryfall entry. Keyed by scryfall_id so
// analyzeBuildPlan's sfMap lookup resolves.
let idCounter = 0
function makeCard(name, { oracle = '', type = '', ci = [], legalities, cmc = 0, mana_cost = '', qty } = {}) {
  const id = `sf-${idCounter++}`
  return {
    row: { scryfall_id: id, name, ...(qty != null ? { qty } : {}) },
    sf: {
      [id]: {
        name,
        oracle_text: oracle,
        type_line: type,
        color_identity: ci,
        cmc,
        mana_cost,
        ...(legalities ? { legalities } : {}),
      },
    },
  }
}

function assemble(cards) {
  const ownedCards = cards.map(c => c.row)
  const sfMap = Object.assign({}, ...cards.map(c => c.sf))
  return { ownedCards, sfMap }
}

function role(plan, name) {
  return plan.roles.find(r => r.role === name)
}

// ── Binder availability ───────────────────────────────────────────────────────
describe('binderPlacedCardIds', () => {
  const folders = [
    { id: 'b1', type: 'binder', description: '' },
    { id: 'b2', type: 'binder', description: '{"isGroup":true}' }, // group container
    { id: 'd1', type: 'deck', description: '' },
    { id: 'l1', type: 'list', description: '' },
  ]

  it('includes cards placed in a real binder', () => {
    const ids = binderPlacedCardIds(folders, [{ folder_id: 'b1', card_id: 'c1', qty: 2 }])
    expect(ids.has('c1')).toBe(true)
  })

  it('excludes cards placed only in decks or lists', () => {
    const ids = binderPlacedCardIds(folders, [
      { folder_id: 'd1', card_id: 'c-deck', qty: 1 },
      { folder_id: 'l1', card_id: 'c-list', qty: 1 },
    ])
    expect(ids.size).toBe(0)
  })

  it('ignores group binder folders and zero-qty placements', () => {
    const ids = binderPlacedCardIds(folders, [
      { folder_id: 'b2', card_id: 'c-group', qty: 1 },
      { folder_id: 'b1', card_id: 'c-zero', qty: 0 },
    ])
    expect(ids.size).toBe(0)
  })

  it('treats a missing qty as placed (legacy rows)', () => {
    const ids = binderPlacedCardIds(folders, [{ folder_id: 'b1', card_id: 'c1' }])
    expect(ids.has('c1')).toBe(true)
  })

  it('handles null/absent inputs', () => {
    expect(binderPlacedCardIds(null, null).size).toBe(0)
    expect(binderPlacedCardIds(folders, null).size).toBe(0)
  })
})

// ── Auto-fill planning ────────────────────────────────────────────────────────
describe('planAutoFill', () => {
  const cand = name => ({ name, sfCard: null })
  const roles = [
    { role: ROLE_RAMP, target: 2, ownedCandidates: [cand('Sol Ring'), cand('Arcane Signet'), cand('Cultivate')] },
    { role: ROLE_DRAW, target: 1, ownedCandidates: [cand('Divination')] },
    { role: ROLE_LANDS, target: 37, ownedCandidates: [] },
  ]
  const counts = entries => new Map(entries)

  it('fills each role gap with top candidates in order', () => {
    const picks = planAutoFill({
      roles,
      liveCounts: counts([[ROLE_RAMP, 0], [ROLE_DRAW, 0]]),
      totalCards: 1, deckSize: 100,
      landsTarget: 0, currentLands: 0,
    })
    expect(picks.map(p => p.cand.name)).toEqual(['Sol Ring', 'Arcane Signet', 'Divination'])
  })

  it('respects the live count (partially filled role)', () => {
    const picks = planAutoFill({
      roles,
      liveCounts: counts([[ROLE_RAMP, 1], [ROLE_DRAW, 1]]),
      totalCards: 3, deckSize: 100,
      landsTarget: 0, currentLands: 0,
    })
    expect(picks.map(p => p.cand.name)).toEqual(['Sol Ring'])
  })

  it('skips excluded candidates (added / budget / bracket)', () => {
    const picks = planAutoFill({
      roles,
      liveCounts: counts([[ROLE_RAMP, 0], [ROLE_DRAW, 0]]),
      totalCards: 1, deckSize: 100,
      landsTarget: 0, currentLands: 0,
      exclude: c => c.name === 'Sol Ring',
    })
    expect(picks.map(p => p.cand.name)).toEqual(['Arcane Signet', 'Cultivate', 'Divination'])
  })

  it('reserves land slots: nonland picks stop at deckSize minus the lands still needed', () => {
    // 3 slots left, 2 reserved for lands → only 1 nonland pick allowed.
    const picks = planAutoFill({
      roles,
      liveCounts: counts([[ROLE_RAMP, 0], [ROLE_DRAW, 0]]),
      totalCards: 97, deckSize: 100,
      landsTarget: 37, currentLands: 35,
    })
    expect(picks.filter(p => p.role !== ROLE_LANDS)).toHaveLength(1)
  })

  it('adds nonbasic lands up to the nonbasic target, never a name twice', () => {
    const picks = planAutoFill({
      roles: [{ role: ROLE_LANDS, target: 37, ownedCandidates: [] }],
      liveCounts: counts([]),
      totalCards: 1, deckSize: 100,
      landsTarget: 37, currentLands: 0,
      nonbasicTarget: 2, currentNonbasicLands: 0,
      landCandidates: [cand('Command Tower'), cand('Command Tower'), cand('Exotic Orchard'), cand('Path of Ancestry')],
    })
    expect(picks.map(p => p.cand.name)).toEqual(['Command Tower', 'Exotic Orchard'])
    expect(picks.every(p => p.role === ROLE_LANDS)).toBe(true)
  })

  it('returns nothing when the deck is already full', () => {
    const picks = planAutoFill({
      roles,
      liveCounts: counts([[ROLE_RAMP, 0]]),
      totalCards: 100, deckSize: 100,
      landsTarget: 37, currentLands: 30,
    })
    expect(picks).toHaveLength(0)
  })
})

// ── Karsten source requirements ───────────────────────────────────────────────
describe('karstenSourcesNeeded', () => {
  it('matches the 2022 99-card table on exact entries', () => {
    expect(karstenSourcesNeeded(1, 1)).toBe(19) // C — Monastery Swiftspear
    expect(karstenSourcesNeeded(1, 2)).toBe(19) // 1C — Ledger Shredder
    expect(karstenSourcesNeeded(2, 2)).toBe(30) // CC — Lord of Atlantis
    expect(karstenSourcesNeeded(2, 4)).toBe(26) // 2CC — Wrath of God
    expect(karstenSourcesNeeded(3, 4)).toBe(33) // 1CCC — Cryptic Command
    expect(karstenSourcesNeeded(4, 4)).toBe(39) // CCCC — Dawn Elemental
  })

  it('clamps mana value into the table range', () => {
    expect(karstenSourcesNeeded(1, 9)).toBe(14)  // beyond 6 → 6-drop requirement
    expect(karstenSourcesNeeded(2, 1)).toBe(30)  // below range → first row
    expect(karstenSourcesNeeded(5, 5)).toBe(36)  // 5+ pips reuse the 4-pip row
  })
})

describe('karstenColorRequirements', () => {
  const card = (name, mana_cost, cmc, type = 'Creature') =>
    ({ name, mana_cost, cmc, type_line: type })

  it('takes the most demanding spell per color and reports it', () => {
    const reqs = karstenColorRequirements([
      card('Divine Smite', '{1}{W}', 2),
      card('Wrath of God', '{2}{W}{W}', 4),
      card('Island', '', 0, 'Basic Land — Island'),
    ], () => null)
    expect(reqs.W).toEqual({ needed: 26, pips: 2, cmc: 4, card: 'Wrath of God' })
    expect(reqs.U).toBeUndefined() // lands never set requirements
  })

  it('ignores hybrid and Phyrexian pips (payable another way)', () => {
    const reqs = karstenColorRequirements([
      card('Kitchen Finks', '{1}{G/W}{G/W}', 3),
      card('Dismember', '{1}{B/P}{B/P}', 3),
    ], () => null)
    expect(reqs).toEqual({})
  })

  it('sets independent requirements per color of a multicolor cost', () => {
    const reqs = karstenColorRequirements([
      card('Narset, Parter of Veils', '{1}{U}{U}', 3),
      card('Lightning Helix', '{R}{W}', 2),
    ], () => null)
    expect(reqs.U.needed).toBe(28) // 1CC row
    expect(reqs.R.needed).toBe(19) // 1C row
    expect(reqs.W.needed).toBe(19)
  })
})

// ── Buy the gap ───────────────────────────────────────────────────────────────
describe('buildBuyList / buyListText / tcgplayerMassEntryUrl', () => {
  const available = new Set(['sol ring'])
  const elsewhere = new Set(['rhystic study'])

  it('splits missing deck cards into to-buy and owned-elsewhere, skipping basics and available cards', () => {
    const { toBuy, elsewhere: inDecks } = buildBuyList([
      { name: 'Sol Ring', qty: 1 },        // available in binders
      { name: 'Rhystic Study', qty: 1 },   // owned, but in another deck
      { name: 'Smothering Tithe', qty: 1 },// not owned
      { name: 'Forest', qty: 12 },         // basic — never listed
    ], available, elsewhere)
    expect(toBuy.map(m => m.name)).toEqual(['Smothering Tithe'])
    expect(inDecks.map(m => m.name)).toEqual(['Rhystic Study'])
  })

  it('merges multiple printings of one name and sums qty', () => {
    const { toBuy } = buildBuyList([
      { name: 'Shock', qty: 2 },
      { name: 'Shock', qty: 1 },
    ], new Set(), new Set())
    expect(toBuy).toEqual([{ name: 'Shock', qty: 3, elsewhere: false }])
  })

  it('matches availability by front face for DFCs', () => {
    const { toBuy } = buildBuyList(
      [{ name: 'Henrika Domnathi // Henrika, Infernal Seer', qty: 1 }],
      new Set(['henrika domnathi']),
      new Set(),
    )
    expect(toBuy).toHaveLength(0)
  })

  it('renders the plain-text list and the mass-entry URL (front faces only)', () => {
    const items = [
      { name: 'Smothering Tithe', qty: 1 },
      { name: 'Henrika Domnathi // Henrika, Infernal Seer', qty: 1 },
    ]
    expect(buyListText(items)).toBe('1 Smothering Tithe\n1 Henrika Domnathi // Henrika, Infernal Seer')
    const url = tcgplayerMassEntryUrl(items)
    expect(url).toContain('tcgplayer.com/massentry?c=')
    expect(decodeURIComponent(url.split('c=')[1])).toBe('1 Smothering Tithe||1 Henrika Domnathi')
    expect(tcgplayerMassEntryUrl([])).toBeNull()
  })
})

// ── Granular → coarse mapping ─────────────────────────────────────────────────
describe('granularToCoarse', () => {
  it('maps functional categories to their coarse role', () => {
    expect(granularToCoarse('Ramp')).toBe(ROLE_RAMP)
    expect(granularToCoarse('Cost Reduction')).toBe(ROLE_RAMP)
    expect(granularToCoarse('Card Draw')).toBe(ROLE_DRAW)
    expect(granularToCoarse('Tutor')).toBe(ROLE_DRAW)
    expect(granularToCoarse('Removal')).toBe(ROLE_REMOVAL)
    expect(granularToCoarse('Counterspell')).toBe(ROLE_REMOVAL)
    expect(granularToCoarse('Burn')).toBe(ROLE_REMOVAL)
    expect(granularToCoarse('Board Wipe')).toBe(ROLE_WIPE)
    expect(granularToCoarse('Protection')).toBe(ROLE_PROTECTION)
    expect(granularToCoarse('Combo')).toBe(ROLE_WINCON)
    expect(granularToCoarse('Extra Turns')).toBe(ROLE_WINCON)
    expect(granularToCoarse('Land')).toBe(ROLE_LANDS)
  })

  it('falls through unmapped categories to Synergy', () => {
    expect(granularToCoarse('Tokens')).toBe(ROLE_SYNERGY)
    expect(granularToCoarse('Creature')).toBe(ROLE_SYNERGY)
    expect(granularToCoarse('Graveyard')).toBe(ROLE_SYNERGY)
    expect(granularToCoarse('Other')).toBe(ROLE_SYNERGY)
    expect(granularToCoarse('anything-unknown')).toBe(ROLE_SYNERGY)
  })
})

// ── EDHREC section header → coarse role ───────────────────────────────────────
describe('edhrecHeaderToRole', () => {
  it('maps functional EDHREC section headers to coarse roles', () => {
    expect(edhrecHeaderToRole('Mana Artifacts')).toBe(ROLE_RAMP)
    expect(edhrecHeaderToRole('Ramp')).toBe(ROLE_RAMP)
    expect(edhrecHeaderToRole('Card Draw')).toBe(ROLE_DRAW)
    expect(edhrecHeaderToRole('Card Advantage')).toBe(ROLE_DRAW)
    expect(edhrecHeaderToRole('Lands')).toBe(ROLE_LANDS)
    expect(edhrecHeaderToRole('Board Wipes')).toBe(ROLE_WIPE)
    expect(edhrecHeaderToRole('Protection')).toBe(ROLE_PROTECTION)
    expect(edhrecHeaderToRole('Removal')).toBe(ROLE_REMOVAL)
    expect(edhrecHeaderToRole('Counterspells')).toBe(ROLE_REMOVAL)
  })

  it('returns null for type-based headers (caller falls back to type line)', () => {
    expect(edhrecHeaderToRole('Creatures')).toBeNull()
    expect(edhrecHeaderToRole('Instants')).toBeNull()
    expect(edhrecHeaderToRole('')).toBeNull()
  })
})

describe('coarseRole', () => {
  it('classifies a card via its oracle text', () => {
    const role = coarseRole(
      { name: 'Sol Ring' },
      { oracle_text: '{T}: Add {C}{C}.', type_line: 'Artifact' },
    )
    expect(role).toBe(ROLE_RAMP)
  })
})

// ── analyzeBuildPlan ──────────────────────────────────────────────────────────
describe('analyzeBuildPlan', () => {
  it('buckets owned cards into coarse roles', () => {
    const cards = [
      makeCard('Cultivate', { oracle: 'Search your library for up to two basic land cards.', type: 'Sorcery' }),
      makeCard('Divination', { oracle: 'Draw two cards.', type: 'Sorcery' }),
      makeCard('Murder', { oracle: 'Destroy target creature.', type: 'Instant' }),
      makeCard('Wrath of God', { oracle: 'Destroy all creatures.', type: 'Sorcery' }),
      makeCard('Forest', { oracle: '', type: 'Basic Land — Forest' }),
    ]
    const { ownedCards, sfMap } = assemble(cards)
    const plan = analyzeBuildPlan({ commander: { name: 'Cmd', color_identity: [] }, ownedCards, sfMap })

    expect(role(plan, ROLE_RAMP).ownedCandidates.map(c => c.name)).toContain('Cultivate')
    expect(role(plan, ROLE_DRAW).ownedCandidates.map(c => c.name)).toContain('Divination')
    expect(role(plan, ROLE_REMOVAL).ownedCandidates.map(c => c.name)).toContain('Murder')
    expect(role(plan, ROLE_WIPE).ownedCandidates.map(c => c.name)).toContain('Wrath of God')
    expect(role(plan, ROLE_LANDS).ownedCandidates.map(c => c.name)).toContain('Forest')
    expect(plan.totalOwnedLegal).toBe(5)
  })

  it('excludes cards outside the commander color identity', () => {
    const cards = [
      makeCard('Lightning Bolt', { oracle: 'Deals 3 damage to any target.', type: 'Instant', ci: ['R'] }),
      makeCard('Counterspell', { oracle: 'Counter target spell.', type: 'Instant', ci: ['U'] }),
    ]
    const { ownedCards, sfMap } = assemble(cards)
    // Mono-blue commander: red card must be filtered out.
    const plan = analyzeBuildPlan({ commander: { name: 'Cmd', color_identity: ['U'] }, ownedCards, sfMap })

    expect(plan.totalOwnedLegal).toBe(1)
    const removal = role(plan, ROLE_REMOVAL).ownedCandidates.map(c => c.name)
    expect(removal).toContain('Counterspell')
    expect(removal).not.toContain('Lightning Bolt')
  })

  it('excludes cards banned in commander', () => {
    const cards = [
      makeCard('Channel', { oracle: 'Draw a card.', type: 'Sorcery', ci: [], legalities: { commander: 'banned' } }),
      makeCard('Brainstorm', { oracle: 'Draw three cards.', type: 'Instant', ci: ['U'], legalities: { commander: 'legal' } }),
    ]
    const { ownedCards, sfMap } = assemble(cards)
    const plan = analyzeBuildPlan({ commander: { name: 'Cmd', color_identity: ['U'] }, ownedCards, sfMap })

    const draw = role(plan, ROLE_DRAW).ownedCandidates.map(c => c.name)
    expect(draw).toContain('Brainstorm')
    expect(draw).not.toContain('Channel')
  })

  it('excludes tokens/emblems even when legality metadata is missing', () => {
    const cards = [
      // Owned token row with NO legalities — the offline-first "default legal"
      // fallback must not let it through as a candidate.
      makeCard('Wizard', { oracle: 'Whenever you cast a noncreature spell, this token deals 1 damage to each opponent.', type: 'Token Creature — Wizard' }),
      makeCard('Monarch Emblem', { oracle: 'At the beginning of your end step, draw a card.', type: 'Emblem' }),
      makeCard('Murder', { oracle: 'Destroy target creature.', type: 'Instant', ci: ['B'] }),
    ]
    const { ownedCards, sfMap } = assemble(cards)
    const plan = analyzeBuildPlan({ commander: { name: 'Cmd', color_identity: ['B'] }, ownedCards, sfMap })

    expect(plan.totalOwnedLegal).toBe(1)
    const all = plan.roles.flatMap(r => r.ownedCandidates.map(c => c.name))
    expect(all).toContain('Murder')
    expect(all).not.toContain('Wizard')
    expect(all).not.toContain('Monarch Emblem')
  })

  it('de-dupes owned copies by name (singleton)', () => {
    const a = makeCard('Sol Ring', { oracle: '{T}: Add {C}{C}.', type: 'Artifact' })
    // Second physical copy, different scryfall_id (different printing).
    const b = makeCard('Sol Ring', { oracle: '{T}: Add {C}{C}.', type: 'Artifact' })
    const { ownedCards, sfMap } = assemble([a, b])
    const plan = analyzeBuildPlan({ commander: { name: 'Cmd', color_identity: [] }, ownedCards, sfMap })

    expect(role(plan, ROLE_RAMP).ownedCandidates.filter(c => c.name === 'Sol Ring')).toHaveLength(1)
    expect(plan.totalOwnedLegal).toBe(1)
  })

  it('computes gaps from current deck contents', () => {
    const cards = [
      makeCard('Cultivate', { oracle: 'Search your library for up to two basic land cards.', type: 'Sorcery' }),
      makeCard('Kodama\'s Reach', { oracle: 'Search your library for up to two basic land cards.', type: 'Sorcery' }),
    ]
    const { ownedCards, sfMap } = assemble(cards)
    const plan = analyzeBuildPlan({
      commander: { name: 'Cmd', color_identity: [] },
      ownedCards,
      sfMap,
      currentDeckCards: [{ name: 'Cultivate' }],
    })
    const ramp = role(plan, ROLE_RAMP)
    expect(ramp.target).toBe(COMMANDER_TEMPLATE[ROLE_RAMP].ideal)
    expect(ramp.current).toBe(1)
    expect(ramp.gap).toBe(ramp.target - 1)
    // Cultivate is marked as already in the deck.
    expect(ramp.ownedCandidates.find(c => c.name === 'Cultivate').inDeck).toBe(true)
  })

  it('gives Synergy a remainder target that balances the deck', () => {
    const plan = analyzeBuildPlan({ commander: { name: 'Cmd', color_identity: [] } })
    const fixedIdeal = [ROLE_LANDS, ROLE_RAMP, ROLE_DRAW, ROLE_REMOVAL, ROLE_WIPE, ROLE_PROTECTION, ROLE_WINCON]
      .reduce((sum, r) => sum + COMMANDER_TEMPLATE[r].ideal, 0)
    // 99 nonland-commander slots minus the fixed ideals.
    expect(role(plan, ROLE_SYNERGY).target).toBe(99 - fixedIdeal)
  })
})

// ── Archetype-aware quotas ────────────────────────────────────────────────────
describe('archetypeAdjustments', () => {
  it('returns {} for balanced / unknown / empty themes', () => {
    expect(archetypeAdjustments('')).toEqual({})
    expect(archetypeAdjustments('group-hug')).toEqual({})
  })

  it('matches known archetypes by slug', () => {
    expect(archetypeAdjustments('plus-1-plus-1-counters')[ROLE_DRAW]).toBe(1)
    expect(archetypeAdjustments('plus-1-plus-1-counters')[ROLE_WIPE]).toBe(-1)
    expect(archetypeAdjustments('spellslinger')[ROLE_DRAW]).toBe(2)
    expect(archetypeAdjustments('voltron')[ROLE_PROTECTION]).toBe(3)
    expect(archetypeAdjustments('lands-matter')[ROLE_LANDS]).toBe(2)
  })
})

describe('applyTemplateAdjustments', () => {
  it('returns the same template when there are no deltas', () => {
    expect(applyTemplateAdjustments(COMMANDER_TEMPLATE, {})).toBe(COMMANDER_TEMPLATE)
  })

  it('adjusts fixed-role ideals and leaves Synergy as remainder', () => {
    const out = applyTemplateAdjustments(COMMANDER_TEMPLATE, { [ROLE_PROTECTION]: 3, [ROLE_WIPE]: -2 })
    expect(out[ROLE_PROTECTION].ideal).toBe(COMMANDER_TEMPLATE[ROLE_PROTECTION].ideal + 3)
    expect(out[ROLE_WIPE].ideal).toBe(COMMANDER_TEMPLATE[ROLE_WIPE].ideal - 2)
    expect(out[ROLE_SYNERGY]).toBe('remainder')
    // untouched roles unchanged
    expect(out[ROLE_RAMP].ideal).toBe(COMMANDER_TEMPLATE[ROLE_RAMP].ideal)
  })

  it('clamps counts at 0 and keeps min <= ideal', () => {
    const out = applyTemplateAdjustments(COMMANDER_TEMPLATE, { [ROLE_WIPE]: -10 })
    expect(out[ROLE_WIPE].ideal).toBe(0)
    expect(out[ROLE_WIPE].min).toBe(0)
  })

  it('recomputes min when a delta drops ideal below the original min', () => {
    // Removal starts min 8 / ideal 10; -9 pushes ideal to 1, so min must drop
    // to keep min <= ideal rather than staying at the original 8.
    const out = applyTemplateAdjustments(COMMANDER_TEMPLATE, { [ROLE_REMOVAL]: -9 })
    expect(out[ROLE_REMOVAL].ideal).toBe(1)
    expect(out[ROLE_REMOVAL].min).toBe(0)
    expect(out[ROLE_REMOVAL].min).toBeLessThanOrEqual(out[ROLE_REMOVAL].ideal)
  })

  it('flexes the Synergy remainder when fixed roles change', () => {
    // Removing 2 board-wipe slots should free 2 slots for Synergy.
    const base = analyzeBuildPlan({ commander: { name: 'C', color_identity: [] } })
    const baseSyn = base.roles.find(r => r.role === ROLE_SYNERGY).target
    const flexed = analyzeBuildPlan({
      commander: { name: 'C', color_identity: [] },
      template: applyTemplateAdjustments(COMMANDER_TEMPLATE, { [ROLE_WIPE]: -2 }),
    })
    expect(flexed.roles.find(r => r.role === ROLE_SYNERGY).target).toBe(baseSyn + 2)
  })
})

// ── bracketFlagFor ────────────────────────────────────────────────────────────
describe('bracketFlagFor', () => {
  const gc = new Set(['rhystic study', 'tergrid, god of fright'])

  it('flags Game Changers by name (incl. MDFC front face)', () => {
    expect(bracketFlagFor('Rhystic Study', null, gc)).toEqual({ label: 'Game Changer', level: 3 })
    // MDFC full name resolves via the front face stored in the set.
    expect(bracketFlagFor('Tergrid, God of Fright // Tergrid\'s Lantern', null, gc))
      .toEqual({ label: 'Game Changer', level: 3 })
  })

  it('flags mass land denial and extra turns from oracle text', () => {
    expect(bracketFlagFor('Armageddon', { oracle_text: 'Destroy all lands.' }, gc))
      .toEqual({ label: 'Land denial', level: 4 })
    expect(bracketFlagFor('Time Warp', { oracle_text: 'Target player takes an extra turn after this one.' }, gc))
      .toEqual({ label: 'Extra turn', level: 2 })
  })

  it('returns null for ordinary cards and tolerates a missing GC set', () => {
    expect(bracketFlagFor('Llanowar Elves', { oracle_text: '{T}: Add {G}.' }, gc)).toBeNull()
    expect(bracketFlagFor('Rhystic Study', null, null)).toBeNull()
  })
})

// ── Mana base ─────────────────────────────────────────────────────────────────
describe('producedColors', () => {
  it('reads basic land subtypes', () => {
    expect([...producedColors('', 'Basic Land — Forest')]).toEqual(['G'])
    expect([...producedColors('', 'Land — Plains Island')].sort()).toEqual(['U', 'W'])
  })

  it('reads "add" clauses including any-color and hybrids', () => {
    expect([...producedColors('{T}: Add one mana of any color.', 'Land')].sort())
      .toEqual(['B', 'G', 'R', 'U', 'W'])
    expect([...producedColors('{T}: Add {G} or {U}.', 'Land')].sort()).toEqual(['G', 'U'])
    expect([...producedColors('{T}: Add {W/U}.', 'Land')].sort()).toEqual(['U', 'W'])
  })

  it('ignores colorless-only producers', () => {
    expect([...producedColors('{T}: Add {C}{C}.', 'Artifact')]).toEqual([])
  })
})

describe('isManaSource', () => {
  it('treats any land as a source', () => {
    expect(isManaSource('', 'Basic Land — Island')).toBe(true)
  })
  it('treats tap-for-mana permanents as sources but not rituals', () => {
    expect(isManaSource('{T}: Add {G}.', 'Creature — Elf Druid')).toBe(true)
    expect(isManaSource('Add {B}{B}{B}.', 'Instant')).toBe(false) // Dark Ritual: no {T}
  })
})

describe('countManaSources', () => {
  it('counts colored sources and lands across the deck', () => {
    const cards = [
      { scryfall_id: 'a', qty: 1 },
      { scryfall_id: 'b', qty: 1 },
      { scryfall_id: 'c', qty: 1 },
    ]
    const sfMap = {
      a: { type_line: 'Basic Land — Forest', oracle_text: '' },
      b: { type_line: 'Land', oracle_text: '{T}: Add one mana of any color.' },
      c: { type_line: 'Creature — Elf Druid', oracle_text: '{T}: Add {G}.' },
    }
    const out = countManaSources(cards, sfMap)
    expect(out.lands).toBe(2)          // Forest + the any-color land
    expect(out.G).toBe(3)              // forest, any-color land, elf
    expect(out.W).toBe(1)              // any-color land only
  })
})

// ── Basic land split ──────────────────────────────────────────────────────────
describe('recommendedBasicCount', () => {
  it('drops as the color count rises', () => {
    expect(recommendedBasicCount(0)).toBe(0)
    expect(recommendedBasicCount(1)).toBe(28)
    expect(recommendedBasicCount(2)).toBe(13)
    expect(recommendedBasicCount(3)).toBe(9)
    expect(recommendedBasicCount(4)).toBe(5)
    expect(recommendedBasicCount(5)).toBe(3)
  })
})

describe('countColorPips', () => {
  it('counts colored mana symbols across nonland cards, skipping lands', () => {
    const { ownedCards, sfMap } = assemble([
      makeCard('Spell A', { type: 'Sorcery', mana_cost: '{2}{G}{G}' }),
      makeCard('Spell B', { type: 'Instant', mana_cost: '{W}{U}' }),
      makeCard('A Land', { type: 'Land', mana_cost: '' }),
    ])
    expect(countColorPips(ownedCards, sfMap)).toEqual({ W: 1, U: 1, B: 0, R: 0, G: 2 })
  })

  it('counts a hybrid pip toward both halves', () => {
    const { ownedCards, sfMap } = assemble([
      makeCard('Hybrid', { type: 'Creature', mana_cost: '{W/U}' }),
    ])
    expect(countColorPips(ownedCards, sfMap)).toMatchObject({ W: 1, U: 1 })
  })
})

describe('planBasicLands', () => {
  it('fills the whole land target for a mono-color deck', () => {
    const { ownedCards, sfMap } = assemble([makeCard('Bear', { type: 'Creature', mana_cost: '{1}{G}' })])
    const { counts, total } = planBasicLands({ deckCards: ownedCards, sfMap, colors: ['G'], landTarget: 37 })
    expect(total).toBe(37)
    expect(counts).toEqual({ Forest: 37 })
  })

  it('splits basics by pip demand and sums to exactly the needed count', () => {
    const { ownedCards, sfMap } = assemble([
      makeCard('W heavy', { type: 'Creature', mana_cost: '{W}{W}{W}{W}{W}{W}{W}' }),
      makeCard('U light', { type: 'Instant', mana_cost: '{U}{U}{U}' }),
    ])
    const { counts, total } = planBasicLands({ deckCards: ownedCards, sfMap, colors: ['W', 'U'], landTarget: 10 })
    expect(total).toBe(10)
    expect(counts).toEqual({ Plains: 7, Island: 3 })
  })

  it('subtracts lands already in the deck (additive top-up)', () => {
    const cards = [
      makeCard('Forest pip', { type: 'Sorcery', mana_cost: '{G}' }),
      makeCard('Dual', { type: 'Land', qty: 30 }),
    ]
    const { ownedCards, sfMap } = assemble(cards)
    const { total } = planBasicLands({ deckCards: ownedCards, sfMap, colors: ['G'], landTarget: 37 })
    expect(total).toBe(7) // 37 - 30 nonbasic lands
  })

  it('even-splits when there is no pip data', () => {
    const { ownedCards, sfMap } = assemble([makeCard('Colorless', { type: 'Artifact', mana_cost: '{4}' })])
    const { counts } = planBasicLands({ deckCards: ownedCards, sfMap, colors: ['W', 'B'], landTarget: 4 })
    expect(counts).toEqual({ Plains: 2, Swamp: 2 })
  })

  it('returns nothing for a colorless identity or a met target', () => {
    const { ownedCards, sfMap } = assemble([makeCard('X', { type: 'Land', qty: 40 })])
    expect(planBasicLands({ deckCards: ownedCards, sfMap, colors: [], landTarget: 37 })).toEqual({ counts: {}, total: 0 })
    expect(planBasicLands({ deckCards: ownedCards, sfMap, colors: ['G'], landTarget: 37 })).toEqual({ counts: {}, total: 0 })
  })

  it('closes Karsten shortfalls before pip weighting', () => {
    // W is pip-heavier but already at its source target (20 Plains ≥ the 15
    // that a {4}{W} five-drop wants); U is far below the 30 a {U}{U} two-drop
    // wants. Every added basic must be an Island despite W's pip lead.
    const { ownedCards, sfMap } = assemble([
      makeCard('Angel', { type: 'Creature', mana_cost: '{4}{W}', cmc: 5 }),
      makeCard('Sunblade', { type: 'Creature', mana_cost: '{4}{W}', cmc: 5 }),
      makeCard('Counterspell', { type: 'Instant', mana_cost: '{U}{U}', cmc: 2 }),
      makeCard('Plains', { type: 'Basic Land — Plains', qty: 20 }),
    ])
    const { counts, total } = planBasicLands({ deckCards: ownedCards, sfMap, colors: ['W', 'U'], landTarget: 24 })
    expect(total).toBe(4)
    expect(counts).toEqual({ Island: 4 })
  })

  it('falls back to pip weights once every shortfall is closed', () => {
    // Both colors comfortably above their 1-pip targets → phase 1 adds
    // nothing, so the split follows pip demand (3 W pips vs 1 U pip).
    const { ownedCards, sfMap } = assemble([
      makeCard('W spell', { type: 'Sorcery', mana_cost: '{4}{W}', cmc: 5 }),
      makeCard('W spell 2', { type: 'Sorcery', mana_cost: '{4}{W}', cmc: 5 }),
      makeCard('W spell 3', { type: 'Sorcery', mana_cost: '{4}{W}', cmc: 5 }),
      makeCard('U spell', { type: 'Instant', mana_cost: '{4}{U}', cmc: 5 }),
      makeCard('Plains', { type: 'Basic Land — Plains', qty: 18 }),
      makeCard('Island', { type: 'Basic Land — Island', qty: 18 }),
    ])
    const { counts, total } = planBasicLands({ deckCards: ownedCards, sfMap, colors: ['W', 'U'], landTarget: 40 })
    expect(total).toBe(4)
    expect(counts).toEqual({ Plains: 3, Island: 1 })
  })
})

describe('isBasicLandName', () => {
  it('recognizes the five basics only', () => {
    expect(isBasicLandName('Forest')).toBe(true)
    expect(isBasicLandName('island')).toBe(true)
    expect(isBasicLandName('Reliquary Tower')).toBe(false)
    expect(isBasicLandName('')).toBe(false)
  })
})

// ── EDHREC inclusion percentage ───────────────────────────────────────────────
describe('edhrecInclusionPct', () => {
  it('converts a raw deck count to a percentage using the denominator', () => {
    expect(edhrecInclusionPct({ inclusion: 9000, potentialDecks: 10000 })).toBe(90)
  })
  it('caps at 100', () => {
    expect(edhrecInclusionPct({ inclusion: 11000, potentialDecks: 10000 })).toBe(100)
  })
  it('falls back to the raw value when the denominator is missing', () => {
    expect(edhrecInclusionPct({ inclusion: 42 })).toBe(42)
    expect(edhrecInclusionPct({})).toBe(0)
  })
})

// ── Recommander augmentation ──────────────────────────────────────────────────
describe('attachRecommenderUpgrades', () => {
  const basePlan = () => {
    const { ownedCards, sfMap } = assemble([
      makeCard('Llanowar Elves', { oracle: '{T}: Add {G}.', type: 'Creature — Elf Druid' }),
    ])
    return analyzeBuildPlan({ commander: { name: 'Cmd', color_identity: ['G'] }, ownedCards, sfMap })
  }

  it('classifies a rec by oracle text into a separate recommenderUpgrades list', () => {
    const plan = basePlan()
    const recRows = [
      { name: 'Harmonize', type_line: 'Sorcery', oracle_text: 'Draw three cards.', cmc: 4, image: 'harm.jpg', score: 0.82 },
    ]
    const out = attachRecommenderUpgrades(plan, recRows)
    const draw = role(out, ROLE_DRAW).recommenderUpgrades.find(u => u.name === 'Harmonize')
    expect(draw).toBeTruthy()
    expect(draw.image).toBe('harm.jpg')
    expect(draw.source).toBe('recommander')
    // It does NOT pollute the EDHREC list.
    expect(role(out, ROLE_DRAW).edhrecUpgrades.map(u => u.name)).not.toContain('Harmonize')
  })

  it('skips owned cards and de-dupes itself', () => {
    const plan = basePlan()
    const recRows = [
      { name: 'Llanowar Elves', type_line: 'Creature — Elf Druid', oracle_text: '{T}: Add {G}.', score: 0.9 }, // owned
      { name: 'Beast Whisperer', type_line: 'Creature — Elf', oracle_text: 'Whenever you cast a creature spell, draw a card.', score: 0.7 },
      { name: 'Beast Whisperer', type_line: 'Creature — Elf', oracle_text: 'Whenever you cast a creature spell, draw a card.', score: 0.7 }, // dupe
    ]
    const out = attachRecommenderUpgrades(plan, recRows)
    const names = (role(out, ROLE_DRAW).recommenderUpgrades || []).map(u => u.name)
    expect(names).not.toContain('Llanowar Elves')
    expect(names.filter(n => n === 'Beast Whisperer')).toHaveLength(1)
  })

  it('returns the plan unchanged when there are no rec rows', () => {
    const plan = basePlan()
    expect(attachRecommenderUpgrades(plan, [])).toBe(plan)
    expect(attachRecommenderUpgrades(plan, null)).toBe(plan)
  })

  it('skips an owned DFC recommended by its front-face name', () => {
    // Owned rows carry the full "Front // Back" name; rec feeds may name the
    // same card by front face only. It must still count as owned.
    const { ownedCards, sfMap } = assemble([
      makeCard('Jugan Defends the Temple // Remnant of the Rising Star', {
        oracle: 'Create a 1/1 green Human Monk creature token.', type: 'Enchantment — Saga',
      }),
    ])
    const plan = analyzeBuildPlan({ commander: { name: 'Cmd', color_identity: ['G'] }, ownedCards, sfMap })
    const recRows = [
      { name: 'Jugan Defends the Temple', type_line: 'Enchantment — Saga', oracle_text: 'Create a token.', score: 0.9 },
    ]
    const out = attachRecommenderUpgrades(plan, recRows)
    const allRecs = (out.roles || []).flatMap(r => r.recommenderUpgrades || [])
    expect(allRecs.map(u => u.name)).not.toContain('Jugan Defends the Temple')
  })
})

describe('selectUpgrades', () => {
  const role = {
    gap: 4,
    edhrecUpgrades: [{ name: 'Cultivate', cmc: 3, edhrecInclusion: 90 }],
    recommenderUpgrades: [{ name: 'Harmonize', cmc: 4, score: 0.8 }, { name: 'Cultivate', cmc: 3, score: 0.5 }],
  }
  it('returns only the chosen source', () => {
    expect(selectUpgrades(role, 'edhrec').map(u => u.name)).toEqual(['Cultivate'])
    expect(selectUpgrades(role, 'recommander').map(u => u.name)).toEqual(['Harmonize', 'Cultivate'])
  })
  it('merges and de-dupes for "both", keeping the EDHREC entry', () => {
    const both = selectUpgrades(role, 'both')
    expect(both.filter(u => u.name === 'Cultivate')).toHaveLength(1)
    expect(both.find(u => u.name === 'Cultivate').edhrecInclusion).toBe(90) // kept the EDHREC one
    expect(both.map(u => u.name)).toContain('Harmonize')
  })
})

// ── Cut helper ────────────────────────────────────────────────────────────────
describe('rankCutCandidates', () => {
  const unpopular = { id: 'a', name: 'Unpopular', role: ROLE_SYNERGY, cmc: 2, inclusion: 10, hasData: true, roleOver: 0 }
  const offMeta   = { id: 'b', name: 'Off-meta',  role: ROLE_SYNERGY, cmc: 2, inclusion: 0,  hasData: false, roleOver: 0 }
  const overbuilt = { id: 'c', name: 'Overbuilt', role: ROLE_RAMP,    cmc: 2, inclusion: 90, hasData: true, roleOver: 3 }

  it('exposes the three modes', () => {
    expect(CUT_MODES.map(m => m.id)).toEqual(['balanced', 'popularity', 'redundancy'])
  })

  it('balanced cuts an unpopular known card before an off-meta unknown one', () => {
    const ranked = rankCutCandidates([offMeta, unpopular], 'balanced')
    expect(ranked[0].name).toBe('Unpopular')
    expect(ranked[1].name).toBe('Off-meta')
  })

  it('popularity mode treats unknown cards as most cuttable', () => {
    const ranked = rankCutCandidates([unpopular, offMeta], 'popularity')
    expect(ranked[0].name).toBe('Off-meta')
  })

  it('redundancy mode pushes over-quota cards to the top despite high inclusion', () => {
    const ranked = rankCutCandidates([unpopular, overbuilt], 'redundancy')
    expect(ranked[0].name).toBe('Overbuilt')
    expect(ranked[0].reason).toBe(`extra ${ROLE_RAMP}`)
  })

  it('attaches a reason and preserves length', () => {
    const ranked = rankCutCandidates([unpopular, offMeta, overbuilt], 'balanced')
    expect(ranked).toHaveLength(3)
    expect(ranked.every(c => typeof c.reason === 'string' && c.reason)).toBe(true)
  })
})

// ── enrichPlanWithEdhrec ──────────────────────────────────────────────────────
describe('enrichPlanWithEdhrec', () => {
  const baseCards = () => {
    const cards = [
      makeCard('Cultivate', { oracle: 'Search your library for up to two basic land cards.', type: 'Sorcery', cmc: 3 }),
      makeCard('Rampant Growth', { oracle: 'Search your library for a basic land card.', type: 'Sorcery', cmc: 2 }),
    ]
    return assemble(cards)
  }

  it('returns the plan unchanged when EDHREC is null', async () => {
    const { ownedCards, sfMap } = baseCards()
    const plan = analyzeBuildPlan({ commander: { name: 'Cmd', color_identity: [] }, ownedCards, sfMap })
    const out = await enrichPlanWithEdhrec(plan, async () => null)
    expect(out).toBe(plan)
    expect(role(out, ROLE_RAMP).edhrecUpgrades).toEqual([])
  })

  it('boosts and re-ranks owned candidates by inclusion', async () => {
    const { ownedCards, sfMap } = baseCards()
    const plan = analyzeBuildPlan({ commander: { name: 'Cmd', color_identity: [] }, ownedCards, sfMap })
    // Default rank is by CMC: Rampant Growth (2) before Cultivate (3).
    expect(role(plan, ROLE_RAMP).ownedCandidates[0].name).toBe('Rampant Growth')

    const edhrec = {
      categories: [{
        header: 'Ramp',
        cards: [
          { name: 'Cultivate', inclusion: 90, cmc: 3, type: 'Sorcery' },
          { name: 'Rampant Growth', inclusion: 20, cmc: 2, type: 'Sorcery' },
        ],
      }],
    }
    const out = await enrichPlanWithEdhrec(plan, async () => edhrec)
    // After enrichment, Cultivate (90%) ranks above Rampant Growth (20%).
    expect(role(out, ROLE_RAMP).ownedCandidates[0].name).toBe('Cultivate')
    expect(role(out, ROLE_RAMP).ownedCandidates[0].edhrecInclusion).toBe(90)
    // The input plan is left untouched (enrichment returns a clone).
    expect(role(plan, ROLE_RAMP).ownedCandidates[0].name).toBe('Rampant Growth')
  })

  it('fills upgrades with high-inclusion cards the user does not own', async () => {
    const { ownedCards, sfMap } = baseCards()
    const plan = analyzeBuildPlan({ commander: { name: 'Cmd', color_identity: [] }, ownedCards, sfMap })
    const edhrec = {
      categories: [{
        header: 'Ramp',
        cards: [
          { name: 'Cultivate', inclusion: 90, cmc: 3, type: 'Sorcery' }, // owned
          { name: 'Sol Ring', inclusion: 95, cmc: 1, type: 'Artifact' }, // not owned
        ],
      }],
    }
    const out = await enrichPlanWithEdhrec(plan, async () => edhrec)
    const upgrades = role(out, ROLE_RAMP).edhrecUpgrades.map(u => u.name)
    expect(upgrades).toContain('Sol Ring')
    expect(upgrades).not.toContain('Cultivate')
  })

  it('classifies unowned upgrades by oracle text when card meta is provided', async () => {
    // EDHREC lists Opt under a type-based "Instants" header (no functional role),
    // so without rules text it would fall into Synergy. With fetched oracle text
    // it lands in Draw, and the resolved art is attached.
    const plan = analyzeBuildPlan({ commander: { name: 'Cmd', color_identity: [] } })
    const edhrec = { categories: [{ header: 'Instants', cards: [
      { name: 'Opt', inclusion: 80, potentialDecks: 100, cmc: 1, type: 'Instant' },
    ] }] }
    const fetchMeta = async names =>
      names.map(n => ({ name: n, type_line: 'Instant', oracle_text: 'Draw a card.', image: 'opt.jpg' }))
    const out = await enrichPlanWithEdhrec(plan, async () => edhrec, fetchMeta)
    const draw = role(out, ROLE_DRAW).edhrecUpgrades.find(u => u.name === 'Opt')
    expect(draw).toBeTruthy()
    expect(draw.image).toBe('opt.jpg')
    expect(role(out, ROLE_SYNERGY).edhrecUpgrades.map(u => u.name)).not.toContain('Opt')
  })

  it('caps the upgrade list (8 floor, gap + 4 headroom)', async () => {
    // Empty collection → Ramp gap == its full ideal (11), so cap = 11 + 4 = 15.
    const plan = analyzeBuildPlan({ commander: { name: 'Cmd', color_identity: [] } })
    const cards = Array.from({ length: 30 }, (_, i) => ({
      name: `Rock ${i}`, inclusion: 100 - i, cmc: 2, type: 'Artifact',
    }))
    const edhrec = { categories: [{ header: 'Mana Artifacts', cards }] }
    const out = await enrichPlanWithEdhrec(plan, async () => edhrec)
    const ramp = role(out, ROLE_RAMP)
    expect(ramp.edhrecUpgrades).toHaveLength(ramp.gap + 4)
    // Sorted by inclusion desc, so the top pick is the highest-inclusion rock.
    expect(ramp.edhrecUpgrades[0].name).toBe('Rock 0')
  })

  it('never returns fewer than the floor of 8 upgrades when available', async () => {
    // Board Wipe ideal is 3. Own 3 wipes that are all already in the deck →
    // current 3, gap 0, so gap + 4 = 4 < the floor of 8. The cap must hold at 8.
    const owned = [
      makeCard('Wrath of God', { oracle: 'Destroy all creatures.', type: 'Sorcery' }),
      makeCard('Damnation', { oracle: 'Destroy all creatures.', type: 'Sorcery' }),
      makeCard('Day of Judgment', { oracle: 'Destroy all creatures.', type: 'Sorcery' }),
    ]
    const { ownedCards, sfMap } = assemble(owned)
    const plan = analyzeBuildPlan({
      commander: { name: 'Cmd', color_identity: [] },
      ownedCards,
      sfMap,
      currentDeckCards: owned.map(c => ({ name: c.row.name })),
    })
    const cards = Array.from({ length: 20 }, (_, i) => ({
      name: `Sweeper ${i}`, inclusion: 100 - i, cmc: 4, type: 'Sorcery',
    }))
    const edhrec = { categories: [{ header: 'Board Wipes', cards }] }
    const out = await enrichPlanWithEdhrec(plan, async () => edhrec)
    const wipe = role(out, ROLE_WIPE)
    expect(wipe.gap).toBe(0)
    expect(wipe.edhrecUpgrades).toHaveLength(8)
  })

  it('re-buckets an owned card into EDHREC\'s functional role', async () => {
    // A mana rock with no oracle text classifies locally as Synergy (the
    // type-only fallback), but EDHREC lists it under "Mana Artifacts" → Ramp.
    const { ownedCards, sfMap } = assemble([
      makeCard('Mystery Rock', { oracle: '', type: 'Artifact', cmc: 2 }),
    ])
    const plan = analyzeBuildPlan({ commander: { name: 'Cmd', color_identity: [] }, ownedCards, sfMap })
    expect(role(plan, ROLE_SYNERGY).ownedCandidates.map(c => c.name)).toContain('Mystery Rock')

    const edhrec = { categories: [{ header: 'Mana Artifacts', cards: [{ name: 'Mystery Rock', inclusion: 80, cmc: 2, type: 'Artifact' }] }] }
    const out = await enrichPlanWithEdhrec(plan, async () => edhrec)
    expect(role(out, ROLE_RAMP).ownedCandidates.map(c => c.name)).toContain('Mystery Rock')
    expect(role(out, ROLE_SYNERGY).ownedCandidates.map(c => c.name)).not.toContain('Mystery Rock')
  })

  it('keeps the local role when EDHREC\'s header is type-based', async () => {
    // "Creatures" maps to no functional role (edhrecHeaderToRole → null), so an
    // owned card there must stay where local classification put it.
    const { ownedCards, sfMap } = assemble([
      makeCard('Some Beast', { oracle: '', type: 'Creature', cmc: 4 }),
    ])
    const plan = analyzeBuildPlan({ commander: { name: 'Cmd', color_identity: [] }, ownedCards, sfMap })
    const localRole = plan.roles.find(r => r.ownedCandidates.some(c => c.name === 'Some Beast')).role
    const edhrec = { categories: [{ header: 'Creatures', cards: [{ name: 'Some Beast', inclusion: 50, cmc: 4, type: 'Creature' }] }] }
    const out = await enrichPlanWithEdhrec(plan, async () => edhrec)
    expect(role(out, localRole).ownedCandidates.map(c => c.name)).toContain('Some Beast')
  })

  it('returns the plan unchanged when the fetcher throws', async () => {
    const { ownedCards, sfMap } = baseCards()
    const plan = analyzeBuildPlan({ commander: { name: 'Cmd', color_identity: [] }, ownedCards, sfMap })
    const out = await enrichPlanWithEdhrec(plan, async () => { throw new Error('network down') })
    expect(out).toBe(plan)
    expect(role(out, ROLE_RAMP).edhrecUpgrades).toEqual([])
  })

  it('recognizes an owned DFC listed by EDHREC under its front-face name', async () => {
    // Regression: EDHREC names DFCs by front face only, owned rows carry the
    // full "Front // Back" name. The card must be enriched as owned — not
    // duplicated into the not-owned upgrade list.
    const { ownedCards, sfMap } = assemble([
      makeCard("Azusa's Many Journeys // Likeness of the Seeker", {
        oracle: 'You may play an additional land each turn.', type: 'Enchantment — Saga', cmc: 2,
      }),
    ])
    const plan = analyzeBuildPlan({ commander: { name: 'Cmd', color_identity: [] }, ownedCards, sfMap })
    const edhrec = { categories: [{ header: 'Ramp', cards: [
      { name: "Azusa's Many Journeys", inclusion: 50, cmc: 2, type: 'Enchantment' },
    ] }] }
    const out = await enrichPlanWithEdhrec(plan, async () => edhrec)
    const ramp = role(out, ROLE_RAMP)
    expect(ramp.edhrecUpgrades.map(u => u.name)).not.toContain("Azusa's Many Journeys")
    const owned = out.roles.flatMap(r => r.ownedCandidates)
      .find(c => c.name === "Azusa's Many Journeys // Likeness of the Seeker")
    expect(owned.edhrecInclusion).toBe(50)
  })
})

// ── roleOfDeckCard / countByRole (deck classification) ────────────────────────
// Regression coverage for the "everything collapses into Synergy" bug: deck
// cards must classify by their oracle text when that's confident, and only fall
// back to the plan's role when oracle text yields nothing functional.
describe('roleOfDeckCard', () => {
  const sfMap = {
    s1: { oracle_text: 'Counter target spell.', type_line: 'Instant' },     // Removal
    s2: { oracle_text: '', type_line: 'Artifact' },                          // no oracle → Synergy by text
    s3: { oracle_text: '{T}: Add {C}{C}.', type_line: 'Artifact' },          // Ramp
  }

  it('uses the confident oracle-text role and ignores the plan role', () => {
    // The plan (stale) says Synergy, but the oracle clearly makes it Removal.
    const roleByName = new Map([['counterspell', ROLE_SYNERGY]])
    expect(roleOfDeckCard({ scryfall_id: 's1', name: 'Counterspell' }, sfMap, roleByName))
      .toBe(ROLE_REMOVAL)
  })

  it('falls back to the plan role only when oracle text is non-functional', () => {
    // s2 has no usable oracle (→ Synergy by text), so EDHREC re-bucketing wins.
    const roleByName = new Map([['mystery rock', ROLE_RAMP]])
    expect(roleOfDeckCard({ scryfall_id: 's2', name: 'Mystery Rock' }, sfMap, roleByName))
      .toBe(ROLE_RAMP)
  })

  it('lands in Synergy when neither oracle nor plan classify it', () => {
    expect(roleOfDeckCard({ scryfall_id: 's2', name: 'Unknown' }, sfMap, new Map()))
      .toBe(ROLE_SYNERGY)
  })

  it('is missing-sfMap tolerant (no entry → relies on the plan / Synergy)', () => {
    expect(roleOfDeckCard({ scryfall_id: 'absent', name: 'X' }, sfMap, new Map())).toBe(ROLE_SYNERGY)
  })

  it('resolves a DFC deck row against a plan role keyed by front-face name', () => {
    // EDHREC upgrade entries name DFCs by front face; the deck row added from
    // one carries the full "Front // Back" name and must still find its role.
    const roleByName = new Map([['mystery rock', ROLE_RAMP]])
    expect(roleOfDeckCard({ scryfall_id: 's2', name: 'Mystery Rock // Hidden Gem' }, sfMap, roleByName))
      .toBe(ROLE_RAMP)
  })
})

describe('countByRole', () => {
  const sfMap = {
    s1: { oracle_text: 'Counter target spell.', type_line: 'Instant' },
    s3: { oracle_text: '{T}: Add {C}{C}.', type_line: 'Artifact' },
    sL: { oracle_text: '', type_line: 'Basic Land — Forest' },
  }
  it('buckets each deck card and excludes the commander, summing qty', () => {
    const deckCards = [
      { scryfall_id: 'cmd', name: 'Cmd', is_commander: true, qty: 1 },
      { scryfall_id: 's1', name: 'Counterspell', qty: 1 },
      { scryfall_id: 's3', name: 'Sol Ring', qty: 1 },
      { scryfall_id: 'sL', name: 'Forest', qty: 8 },
    ]
    const counts = countByRole(deckCards, sfMap, new Map())
    expect(counts.get(ROLE_REMOVAL)).toBe(1)
    expect(counts.get(ROLE_RAMP)).toBe(1)
    expect(counts.get(ROLE_LANDS)).toBe(8)   // qty summed
    expect(counts.get(ROLE_WIPE)).toBe(0)
  })
})

// ── pickCheapestEnglish ───────────────────────────────────────────────────────
describe('pickCheapestEnglish', () => {
  it('skips a cheaper foreign printing and picks the cheapest English one', () => {
    // Sorted cheapest-first: a foreign printing is cheapest, but must be skipped.
    const candidates = [
      { id: 'zhs', price: 0.50 },
      { id: 'en1', price: 0.72 },
      { id: 'en2', price: 1.20 },
    ]
    const langById = new Map([['zhs', 'zhs'], ['en1', 'en'], ['en2', 'en']])
    expect(pickCheapestEnglish(candidates, langById).id).toBe('en1')
  })

  it('returns null when no candidate is English', () => {
    const candidates = [{ id: 'ja', price: 1 }, { id: 'de', price: 2 }]
    const langById = new Map([['ja', 'ja'], ['de', 'de']])
    expect(pickCheapestEnglish(candidates, langById)).toBeNull()
  })

  it('tolerates empty input', () => {
    expect(pickCheapestEnglish([], new Map())).toBeNull()
    expect(pickCheapestEnglish(null, new Map())).toBeNull()
  })
})

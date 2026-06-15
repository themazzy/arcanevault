import { describe, it, expect } from 'vitest'
import {
  granularToCoarse,
  coarseRole,
  analyzeBuildPlan,
  enrichPlanWithEdhrec,
  archetypeAdjustments,
  applyTemplateAdjustments,
  bracketFlagFor,
  producedColors,
  isManaSource,
  countManaSources,
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
function makeCard(name, { oracle = '', type = '', ci = [], legalities, cmc = 0 } = {}) {
  const id = `sf-${idCounter++}`
  return {
    row: { scryfall_id: id, name },
    sf: {
      [id]: {
        name,
        oracle_text: oracle,
        type_line: type,
        color_identity: ci,
        cmc,
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
    await enrichPlanWithEdhrec(plan, async () => edhrec)
    // After enrichment, Cultivate (90%) ranks above Rampant Growth (20%).
    expect(role(plan, ROLE_RAMP).ownedCandidates[0].name).toBe('Cultivate')
    expect(role(plan, ROLE_RAMP).ownedCandidates[0].edhrecInclusion).toBe(90)
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
    await enrichPlanWithEdhrec(plan, async () => edhrec)
    const upgrades = role(plan, ROLE_RAMP).edhrecUpgrades.map(u => u.name)
    expect(upgrades).toContain('Sol Ring')
    expect(upgrades).not.toContain('Cultivate')
  })
})

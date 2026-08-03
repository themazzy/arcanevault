import { describe, it, expect } from 'vitest'
import {
  cardRoleTags,
  cardRoleTagsFromCard,
  drawQuality,
  drawAmount,
  drawGiveback,
  isRepeatable,
  isExplosiveRamp,
  stripReminders,
  engineRoleCount,
  ENGINE_ROLES,
} from './cardRoles'
import {
  ROLE_RAMP,
  ROLE_DRAW,
  ROLE_REMOVAL,
  ROLE_WIPE,
  ROLE_PROTECTION,
  ROLE_WINCON,
  ROLE_LANDS,
} from './deckBuildAssistant'

// Oracle text below is verbatim from the Scryfall /cards/collection endpoint,
// not written from memory — several of these differ from what you'd guess
// (Brainstorm nets +1, not +2; Ponder's draw is a separate line from its scry).
const ORACLE = {
  solemnSimulacrum: {
    type: 'Artifact Creature — Golem',
    text: 'When this creature enters, you may search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.\nWhen this creature dies, you may draw a card.',
  },
  kastral: {
    type: 'Legendary Creature — Bird Scout',
    text: 'Flying\nWhenever one or more Birds you control deal combat damage to a player, choose one —\n• You may put a Bird creature card from your hand or graveyard onto the battlefield with a finality counter on it.\n• Put a +1/+1 counter on each Bird you control.\n• Draw a card.',
  },
  solRing: { type: 'Artifact', text: '{T}: Add {C}{C}.' },
  arcaneSignet: { type: 'Artifact', text: "{T}: Add one mana of any color in your commander's color identity." },
  beastWhisperer: { type: 'Creature — Elf Druid', text: 'Whenever you cast a creature spell, draw a card.' },
  esperSentinel: {
    type: 'Artifact Creature — Human Soldier',
    text: "Whenever an opponent casts their first noncreature spell each turn, draw a card unless that player pays {X}, where X is this creature's power.",
  },
  smotheringTithe: {
    type: 'Enchantment',
    text: 'Whenever an opponent draws a card, that player may pay {2}. If the player doesn\'t, you create a Treasure token. (It\'s an artifact with "{T}, Sacrifice this token: Add one mana of any color.")',
  },
  rhysticStudy: { type: 'Enchantment', text: 'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.' },
  phyrexianArena: { type: 'Enchantment', text: 'At the beginning of your upkeep, you draw a card and you lose 1 life.' },
  faithlessLooting: {
    type: 'Sorcery',
    text: 'Draw two cards, then discard two cards.\nFlashback {2}{R} (You may cast this card from your graveyard for its flashback cost. Then exile it.)',
  },
  frantieSearch: { type: 'Instant', text: 'Draw two cards, then discard two cards. Untap up to three lands.' },
  brainstorm: { type: 'Instant', text: 'Draw three cards, then put two cards from your hand on top of your library in any order.' },
  ponder: {
    type: 'Sorcery',
    text: 'Look at the top three cards of your library, then put them back in any order. You may shuffle.\nDraw a card.',
  },
  divination: { type: 'Sorcery', text: 'Draw two cards.' },
  nightsWhisper: { type: 'Sorcery', text: 'You draw two cards and lose 2 life.' },
  harmonize: { type: 'Sorcery', text: 'Draw three cards.' },
  blueSunsZenith: { type: 'Instant', text: "Target player draws X cards. Shuffle Blue Sun's Zenith into its owner's library." },
  ravenousChupacabra: { type: 'Creature — Beast Horror', text: 'When this creature enters, destroy target creature an opponent controls.' },
  swordsToPlowshares: { type: 'Instant', text: 'Exile target creature. Its controller gains life equal to its power.' },
  wrathOfGod: { type: 'Sorcery', text: "Destroy all creatures. They can't be regenerated." },
  lightningGreaves: {
    type: 'Artifact — Equipment',
    text: "Equipped creature has haste and shroud. (It can't be the target of spells or abilities.)\nEquip {0}",
  },
  nyxbloomAncient: {
    type: 'Enchantment Creature — Elemental',
    text: 'Trample\nIf you tap a permanent for mana, it produces three times as much of that mana instead.',
  },
  darkRitual: { type: 'Instant', text: 'Add {B}{B}{B}.' },
  jeskasWill: {
    type: 'Sorcery',
    text: "Choose one. If you control a commander as you cast this spell, you may choose both instead.\n• Add {R} for each card in target opponent's hand.\n• Exile the top three cards of your library. You may play them this turn.",
  },
  cabalCoffers: { type: 'Land', text: '{2}, {T}: Add {B} for each Swamp you control.' },
  manaFlare: { type: 'Enchantment', text: 'Whenever a player taps a land for mana, that player adds one mana of any type that land produced.' },
  deadlyDispute: {
    type: 'Instant',
    text: 'As an additional cost to cast this spell, sacrifice an artifact or creature.\nDraw two cards and create a Treasure token. (It\'s an artifact with "{T}, Sacrifice this token: Add one mana of any color.")',
  },
}

const tags = key => cardRoleTags(ORACLE[key].text, ORACLE[key].type)

describe('stripReminders', () => {
  it('removes parenthetical reminder text but leaves mana costs alone', () => {
    expect(stripReminders('Equip {0} (It costs {2} to equip.)')).toContain('{0}')
    expect(stripReminders('Equip {0} (It costs {2} to equip.)')).not.toContain('equip.')
  })

  // The Treasure reminder text says "Add one mana of any color" — without
  // stripping, every Treasure-maker in the format reads as a mana rock.
  it('stops Treasure reminder text from reading as mana production', () => {
    const { roles, tags: t } = tags('smotheringTithe')
    expect(roles.has(ROLE_RAMP)).toBe(true) // via "create a Treasure token"
    expect(t.has('explosive-ramp')).toBe(false) // not via the reminder's "Add one mana"
  })
})

describe('drawAmount / drawGiveback', () => {
  it('reads the draw count in each templating', () => {
    expect(drawAmount(ORACLE.divination.text.toLowerCase())).toBe(2)
    expect(drawAmount(ORACLE.harmonize.text.toLowerCase())).toBe(3)
    expect(drawAmount(ORACLE.nightsWhisper.text.toLowerCase())).toBe(2) // "You draw two cards"
    expect(drawAmount(ORACLE.blueSunsZenith.text.toLowerCase())).toBe(3) // X → 3
    expect(drawAmount(ORACLE.beastWhisperer.text.toLowerCase())).toBe(1)
  })

  it('reads the cards handed back', () => {
    expect(drawGiveback(ORACLE.faithlessLooting.text.toLowerCase())).toBe(2)
    expect(drawGiveback(ORACLE.brainstorm.text.toLowerCase())).toBe(2)
    expect(drawGiveback(ORACLE.divination.text.toLowerCase())).toBe(0)
  })
})

describe('isRepeatable', () => {
  it('detects triggered abilities', () => {
    expect(isRepeatable(ORACLE.rhysticStudy.text.toLowerCase())).toBe(true)
    expect(isRepeatable(ORACLE.phyrexianArena.text.toLowerCase())).toBe(true)
  })
  it('detects activated abilities', () => {
    expect(isRepeatable(ORACLE.solRing.text.toLowerCase())).toBe(true)
    expect(isRepeatable(ORACLE.cabalCoffers.text.toLowerCase())).toBe(true)
  })
  it('is false for one-shot spells', () => {
    expect(isRepeatable(ORACLE.divination.text.toLowerCase())).toBe(false)
    expect(isRepeatable(ORACLE.harmonize.text.toLowerCase())).toBe(false)
  })
})

// This is the transcript's card-advantage rule and the thing the shipped
// 'Card Draw' category gets wrong: looting and cantrips are card SELECTION.
describe('drawQuality — net advantage vs selection', () => {
  it('counts a one-shot that nets 2+ as advantage', () => {
    expect(drawQuality(ORACLE.divination.text.toLowerCase()).kind).toBe('advantage')
    expect(drawQuality(ORACLE.nightsWhisper.text.toLowerCase()).kind).toBe('advantage')
    expect(drawQuality(ORACLE.harmonize.text.toLowerCase()).kind).toBe('advantage')
  })

  it('rejects loot/rummage that nets zero', () => {
    expect(drawQuality(ORACLE.faithlessLooting.text.toLowerCase()).kind).toBe('selection')
    expect(drawQuality(ORACLE.frantieSearch.text.toLowerCase()).kind).toBe('selection')
  })

  it('rejects Brainstorm — draws 3, puts 2 back, nets 1', () => {
    const q = drawQuality(ORACLE.brainstorm.text.toLowerCase())
    expect(q.net).toBe(1)
    expect(q.kind).toBe('selection')
  })

  it('rejects a cantrip that only replaces itself', () => {
    expect(drawQuality(ORACLE.ponder.text.toLowerCase()).kind).toBe('selection')
  })

  it('accepts a repeatable single-card draw', () => {
    expect(drawQuality(ORACLE.phyrexianArena.text.toLowerCase()).kind).toBe('advantage')
    expect(drawQuality(ORACLE.rhysticStudy.text.toLowerCase()).kind).toBe('advantage')
    expect(drawQuality(ORACLE.beastWhisperer.text.toLowerCase()).kind).toBe('advantage')
    expect(drawQuality(ORACLE.esperSentinel.text.toLowerCase()).kind).toBe('advantage')
  })

  it('flags burst draw, which is what justifies an expensive draw slot', () => {
    expect(drawQuality(ORACLE.harmonize.text.toLowerCase()).burst).toBe(true)
    expect(drawQuality(ORACLE.blueSunsZenith.text.toLowerCase()).burst).toBe(true)
    expect(drawQuality(ORACLE.divination.text.toLowerCase()).burst).toBe(false)
  })
})

describe('isExplosiveRamp', () => {
  it('detects multipliers, rituals and scaling mana', () => {
    expect(isExplosiveRamp(ORACLE.nyxbloomAncient.text.toLowerCase(), 'enchantment creature')).toBe(true)
    expect(isExplosiveRamp(ORACLE.darkRitual.text.toLowerCase(), 'instant')).toBe(true)
    expect(isExplosiveRamp(ORACLE.jeskasWill.text.toLowerCase(), 'sorcery')).toBe(true)
    expect(isExplosiveRamp(ORACLE.cabalCoffers.text.toLowerCase(), 'land')).toBe(true)
    expect(isExplosiveRamp(ORACLE.manaFlare.text.toLowerCase(), 'enchantment')).toBe(true)
  })

  it('does not flag ordinary mana rocks', () => {
    expect(isExplosiveRamp(ORACLE.solRing.text.toLowerCase(), 'artifact')).toBe(false)
    expect(isExplosiveRamp(ORACLE.arcaneSignet.text.toLowerCase(), 'artifact')).toBe(false)
  })
})

// The headline feature: one card, several jobs.
describe('cardRoleTags — multi-role detection', () => {
  // Solemn is the case that forces roles and jobs apart: it ramps and replaces
  // itself, so it is a two-job card — but it nets zero cards, so it must not be
  // counted against the card-advantage quota.
  it('Solemn Simulacrum is a two-job card that does not fill the Draw quota', () => {
    const { roles, jobs } = tags('solemnSimulacrum')
    expect(roles.has(ROLE_RAMP)).toBe(true)
    expect(roles.has(ROLE_DRAW)).toBe(false)
    expect(jobs.has(ROLE_DRAW)).toBe(true)
    expect(engineRoleCount(jobs)).toBe(2)
  })

  it('Kastral is a multi-engine commander (recursion + payoff + draw)', () => {
    const { roles } = tags('kastral')
    expect(roles.has(ROLE_DRAW)).toBe(true)
    expect(engineRoleCount(roles)).toBeGreaterThanOrEqual(1)
  })

  it('Deadly Dispute draws and ramps off one card', () => {
    const { roles } = tags('deadlyDispute')
    expect(roles.has(ROLE_DRAW)).toBe(true)
    expect(roles.has(ROLE_RAMP)).toBe(true)
  })

  it('single-purpose cards stay single-role', () => {
    expect(engineRoleCount(tags('solRing').roles)).toBe(1)
    expect(engineRoleCount(tags('arcaneSignet').roles)).toBe(1)
    expect(engineRoleCount(tags('divination').roles)).toBe(1)
    expect(engineRoleCount(tags('swordsToPlowshares').roles)).toBe(1)
  })

  // Land fetch is ramp and only ramp. Counting it as a tutor too would hand a
  // multi-engine bonus to every Cultivate/Rampant Growth in the format.
  it('does not read a land fetch as a tutor as well as ramp', () => {
    const { roles } = cardRoleTags(
      'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.',
      'Sorcery',
    )
    expect(roles.has(ROLE_RAMP)).toBe(true)
    expect(roles.has(ROLE_DRAW)).toBe(false)
    expect(engineRoleCount(roles)).toBe(1)
  })

  it('still reads a real tutor as card advantage', () => {
    const { roles } = cardRoleTags('Search your library for a card, then shuffle and put that card on top of it.', 'Sorcery')
    expect(roles.has(ROLE_DRAW)).toBe(true)
  })

  it('a loot spell fills no role at all', () => {
    const { roles, tags: t } = tags('faithlessLooting')
    expect(roles.has(ROLE_DRAW)).toBe(false)
    expect(t.has('selection')).toBe(true)
    expect(engineRoleCount(roles)).toBe(0)
  })
})

describe('cardRoleTags — interaction roles', () => {
  it('separates spot removal from board wipes', () => {
    expect(tags('swordsToPlowshares').roles.has(ROLE_REMOVAL)).toBe(true)
    expect(tags('ravenousChupacabra').roles.has(ROLE_REMOVAL)).toBe(true)
    const wrath = tags('wrathOfGod').roles
    expect(wrath.has(ROLE_WIPE)).toBe(true)
    expect(wrath.has(ROLE_REMOVAL)).toBe(false) // a wipe is not also spot removal
  })

  it('detects protection', () => {
    expect(tags('lightningGreaves').roles.has(ROLE_PROTECTION)).toBe(true)
  })

  it('detects win conditions', () => {
    const { roles } = cardRoleTags('Target opponent loses 10 life.', 'Sorcery')
    expect(roles.has(ROLE_WINCON)).toBe(true)
  })
})

describe('cardRoleTags — lands', () => {
  it('tags lands as Lands and keeps them out of the engine count', () => {
    const { roles } = tags('cabalCoffers')
    expect(roles.has(ROLE_LANDS)).toBe(true)
    expect(ENGINE_ROLES).not.toContain(ROLE_LANDS)
    // Cabal Coffers is explosive, but its mana production must not read as Ramp
    // — lands belong to the manabase, not the ramp quota, and letting it fill
    // both would inflate its multi-engine count off a single card.
    expect(tags('cabalCoffers').tags.has('explosive-ramp')).toBe(true)
    expect(roles.has(ROLE_RAMP)).toBe(false)
    expect(engineRoleCount(roles)).toBe(0)
  })
})

describe('cardRoleTagsFromCard', () => {
  it('joins double-faced card text so back-face abilities count', () => {
    const { roles } = cardRoleTagsFromCard(null, {
      card_faces: [
        { oracle_text: 'Flying', type_line: 'Creature — Bird' },
        { oracle_text: 'Draw two cards.', type_line: 'Sorcery' },
      ],
    })
    expect(roles.has(ROLE_DRAW)).toBe(true)
  })

  it('falls back to the card row when no Scryfall entry is cached', () => {
    const { roles } = cardRoleTagsFromCard(
      { oracle_text: 'Draw three cards.', type_line: 'Sorcery' },
      null,
    )
    expect(roles.has(ROLE_DRAW)).toBe(true)
  })
})

// Regression: engineEnablers used to import stripReminders from THIS module,
// closing the cycle cardRoles -> deckBuildAssistant -> engineEnablers ->
// cardRoles. The role constants then resolved to undefined at module-init time,
// ENGINE_ROLES became a list of undefineds, and engineRoleCount silently
// returned 0 for every card — disabling the multi-role signal with no error,
// just a number that quietly became zero.
describe('module init (import cycle regression)', () => {
  it('has real role constants, not undefined', () => {
    expect(ENGINE_ROLES).toHaveLength(6)
    for (const r of ENGINE_ROLES) expect(typeof r).toBe('string')
  })

  it('counts engine roles for a genuinely two-job card', () => {
    const { jobs } = cardRoleTags(
      'When this creature enters, you may search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.\nWhen this creature dies, you may draw a card.',
      'Artifact Creature — Golem',
    )
    expect(engineRoleCount(jobs)).toBe(2)
  })
})

import { describe, it, expect } from 'vitest'
import {
  cardEnablers,
  isTribeMember,
  commanderNeeds,
  analyzeEngineCoverage,
  caresAboutOthersEntering,
  TRIBE_TARGET,
} from './engineEnablers'

// Verbatim Scryfall oracle text. The negative cases are the point of this file:
// a false positive makes a deck look covered when it isn't, which is worse than
// having no quota at all.
const C = {
  // ── Real sacrifice outlets: repeatable, sacrifice something OTHER than self
  ashnodsAltar:   { t: 'Artifact', o: 'Sacrifice a creature: Add {C}{C}.' },
  visceraSeer:    { t: 'Creature — Vampire Wizard', o: 'Sacrifice a creature: Scry 1.' },
  carrionFeeder:  { t: 'Creature — Zombie', o: "This creature can't block.\nSacrifice a creature: Put a +1/+1 counter on this creature." },
  goblinBombard:  { t: 'Enchantment', o: 'Sacrifice a creature: This enchantment deals 1 damage to any target.' },
  phyrexianAltar: { t: 'Artifact', o: 'Sacrifice a creature: Add one mana of any color.' },
  altarDementia:  { t: 'Artifact', o: "Sacrifice a creature: Target player mills cards equal to the sacrificed creature's power." },
  woeStrider:     { t: 'Creature — Horror', o: 'When this creature enters, create a 0/1 white Goat creature token.\nSacrifice another creature: Scry 1.\nEscape—{3}{B}{B}, Exile four other cards from your graveyard.' },
  yawgmoth:       { t: 'Legendary Creature — Human Cleric', o: 'Protection from Humans\nPay 1 life, Sacrifice another creature: Put a -1/-1 counter on up to one target creature and draw a card.' },

  // ── NOT outlets, though every one contains "sacrifice a/an ... creature"
  sakuraElder:    { t: 'Creature — Snake Shaman', o: 'Sacrifice this creature: Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.' },
  evolvingWilds:  { t: 'Land', o: '{T}, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.' },
  villageRites:   { t: 'Instant', o: 'As an additional cost to cast this spell, sacrifice a creature.\nDraw two cards.' },
  deadlyDispute:  { t: 'Instant', o: 'As an additional cost to cast this spell, sacrifice an artifact or creature.\nDraw two cards and create a Treasure token. (It\'s an artifact with "{T}, Sacrifice this token: Add one mana of any color.")' },

  // ── Blink
  cloudshift:     { t: 'Instant', o: 'Exile target creature you control, then return that card to the battlefield under your control.' },
  ephemerate:     { t: 'Instant', o: 'Exile target creature you control, then return it to the battlefield under its owner\'s control.' },
  restoAngel:     { t: 'Creature — Angel', o: 'Flash\nFlying\nWhen this creature enters, you may exile target non-Angel creature you control, then return that card to the battlefield under your control.' },
  conjurersCloset:{ t: 'Artifact', o: 'At the beginning of your end step, you may exile target creature you control, then return that card to the battlefield under your control.' },
  brago:          { t: 'Legendary Creature — Spirit Noble', o: 'Flying\nWhenever Brago deals combat damage to a player, exile any number of target nonland permanents you control, then return those cards to the battlefield under their owner\'s control.' },
  swords:         { t: 'Instant', o: 'Exile target creature. Its controller gains life equal to its power.' },

  // ── Mill / recursion / lands
  stitchers:      { t: 'Creature — Zombie', o: 'When this creature enters or dies, mill three cards.' },
  eternalWitness: { t: 'Creature — Human Shaman', o: 'When this creature enters, you may return target card from your graveyard to your hand.' },
  regrowth:       { t: 'Sorcery', o: 'Return target card from your graveyard to your hand.' },
  exploration:    { t: 'Enchantment', o: 'You may play an additional land on each of your turns.' },
  azusa:          { t: 'Legendary Creature — Human Monk', o: 'You may play two additional lands on each of your turns.' },

  // ── Neutral
  solRing:        { t: 'Artifact', o: '{T}: Add {C}{C}.' },
  bloodArtist:    { t: 'Creature — Vampire', o: 'Whenever this creature or another creature dies, target player loses 1 life and you gain 1 life.' },
  bitterblossom:  { t: 'Kindred Enchantment — Faerie', o: 'At the beginning of your upkeep, you lose 1 life and create a 1/1 black Faerie Rogue creature token with flying.' },
  captivating:    { t: 'Creature — Vampire', o: 'Other Vampire creatures you control get +1/+1.' },
}

const has = (key, enabler) => cardEnablers(C[key].o, C[key].t).has(enabler)

describe('sacrifice outlet detection', () => {
  it('accepts repeatable outlets', () => {
    for (const k of ['ashnodsAltar', 'visceraSeer', 'carrionFeeder', 'goblinBombard', 'phyrexianAltar', 'altarDementia', 'woeStrider', 'yawgmoth']) {
      expect(has(k, 'sacOutlet'), k).toBe(true)
    }
  })

  // These are the cards that make a naive "sacrifice a creature" regex useless.
  it('rejects a creature that sacrifices ITSELF', () => {
    expect(has('sakuraElder', 'sacOutlet')).toBe(false)
    expect(has('evolvingWilds', 'sacOutlet')).toBe(false)
  })

  it('rejects a one-shot spell with sacrifice as an additional cost', () => {
    expect(has('villageRites', 'sacOutlet')).toBe(false)
    expect(has('deadlyDispute', 'sacOutlet')).toBe(false)
  })

  it('rejects cards with no sacrifice at all', () => {
    expect(has('solRing', 'sacOutlet')).toBe(false)
    expect(has('bloodArtist', 'sacOutlet')).toBe(false) // a death PAYOFF, not an outlet
  })

  it('ignores lands entirely, so fetchlands do not pad the count', () => {
    expect(cardEnablers('{T}, Sacrifice this land: Search your library for a basic land card.', 'Land').size).toBe(0)
  })
})

describe('blink detection', () => {
  it('accepts real blink effects', () => {
    for (const k of ['cloudshift', 'ephemerate', 'restoAngel', 'conjurersCloset', 'brago']) {
      expect(has(k, 'blink'), k).toBe(true)
    }
  })

  it('rejects exile-based removal that never returns the card', () => {
    expect(has('swords', 'blink')).toBe(false)
  })
})

describe('self-mill, recursion, extra land drops', () => {
  it('accepts self-mill but not an attack on an opponent', () => {
    expect(has('stitchers', 'selfMill')).toBe(true)
    // Altar of Dementia mills a TARGET PLAYER — that's a wincon, not graveyard fuel.
    expect(has('altarDementia', 'selfMill')).toBe(false)
  })

  it('accepts recursion', () => {
    expect(has('eternalWitness', 'recursion')).toBe(true)
    expect(has('regrowth', 'recursion')).toBe(true)
    expect(has('solRing', 'recursion')).toBe(false)
  })

  it('accepts extra land drops', () => {
    expect(has('exploration', 'extraLand')).toBe(true)
    expect(has('azusa', 'extraLand')).toBe(true)
    expect(has('solRing', 'extraLand')).toBe(false)
  })
})

describe('isTribeMember', () => {
  it('matches on the type line', () => {
    expect(isTribeMember('Creature — Vampire Wizard', 'vampire')).toBe(true)
    expect(isTribeMember('Creature — Zombie', 'vampire')).toBe(false)
  })
  it('is false with no tribe', () => {
    expect(isTribeMember('Creature — Vampire', null)).toBe(false)
  })
})

describe('commanderNeeds', () => {
  it('derives sacrifice outlets from a sacrifice commander', () => {
    const needs = commanderNeeds(new Set(['sacrifice', 'counters']), null, 'Whenever you sacrifice a permanent, draw a card.')
    expect(needs.map(n => n.enabler)).toContain('sacOutlet')
  })

  // Blink is derived from the commander's TEXT, not the bare 'etb' hook — see
  // caresAboutOthersEntering below for why that distinction had to exist.
  it('derives blink from a commander that pays off others entering', () => {
    const needs = commanderNeeds(new Set(['etb']), null, 'Whenever another creature you control enters, draw a card.')
    expect(needs.map(n => n.enabler)).toContain('blink')
  })

  // One outlet serves every hook that wants one, so overlapping hooks must take
  // the highest target rather than adding up to an impossible quota.
  it('takes the max target when two hooks imply the same enabler', () => {
    const needs = commanderNeeds(
      new Set(['sacrifice', 'leaves']), null,
      'Whenever you sacrifice a permanent, draw a card. When this leaves the battlefield, put its counters on target creature.',
    )
    const sac = needs.find(n => n.enabler === 'sacOutlet')
    expect(sac.target).toBe(6)
    expect(sac.hooks).toEqual(expect.arrayContaining(['sacrifice', 'leaves']))
  })

  // Retired after measurement: every real tribal deck already ran far past the
  // quota, so it only ever produced a false alarm. See TRIBE_TARGET.
  it('does NOT add a tribe quota', () => {
    const needs = commanderNeeds(new Set(['attack']), 'vampire', 'Whenever Edgar attacks, put a counter on each Vampire.')
    expect(needs.find(n => n.enabler === 'tribe')).toBeUndefined()
  })

  it('does not demand sacrifice outlets from equipment self-protection text', () => {
    // Halvar's back face: "Whenever equipped creature dies, return it to its
    // owner's hand" — a voltron deck that wants no sacrifice outlets at all.
    const needs = commanderNeeds(
      new Set(['sacrifice', 'equipment']), null,
      "Equipped creature gets +2/+0 and has vigilance.\nWhenever equipped creature dies, return it to its owner's hand.\nEquip {1}{W}",
    )
    expect(needs.map(n => n.enabler)).not.toContain('sacOutlet')
  })

  it('still demands outlets from a real sacrifice commander', () => {
    const needs = commanderNeeds(
      new Set(['sacrifice']), null,
      'Whenever Korvold enters or attacks, sacrifice another permanent.',
    )
    expect(needs.map(n => n.enabler)).toContain('sacOutlet')
  })

  it('still demands outlets from a death-matters commander', () => {
    const needs = commanderNeeds(
      new Set(['sacrifice']), null,
      'Whenever another creature you control dies, you get an experience counter.',
    )
    expect(needs.map(n => n.enabler)).toContain('sacOutlet')
  })

  it('returns nothing for a commander with no relevant hooks', () => {
    expect(commanderNeeds(new Set(['evasion']))).toEqual([])
  })
})

describe('analyzeEngineCoverage', () => {
  const card = k => ({ name: k, oracle: C[k].o, type: C[k].t })

  it('counts providers and reports the shortfall', () => {
    const needs = commanderNeeds(new Set(['sacrifice']), null, 'Sacrifice another creature: draw a card.')
    const [cov] = analyzeEngineCoverage(
      [card('ashnodsAltar'), card('visceraSeer'), card('solRing'), card('sakuraElder')],
      needs,
    )
    expect(cov.have).toBe(2)
    expect(cov.target).toBe(6)
    expect(cov.short).toBe(4)
    expect(cov.providers).toEqual(['ashnodsAltar', 'visceraSeer'])
  })

  it('reports no shortfall when the quota is met', () => {
    const needs = [{ enabler: 'sacOutlet', label: 'x', why: '', target: 2, hooks: [] }]
    const [cov] = analyzeEngineCoverage([card('ashnodsAltar'), card('visceraSeer')], needs)
    expect(cov.short).toBe(0)
  })

  it('counts tribe members when a tribe need is supplied explicitly', () => {
    const needs = [{ enabler: 'tribe', label: 'vampires', why: '', target: 25, hooks: [], tribe: 'vampire' }]
    const [cov] = analyzeEngineCoverage([card('captivating'), card('bloodArtist'), card('solRing')], needs)
    expect(cov.have).toBe(2)
  })

  it('handles an empty deck', () => {
    const needs = commanderNeeds(new Set(['sacrifice']), null, 'Sacrifice another creature: draw a card.')
    expect(analyzeEngineCoverage([], needs)[0].have).toBe(0)
  })
})

// Both of these were found by the step-0 sweep, which is exactly what it was
// for: measure the gap before building the fix, and the measurement exposed two
// need-derivation bugs that would have made auto-fill chase phantom quotas.
describe('caresAboutOthersEntering — no phantom blink requirement', () => {
  it('is false for a commander with only its OWN enters trigger', () => {
    // Korvold, Hei Bai, Omnath and Breya were each told to find 5 blink effects.
    // Real decks for all four run zero, and zero is right.
    expect(caresAboutOthersEntering('Whenever Korvold enters or attacks, sacrifice another permanent.')).toBe(false)
    expect(caresAboutOthersEntering('Whenever Hei Bai enters or attacks, you may sacrifice another creature or artifact.')).toBe(false)
  })

  it('is true for a real enters-matters commander', () => {
    expect(caresAboutOthersEntering('Whenever another creature you control enters, draw a card.')).toBe(true)
    expect(caresAboutOthersEntering('Whenever one or more creatures you control enter, create a token.')).toBe(true)
  })

  it('is true for an enters doubler', () => {
    expect(caresAboutOthersEntering('If an artifact or creature entering causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.')).toBe(true)
  })

  it('does not demand blink from a self-trigger commander', () => {
    const needs = commanderNeeds(
      new Set(['etb', 'sacrifice']), null,
      'Whenever Korvold enters or attacks, sacrifice another permanent.',
    )
    expect(needs.map(n => n.enabler)).not.toContain('blink')
    expect(needs.map(n => n.enabler)).toContain('sacOutlet')
  })

  it('does demand blink from an enters-matters commander', () => {
    const needs = commanderNeeds(new Set(['etb']), null, 'Whenever another creature you control enters, draw a card.')
    expect(needs.map(n => n.enabler)).toContain('blink')
  })
})

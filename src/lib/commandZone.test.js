import { describe, it, expect } from 'vitest'
import {
  manaSymbolCounts, isCompanionCard, validateCompanion, companionDeckSizeBonus,
  getOathbreakerPairIssue, isOathbreaker, isSignatureSpell, cardTypes,
} from './commandZone'

const card = (name, type_line, opts = {}) => ({ name, type_line, ...opts })

describe('manaSymbolCounts', () => {
  it('counts colored pips, splits hybrids', () => {
    expect(manaSymbolCounts('{R}{R}{G}')).toEqual({ R: 2, G: 1 })
    expect(manaSymbolCounts('{2}{W}{U}')).toEqual({ W: 1, U: 1 })
    expect(manaSymbolCounts('{R/G}{R}')).toEqual({ R: 2, G: 1 })
  })
})

describe('isCompanionCard', () => {
  it('detects known companions by name', () => {
    expect(isCompanionCard(card('Lurrus of the Dream-Den', 'Legendary Creature — Cat Nightmare'))).toBe(true)
  })
  it('detects via the companion keyword', () => {
    expect(isCompanionCard({ name: 'X', keywords: ['Companion'] })).toBe(true)
  })
  it('rejects ordinary cards', () => {
    expect(isCompanionCard(card('Sol Ring', 'Artifact'))).toBe(false)
  })
})

describe('validateCompanion', () => {
  it('Lurrus: permanents must be MV <= 2', () => {
    const deck = [
      card('Lurrus of the Dream-Den', 'Legendary Creature — Cat Nightmare', { cmc: 3 }),
      card('Mox', 'Artifact', { cmc: 0 }),
      card('Big Dude', 'Creature', { cmc: 5 }),
      card('Lightning Bolt', 'Instant', { cmc: 1 }),     // non-permanent: exempt
    ]
    const res = validateCompanion(deck[0], deck)
    expect(res.ok).toBe(false)
    expect(res.offenders).toEqual(['Big Dude'])   // companion itself excluded; instant exempt
  })

  it('Gyruda: every card even MV (lands ok at 0)', () => {
    const gyruda = card('Gyruda, Doom of Depths', 'Legendary Creature', { cmc: 6 })
    const ok = [gyruda, card('Forest', 'Basic Land — Forest', { cmc: 0 }), card('Wrath', 'Sorcery', { cmc: 4 })]
    expect(validateCompanion(gyruda, ok).ok).toBe(true)
    const bad = [gyruda, card('Bolt', 'Instant', { cmc: 1 })]
    expect(validateCompanion(gyruda, bad).offenders).toEqual(['Bolt'])
  })

  it('Obosh: non-land cards must be odd MV', () => {
    const obosh = card('Obosh, the Preypiercer', 'Legendary Creature', { cmc: 5 })
    const deck = [obosh, card('Forest', 'Basic Land', { cmc: 0 }), card('Even Thing', 'Creature', { cmc: 2 })]
    expect(validateCompanion(obosh, deck).offenders).toEqual(['Even Thing'])
  })

  it('Kaheera: creatures must be the allowed types', () => {
    const kaheera = card('Kaheera, the Orphanguard', 'Legendary Creature — Cat Beast', { cmc: 3 })
    const deck = [
      kaheera,
      card('Savannah Lions', 'Creature — Cat', { cmc: 1 }),
      card('Goblin', 'Creature — Goblin', { cmc: 1 }),
      card('Sol Ring', 'Artifact', { cmc: 1 }),       // non-creature: exempt
    ]
    expect(validateCompanion(kaheera, deck).offenders).toEqual(['Goblin'])
  })

  it('Jegantha: no duplicate mana symbols', () => {
    const jeg = card('Jegantha, the Wellspring', 'Legendary Creature', { cmc: 5, mana_cost: '{4}{G}' })
    const deck = [jeg, card('Counterspell', 'Instant', { mana_cost: '{U}{U}' }), card('Bolt', 'Instant', { mana_cost: '{R}' })]
    expect(validateCompanion(jeg, deck).offenders).toEqual(['Counterspell'])
  })

  it('Lutri: singleton except basics', () => {
    const lutri = card('Lutri, the Spellchaser', 'Legendary Creature', { cmc: 3 })
    const deck = [
      lutri,
      card('Forest', 'Basic Land — Forest', { qty: 20 }),
      card('Bolt', 'Instant', { qty: 2 }),
    ]
    expect(validateCompanion(lutri, deck).offenders).toEqual(['bolt'])
  })

  it('Umori: all non-land cards share a type', () => {
    const umori = card('Umori, the Collector', 'Legendary Creature', { cmc: 5 })
    const allCreatures = [umori, card('Bear', 'Creature', {}), card('Elf', 'Creature', {})]
    expect(validateCompanion(umori, allCreatures).ok).toBe(true)
    const mixed = [umori, card('Bear', 'Creature', {}), card('Bolt', 'Instant', {})]
    expect(validateCompanion(umori, mixed).ok).toBe(false)
  })

  it('Yorion exposes a +20 deck-size bonus and never flags cards', () => {
    const yorion = card('Yorion, Sky Nomad', 'Legendary Creature — Bird Serpent', { cmc: 5 })
    expect(companionDeckSizeBonus(yorion)).toBe(20)
    expect(validateCompanion(yorion, [yorion, card('Bolt', 'Instant', { cmc: 1 })]).ok).toBe(true)
  })
})

describe('Oathbreaker', () => {
  const jace = card('Jace, the Mind Sculptor', 'Legendary Planeswalker — Jace', { color_identity: ['U'] })
  const brainstorm = card('Brainstorm', 'Instant', { color_identity: ['U'] })
  const bolt = card('Lightning Bolt', 'Instant', { color_identity: ['R'] })

  it('classifies oathbreaker + signature spell', () => {
    expect(isOathbreaker(jace)).toBe(true)
    expect(isSignatureSpell(brainstorm)).toBe(true)
    expect(isOathbreaker(brainstorm)).toBe(false)
  })

  it('accepts a planeswalker + in-identity spell', () => {
    expect(getOathbreakerPairIssue([jace, brainstorm])).toBeNull()
  })

  it('rejects a spell outside the oathbreaker identity', () => {
    expect(getOathbreakerPairIssue([jace, bolt])).toMatch(/color identity/i)
  })

  it('rejects a creature in the command zone', () => {
    expect(getOathbreakerPairIssue([card('Bear', 'Creature', {})])).toMatch(/planeswalker/i)
  })

  it('rejects a signature spell with no oathbreaker', () => {
    expect(getOathbreakerPairIssue([brainstorm])).toMatch(/needs an Oathbreaker/i)
  })

  it('rejects two planeswalkers', () => {
    expect(getOathbreakerPairIssue([jace, card('Teferi', 'Legendary Planeswalker — Teferi', {})])).toMatch(/only one planeswalker/i)
  })
})

describe('cardTypes', () => {
  it('extracts the left-of-dash types', () => {
    expect([...cardTypes({ type_line: 'Legendary Artifact Creature — Golem' })]).toEqual(['legendary', 'artifact', 'creature'])
  })
})

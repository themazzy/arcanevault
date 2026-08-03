import { describe, it, expect } from 'vitest'
import {
  makeRng, shuffled, isLand, isManaRock, drawOpening,
  simulateGame, goldfishDeck, KEEP_MIN_LANDS, KEEP_MAX_LANDS,
} from './goldfish'

const land = (n = 'Forest') => ({ name: n, type_line: 'Basic Land — Forest', cmc: 0 })
const spell = (cmc, n = `Spell ${cmc}`) => ({ name: n, type_line: 'Sorcery', cmc })
const rock = (cmc = 2) => ({ name: 'Signet', type_line: 'Artifact', cmc, oracle_text: '{T}: Add {C}{C}.' })

// A plausible 99: 37 lands, 10 rocks, spread of spells.
const deck = (lands = 37) => [
  ...Array.from({ length: lands }, (_, i) => land(`Land ${i}`)),
  ...Array.from({ length: 10 }, () => rock()),
  ...Array.from({ length: 99 - lands - 10 }, (_, i) => spell((i % 5) + 1, `S${i}`)),
]

describe('rng determinism', () => {
  // An A/B where the arms get different shuffles measures luck, not decks.
  it('produces the same sequence for the same seed', () => {
    const a = Array.from({ length: 5 }, makeRng(7))
    const r1 = makeRng(7), r2 = makeRng(7)
    expect(Array.from({ length: 5 }, r1)).toEqual(Array.from({ length: 5 }, r2))
    expect(a.length).toBe(5)
  })

  it('shuffles without losing or duplicating cards', () => {
    const d = deck()
    const s = shuffled(d, makeRng(3))
    expect(s).toHaveLength(d.length)
    expect(new Set(s).size).toBe(new Set(d).size)
  })
})

describe('card facts', () => {
  it('identifies lands off the type line', () => {
    expect(isLand(land())).toBe(true)
    expect(isLand(spell(3))).toBe(false)
  })
  it('identifies mana rocks but not lands or plain spells', () => {
    expect(isManaRock(rock())).toBe(true)
    expect(isManaRock(land())).toBe(false)
    expect(isManaRock(spell(3))).toBe(false)
  })
})

describe('drawOpening', () => {
  it('keeps a hand in the workable land range when it can', () => {
    const { hand } = drawOpening(deck(), makeRng(11))
    const lands = hand.filter(isLand).length
    expect(lands).toBeGreaterThanOrEqual(KEEP_MIN_LANDS)
    expect(lands).toBeLessThanOrEqual(KEEP_MAX_LANDS)
  })

  it('bottoms a card per mulligan taken', () => {
    // An all-land deck can never be in range, so it mulligans to the cap.
    const allLand = Array.from({ length: 99 }, (_, i) => land(`L${i}`))
    const { hand, mulligans } = drawOpening(allLand, makeRng(5))
    expect(mulligans).toBeGreaterThan(0)
    expect(hand.length).toBe(7 - mulligans)
  })
})

describe('simulateGame', () => {
  it('plays a land per turn while it has them', () => {
    const r = simulateGame({ deck: deck(), commanderCmc: 4, turns: 6, rng: makeRng(2) })
    expect(r.landsByTurn[5]).toBeGreaterThan(r.landsByTurn[0])
    expect(r.landsByTurn[5]).toBeLessThanOrEqual(6)
  })

  it('casts the commander once it has the mana', () => {
    const r = simulateGame({ deck: deck(), commanderCmc: 3, turns: 8, rng: makeRng(4) })
    expect(r.commanderTurn).not.toBeNull()
    expect(r.commanderTurn).toBeLessThanOrEqual(8)
  })

  it('never casts an uncastably expensive commander inside the window', () => {
    const r = simulateGame({ deck: deck(), commanderCmc: 40, turns: 6, rng: makeRng(4) })
    expect(r.commanderTurn).toBeNull()
  })

  it('counts missed land drops on a land-light deck', () => {
    const light = simulateGame({ deck: deck(12), commanderCmc: 4, turns: 8, rng: makeRng(9) })
    const heavy = simulateGame({ deck: deck(45), commanderCmc: 4, turns: 8, rng: makeRng(9) })
    expect(light.missedLandDrops).toBeGreaterThan(heavy.missedLandDrops)
  })
})

// The whole point: these are simulation outputs, so they can disagree with the
// rest of the project rather than agreeing with it by construction.
describe('goldfishDeck', () => {
  it('returns null for an empty deck', () => {
    expect(goldfishDeck({ deck: [] })).toBeNull()
  })

  it('is deterministic for a given seed', () => {
    const a = goldfishDeck({ deck: deck(), commanderCmc: 4, games: 50, seed: 1 })
    const b = goldfishDeck({ deck: deck(), commanderCmc: 4, games: 50, seed: 1 })
    expect(a).toEqual(b)
  })

  it('rates a land-light deck worse than a sensible one', () => {
    const good = goldfishDeck({ deck: deck(37), commanderCmc: 4, games: 200, seed: 8 })
    const light = goldfishDeck({ deck: deck(14), commanderCmc: 4, games: 200, seed: 8 })
    expect(light.screwedPct).toBeGreaterThan(good.screwedPct)
    expect(light.commanderByT5Pct).toBeLessThan(good.commanderByT5Pct)
  })

  // Flood is lands stuck in HAND. Lands in play can never exceed the turn
  // number, so the obvious version of this metric measures nothing at all.
  it('rates a land-flooded deck as flooded', () => {
    const good = goldfishDeck({ deck: deck(37), commanderCmc: 4, games: 200, seed: 8 })
    const flood = goldfishDeck({ deck: deck(70), commanderCmc: 4, games: 200, seed: 8 })
    expect(flood.floodedPct).toBeGreaterThan(good.floodedPct)
  })

  it('casts a cheap commander earlier than an expensive one', () => {
    const cheap = goldfishDeck({ deck: deck(), commanderCmc: 2, games: 200, seed: 6 })
    const dear = goldfishDeck({ deck: deck(), commanderCmc: 7, games: 200, seed: 6 })
    expect(cheap.avgCommanderTurn).toBeLessThan(dear.avgCommanderTurn)
  })
})

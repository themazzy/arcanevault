import { describe, it, expect } from 'vitest'
import {
  makeRng, shuffled, isLand, isManaRock, landsPutIntoPlay, extraLandDrops, drawOpening,
  producedColors, colorRequirements, colorsAvailable,
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


// Ramp does not go through the land drop, and extra-drop effects raise the cap
// outright — so lands in play routinely exceeds the turn number. Modelling only
// one drop per turn understated mana development for every deck the assistant
// builds, since the role template targets ~11 ramp.
describe('land ramp', () => {
  const ramp = (o, n = 'Ramp') => ({ name: n, type_line: 'Sorcery', cmc: 2, oracle_text: o })

  it('counts lands fetched onto the battlefield', () => {
    expect(landsPutIntoPlay(ramp('Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.'))).toBe(1)
    expect(landsPutIntoPlay(ramp('Search your library for up to two Forest cards, put them onto the battlefield, then shuffle.'))).toBe(2)
  })

  it('does not count a land fetched to HAND', () => {
    expect(landsPutIntoPlay(ramp('Search your library for a basic land card, reveal it, put it into your hand, then shuffle.'))).toBe(0)
  })

  it('does not count lands themselves', () => {
    expect(landsPutIntoPlay(land())).toBe(0)
  })

  it('reads extra land drops', () => {
    expect(extraLandDrops({ oracle_text: 'You may play an additional land on each of your turns.' })).toBe(1)
    expect(extraLandDrops({ oracle_text: 'You may play two additional lands on each of your turns.' })).toBe(2)
    expect(extraLandDrops({ oracle_text: '{T}: Add {C}.' })).toBe(0)
  })

  // The correction that prompted all of this: with ramp in the deck, lands in
  // play outruns the turn count, which the old model made impossible.
  it('lets lands in play exceed the turn number', () => {
    const rampDeck = [
      ...Array.from({ length: 30 }, (_, i) => land(`L${i}`)),
      ...Array.from({ length: 69 }, () =>
        ramp('Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.')),
    ]
    const r = simulateGame({ deck: rampDeck, commanderCmc: 4, turns: 6, rng: makeRng(3) })
    expect(r.landsByTurn[5]).toBeGreaterThan(6)
  })

  it('gives a ramp deck more mana on turn 5 than a rampless one', () => {
    const base = deck()
    const withRamp = [
      ...Array.from({ length: 37 }, (_, i) => land(`L${i}`)),
      ...Array.from({ length: 62 }, () =>
        ramp('Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.')),
    ]
    const a = goldfishDeck({ deck: base, commanderCmc: 4, games: 200, seed: 21 })
    const b = goldfishDeck({ deck: withRamp, commanderCmc: 4, games: 200, seed: 21 })
    expect(b.avgManaT5).toBeGreaterThan(a.avgManaT5)
  })
})


// Without colour the simulation scored a greedy five-colour manabase exactly as
// well as a clean two-colour one — it could not see the most common way a real
// deck fails, which is having the mana but not the right mana.
describe('colour', () => {
  const basic = (sub, col) => ({ name: sub, type_line: `Basic Land — ${sub}`, cmc: 0, oracle_text: `({T}: Add {${col}}.)` })
  const forest = () => basic('Forest', 'G')
  const island = () => basic('Island', 'U')

  it('reads colours off basic land types', () => {
    expect([...producedColors(forest())]).toEqual(['G'])
    expect([...producedColors(island())]).toEqual(['U'])
  })

  it('reads colours from an add clause', () => {
    expect([...producedColors({ type_line: 'Land', oracle_text: '{T}: Add {B} or {R}.' })].sort()).toEqual(['B', 'R'])
  })

  it('treats any-colour sources as all five', () => {
    expect(producedColors({ type_line: 'Land', oracle_text: '{T}: Add one mana of any color.' }).size).toBe(5)
  })

  it('reads pips from a real mana cost', () => {
    expect(colorRequirements({ mana_cost: '{2}{B}{B}{G}' })).toEqual({ B: 2, G: 1 })
  })

  // Hybrid and Phyrexian pips are payable another way, so they set no hard
  // requirement — the same rule karstenColorRequirements uses.
  it('ignores hybrid and generic pips', () => {
    expect(colorRequirements({ mana_cost: '{2}{W/U}{G/P}' })).toEqual({})
  })

  it('falls back to colour identity when no cost was exported', () => {
    expect(colorRequirements({ color_identity: ['B', 'G'] })).toEqual({ B: 1, G: 1 })
  })

  it('gates on available sources', () => {
    expect(colorsAvailable({ B: 2 }, { B: 2 })).toBe(true)
    expect(colorsAvailable({ B: 2 }, { B: 1 })).toBe(false)
    expect(colorsAvailable({}, {})).toBe(true)
  })

  // The headline: a deck whose lands cannot produce its commander's colours
  // should fail to cast it, where the colourless model happily cast it on time.
  it('cannot cast a commander it has no colours for', () => {
    const monoGreenLands = [
      ...Array.from({ length: 40 }, forest),
      ...Array.from({ length: 59 }, (_, i) => ({ name: `S${i}`, type_line: 'Sorcery', cmc: 2, mana_cost: '{1}{G}' })),
    ]
    const castable = goldfishDeck({
      deck: monoGreenLands, commanderCmc: 3, commanderColors: { G: 1 }, games: 100, seed: 4,
    })
    const uncastable = goldfishDeck({
      deck: monoGreenLands, commanderCmc: 3, commanderColors: { U: 2 }, games: 100, seed: 4,
    })
    expect(castable.commanderByT5Pct).toBeGreaterThan(50)
    expect(uncastable.commanderByT5Pct).toBe(0)
    expect(uncastable.colorStuckPct).toBeGreaterThan(0)
  })

  it('rates a split manabase worse than a focused one for a colour-hungry deck', () => {
    const spells = Array.from({ length: 62 }, (_, i) => ({ name: `S${i}`, type_line: 'Sorcery', cmc: 3, mana_cost: '{1}{G}{G}' }))
    const focused = [...Array.from({ length: 37 }, forest), ...spells]
    const split = [
      ...Array.from({ length: 19 }, forest), ...Array.from({ length: 18 }, island), ...spells,
    ]
    const a = goldfishDeck({ deck: focused, commanderCmc: 4, commanderColors: { G: 2 }, games: 200, seed: 12 })
    const b = goldfishDeck({ deck: split, commanderCmc: 4, commanderColors: { G: 2 }, games: 200, seed: 12 })
    expect(b.commanderByT5Pct).toBeLessThan(a.commanderByT5Pct)
  })
})

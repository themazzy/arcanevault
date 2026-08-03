import { describe, it, expect } from 'vitest'
import {
  extractCommanderKeywords,
  synergyScore,
  deckKeywordProfile,
  deckAffinity,
  extractTribe,
  SYNERGY_CONCEPTS,
} from './commanderSynergy'

// Verbatim Scryfall oracle text. Korvold is used as the primary fixture because
// it is structurally the same commander the source video builds around: an
// enters/attacks trigger that sacrifices, paying off in +1/+1 counters and draw.
const C = {
  korvold: {
    type: 'Legendary Creature — Dragon Noble',
    text: 'Flying\nWhenever Korvold enters or attacks, sacrifice another permanent.\nWhenever you sacrifice a permanent, put a +1/+1 counter on Korvold and draw a card.',
  },
  talrand: {
    type: 'Legendary Creature — Merfolk Wizard',
    text: 'Whenever you cast an instant or sorcery spell, create a 2/2 blue Drake creature token with flying.',
  },
  meren: {
    type: 'Legendary Creature — Human Shaman',
    text: "Whenever another creature you control dies, you get an experience counter.\nAt the beginning of your end step, choose target creature card in your graveyard. If that card's mana value is less than or equal to the number of experience counters you have, return it to the battlefield. Otherwise, put it into your hand.",
  },
  krenko: {
    type: 'Legendary Creature — Goblin Warrior',
    text: '{T}: Create X 1/1 red Goblin creature tokens, where X is the number of Goblins you control.',
  },
}

const CARD = {
  skullclamp: {
    type: 'Artifact — Equipment',
    text: 'Equipped creature gets +1/-1.\nWhenever equipped creature dies, draw two cards.\nEquip {1}',
  },
  bloodArtist: {
    type: 'Creature — Vampire',
    text: 'Whenever this creature or another creature dies, target player loses 1 life and you gain 1 life.',
  },
  ashnodsAltar: { type: 'Artifact', text: 'Sacrifice a creature: Add {C}{C}.' },
  gravePact: {
    type: 'Enchantment',
    text: 'Whenever a creature you control dies, each other player sacrifices a creature of their choice.',
  },
  bitterblossom: {
    type: 'Kindred Enchantment — Faerie',
    text: 'At the beginning of your upkeep, you lose 1 life and create a 1/1 black Faerie Rogue creature token with flying.',
  },
  panharmonicon: {
    type: 'Artifact',
    text: 'If an artifact or creature entering causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.',
  },
  doublingSeason: {
    type: 'Enchantment',
    text: 'If an effect would create one or more tokens under your control, it creates twice that many of those tokens instead.\nIf an effect would put one or more counters on a permanent you control, it puts twice that many of those counters on that permanent instead.',
  },
  counterspell: { type: 'Instant', text: 'Counter target spell.' },
  cultivate: {
    type: 'Sorcery',
    text: 'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.',
  },
  eternalWitness: {
    type: 'Creature — Human Shaman',
    text: 'When this creature enters, you may return target card from your graveyard to your hand.',
  },
  sakuraTribeElder: {
    type: 'Creature — Snake Shaman',
    text: 'Sacrifice this creature: Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.',
  },
}

const kw = key => extractCommanderKeywords(C[key].text, C[key].type)
const score = (cardKey, commanderKey) =>
  synergyScore(CARD[cardKey].text, CARD[cardKey].type, kw(commanderKey))

describe('extractCommanderKeywords', () => {
  it('pulls the mechanical hooks out of Korvold', () => {
    const k = kw('korvold')
    expect(k.has('etb')).toBe(true)
    expect(k.has('attack')).toBe(true)
    expect(k.has('sacrifice')).toBe(true)
    expect(k.has('counters')).toBe(true)
    expect(k.has('draw')).toBe(true)
  })

  it('does not invent hooks the commander never names', () => {
    const k = kw('korvold')
    expect(k.has('landfall')).toBe(false)
    expect(k.has('spellcast')).toBe(false)
    expect(k.has('counterspell')).toBe(false)
  })

  it('reads a spellslinger commander', () => {
    const k = kw('talrand')
    expect(k.has('spellcast')).toBe(true)
    expect(k.has('tokens')).toBe(true)
  })

  it('reads a graveyard commander', () => {
    const k = kw('meren')
    expect(k.has('sacrifice')).toBe(true) // "dies"
    expect(k.has('graveyard')).toBe(true)
  })

  it('returns nothing for empty text rather than throwing', () => {
    expect(extractCommanderKeywords('', '').size).toBe(0)
    expect(extractCommanderKeywords(undefined, undefined).size).toBe(0)
  })

  // A commander that is itself an artifact creature must not pick up the
  // 'artifacts' hook from its type line — cardType describes candidates only.
  it('ignores cardType on the commander side', () => {
    const k = extractCommanderKeywords('Flying', 'Legendary Artifact Creature — Golem')
    expect(k.has('artifacts')).toBe(false)
  })
})

describe('synergyScore', () => {
  it('scores a card that hits several of the commander hooks highest', () => {
    // Skullclamp: dies (sacrifice) + draw + equipment — a genuine Korvold staple.
    const clamp = score('skullclamp', 'korvold')
    const bolt = score('counterspell', 'korvold')
    expect(clamp.matched).toContain('sacrifice')
    expect(clamp.matched).toContain('draw')
    expect(clamp.score).toBeGreaterThan(bolt.score)
  })

  it('gives an unrelated card no score at all', () => {
    expect(score('counterspell', 'korvold').score).toBe(0)
    expect(score('cultivate', 'korvold').score).toBe(0)
  })

  it('surfaces human-readable reasons for a card tile', () => {
    const { labels } = score('bloodArtist', 'korvold')
    expect(labels).toContain('sacrifice')
    expect(labels.length).toBeGreaterThan(0)
  })

  // The transcript's key asymmetry: a token-maker is a sacrifice card even
  // though its rules text never says "sacrifice".
  it('credits an enabler that feeds a hook without naming it', () => {
    const bb = score('bitterblossom', 'korvold')
    expect(bb.matched).toContain('sacrifice')
    expect(bb.score).toBeGreaterThan(0)
  })

  // This used to assert the opposite — that being an instant was enough to
  // count as Talrand synergy. Measured across 51 commanders that rule was
  // indiscriminate: it fired on every instant and sorcery in the pool, which
  // says nothing about whether a card is a GOOD Talrand card. EDHREC's
  // empirical synergy figure covers this case properly (it ranks Opt and
  // Preordain far above a generic removal spell) and this concept no longer
  // tries to.
  it('does not credit a card merely for being the right TYPE', () => {
    const cs = score('counterspell', 'talrand')
    expect(cs.matched).not.toContain('spellcast')
  })

  it('scores narrow hooks higher than broad ones', () => {
    const narrow = SYNERGY_CONCEPTS.find(c => c.id === 'sacrifice')
    const broad = SYNERGY_CONCEPTS.find(c => c.id === 'draw')
    expect(narrow.weight).toBeGreaterThan(broad.weight)
  })

  it('ranks real Korvold cards above real non-Korvold cards', () => {
    const good = ['ashnodsAltar', 'gravePact', 'bloodArtist', 'skullclamp']
      .map(k => score(k, 'korvold').score)
    const bad = ['counterspell', 'cultivate'].map(k => score(k, 'korvold').score)
    expect(Math.min(...good)).toBeGreaterThan(Math.max(...bad))
  })

  it('catches an ETB doubler for an enters-triggered commander', () => {
    expect(score('panharmonicon', 'korvold').matched).toContain('etb')
  })

  // Found by comparing two real auto-filled Hei Bai decks: Teysa Karlov is the
  // premier death-trigger doubler and scored ZERO hooks, because her text says
  // "a creature dying" and never "dies". Gerunds are how doublers are templated.
  it('catches a death-trigger doubler that only says "dying"', () => {
    const teysa = synergyScore(
      'If a creature dying causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.\nCreature tokens you control have vigilance and lifelink.',
      'Legendary Creature — Human Advisor',
      kw('korvold'),
    )
    expect(teysa.matched).toContain('sacrifice')
    expect(teysa.score).toBeGreaterThan(0)
  })

  it('catches "sacrificing" as well as "sacrifice"', () => {
    const r = synergyScore('Whenever you sacrificing a permanent, draw a card.', 'Enchantment', kw('korvold'))
    expect(r.matched).toContain('sacrifice')
  })

  it('catches a counter doubler for a counters commander', () => {
    expect(score('doublingSeason', 'korvold').matched).toContain('counters')
  })

  it('returns zero when the commander has no keywords', () => {
    expect(synergyScore(CARD.skullclamp.text, CARD.skullclamp.type, new Set()).score).toBe(0)
  })

  it('handles a candidate with no cached oracle text', () => {
    const r = synergyScore('', '', kw('korvold'))
    expect(r.score).toBe(0)
    expect(r.matched).toEqual([])
  })
})

describe('deckKeywordProfile + deckAffinity', () => {
  const deck = [
    { oracle: CARD.ashnodsAltar.text, type: CARD.ashnodsAltar.type },
    { oracle: CARD.gravePact.text, type: CARD.gravePact.type },
    { oracle: CARD.bloodArtist.text, type: CARD.bloodArtist.type },
  ]

  it('counts how many deck cards touch each concept', () => {
    const p = deckKeywordProfile(deck)
    expect(p.get('sacrifice')).toBe(3)
  })

  it('rewards a candidate that reinforces what the deck already does', () => {
    const p = deckKeywordProfile(deck)
    const sacCard = synergyScore(CARD.sakuraTribeElder.text, CARD.sakuraTribeElder.type, kw('korvold'))
    expect(deckAffinity(sacCard.matched, p)).toBeGreaterThan(0)
  })

  it('is zero for an empty deck', () => {
    expect(deckAffinity(['sacrifice'], new Map())).toBe(0)
  })

  it('saturates so an already-deep theme stops attracting more', () => {
    const deep = Array.from({ length: 40 }, () => ({ oracle: CARD.gravePact.text, type: 'Enchantment' }))
    const p = deckKeywordProfile(deep)
    expect(deckAffinity(['sacrifice'], p)).toBe(1) // capped, not 40/8
  })
})

// Tribal was the biggest hole in this vocabulary: measured across 51 commanders
// it moved 0.25 percentage points on tribal decks, because there was no
// creature-type concept at all. Edgar Markov read as tokens/attack/counters
// with nothing about Vampires.
describe('extractTribe', () => {
  it('reads the tribe off a tribal commander', () => {
    expect(extractTribe(
      'Eminence — Whenever you cast another Vampire spell, if Edgar Markov is in the command zone or on the battlefield, create a 1/1 black Vampire creature token.\nFirst strike\nWhenever Edgar Markov attacks, put a +1/+1 counter on each Vampire you control.',
      'Legendary Creature — Vampire Knight',
    )).toBe('vampire')
  })

  it('reads a tribe the commander is not itself a member of', () => {
    expect(extractTribe(
      'Whenever Gishath, Sun\'s Avatar deals combat damage to a player, look at that many cards from the top of your library. Put any number of Dinosaur creature cards from among them onto the battlefield.',
      'Legendary Creature — Dinosaur Avatar',
    )).toBe('dinosaur')
  })

  it('returns null for a non-tribal commander', () => {
    expect(extractTribe(
      'Whenever Korvold enters or attacks, sacrifice another permanent.\nWhenever you sacrifice a permanent, put a +1/+1 counter on Korvold and draw a card.',
      'Legendary Creature — Dragon Noble',
    )).toBe(null)
  })

  // Nearly every legendary creature is a Human something; treating that as a
  // tribe would make most decks read as Human tribal.
  it('ignores generic creature types', () => {
    expect(extractTribe('Whenever another Human you control enters, draw a card.', 'Legendary Creature — Human Wizard'))
      .not.toBe('human')
  })

  it('handles empty input', () => {
    expect(extractTribe('', '')).toBe(null)
  })
})

describe('synergyScore — tribal', () => {
  const tribe = 'vampire'
  it('scores a card that IS the tribe', () => {
    const r = synergyScore('Flying', 'Creature — Vampire Noble', new Set(), tribe)
    expect(r.matched).toContain('tribe')
    expect(r.labels).toContain('vampires')
  })

  it('scores a card that CARES about the tribe', () => {
    const r = synergyScore('Other Vampires you control get +1/+1.', 'Creature — Human Cleric', new Set(), tribe)
    expect(r.matched).toContain('tribe')
  })

  it('does not score an unrelated card', () => {
    expect(synergyScore('Draw two cards.', 'Sorcery', new Set(), tribe).score).toBe(0)
  })
})

// These used to carry cardType regexes that fired on every artifact /
// enchantment / instant in the pool — a type filter masquerading as synergy.
describe('type-based concepts are no longer indiscriminate', () => {
  it('does not tag a plain artifact as artifact synergy', () => {
    const kw = extractCommanderKeywords('Whenever an artifact you control enters, draw a card.', 'Legendary Creature')
    expect(kw.has('artifacts')).toBe(true)
    const plain = synergyScore('{T}: Add {C}{C}.', 'Artifact', kw)
    expect(plain.matched).not.toContain('artifacts')
  })

  it('still tags an artifact that talks about artifacts', () => {
    const kw = extractCommanderKeywords('Whenever an artifact you control enters, draw a card.', 'Legendary Creature')
    const real = synergyScore('Whenever another artifact enters, create a Thopter.', 'Artifact', kw)
    expect(real.matched).toContain('artifacts')
  })
})

// Found by the step-0 engine sweep: deriving the tribe from sentence position
// alone read non-types as tribes and demanded 25 of each from real decks.
describe('extractTribe — creature-type whitelist', () => {
  it('does not read "land" as a tribe', () => {
    expect(extractTribe(
      'Whenever a land you control is put into a graveyard from the battlefield, you may sacrifice a land card.',
      'Legendary Creature — Cat Warrior',
    )).not.toBe('land')
  })

  it('does not read "cast" or "spell" as a tribe', () => {
    expect(extractTribe(
      'You may cast spells from that player\'s hand. Whenever you cast a spell card this way, draw a card.',
      'Legendary Creature — Human Wizard',
    )).toBe(null)
  })

  it('does not read "equipped" as a tribe', () => {
    expect(extractTribe(
      'Equipped creature gets +1/+0. Whenever an Equipment you control becomes attached to a creature, draw a card.',
      'Legendary Creature — God',
    )).not.toBe('equipped')
  })

  it('still finds a real tribe', () => {
    expect(extractTribe('Whenever you cast another Vampire spell, create a Vampire creature token.', 'Legendary Creature — Vampire Knight')).toBe('vampire')
  })
})

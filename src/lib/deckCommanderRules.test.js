import { describe, it, expect } from 'vitest'
import {
  getCardCommanderRules,
  getCommanderRuleContext,
  offColorIdentity,
  explainExemption,
  parseRulebreakerClause,
  sanitizeColors,
} from './deckCommanderRules'

// Oracle text exactly as printed in Mystery Booster Commander Edition.
const GRIZZLEGOM = {
  name: 'Grizzlegom, Hurloon Hero',
  type_line: 'Legendary Creature — Minotaur Warrior',
  color_identity: ['G', 'R'],
  oracle_text: 'Rulebreaker — A deck with this commander can have any land cards.\nWhenever Grizzlegom attacks, create a 1/1 white Soldier creature token for each Plains you control.',
}
const MAULAR = {
  name: 'Maular, the Next Evolution',
  type_line: 'Legendary Creature — Dinosaur Mutant',
  color_identity: ['G'],
  oracle_text: 'Rulebreaker — A deck with this commander can have creature cards with mana value 7 or greater of any color identity and any basic land cards.\nWhenever a creature you control with mana value 7 or greater attacks, double its power and toughness until end of turn.',
}
const SELUMA = {
  name: 'Seluma, Light of Aysen',
  type_line: 'Legendary Creature — Angel Warrior',
  color_identity: ['W'],
  oracle_text: 'Rulebreaker — A deck with this commander can have Angel cards of any color identity and any basic land cards.\nFlying',
}
const EVERFORGER = {
  name: 'The Everforger',
  type_line: 'Legendary Artifact Creature — Construct',
  color_identity: [],
  oracle_text: 'Rulebreaker — A deck with this commander can have artifact creature and Equipment cards of any color identity and any basic land cards.',
}
const UNLUCKIEST = {
  name: 'The Unluckiest Planeswalker',
  type_line: 'Legendary Planeswalker',
  color_identity: ['R'],
  oracle_text: 'Rulebreaker — A deck with this commander can have Aura cards of any color identity and any basic land cards.\nThe Unluckiest Planeswalker can be your commander.',
}
const VALKO = {
  name: 'Valko Indorian',
  type_line: 'Legendary Creature — Human Wizard',
  color_identity: ['B'],
  oracle_text: 'Rulebreaker — A deck with this commander can have Phyrexian cards of any color identity and any basic land cards.\nPhyrexian creatures you control have menace and lifelink.',
}
const TOLABOW = {
  name: 'Tolabow, Loch Rascal',
  type_line: 'Legendary Creature — Otter',
  color_identity: ['U'],
  oracle_text: "Rulebreaker — If Tolabow, Loch Rascal is your commander, the color identity of instant and sorcery cards in your deck can include one color of your choice not in your commander's color identity, and your deck can have any basic land cards.",
}
const WHTZ = {
  name: 'Whtz, the Bibliophile',
  type_line: 'Legendary Creature — Homunculus',
  color_identity: ['U', 'W'],
  oracle_text: 'Rulebreaker — A deck with this commander has no maximum deck size.\n{3}, {T}: You draw a card and gain 1 life.',
}

// Deck cards used as probes.
const swamp        = { name: 'Swamp', type_line: 'Basic Land — Swamp', color_identity: ['B'] }
const snowSwamp    = { name: 'Snow-Covered Swamp', type_line: 'Basic Snow Land — Swamp', color_identity: ['B'] }
const badlands     = { name: 'Badlands', type_line: 'Land — Swamp Mountain', color_identity: ['B', 'R'] }
const bolt         = { name: 'Lightning Bolt', type_line: 'Instant', color_identity: ['R'] }
const push         = { name: 'Fatal Push', type_line: 'Instant', color_identity: ['B'] }
const ponder       = { name: 'Ponder', type_line: 'Sorcery', color_identity: ['U'] }
const baneslayer   = { name: 'Baneslayer Angel', type_line: 'Creature — Angel', color_identity: ['W'] }
const razaketh     = { name: 'Razaketh, the Foulblooded', type_line: 'Legendary Creature — Demon', color_identity: ['B'], cmc: 8 }
const griselbrand  = { name: 'Griselbrand', type_line: 'Legendary Creature — Demon', color_identity: ['B'], cmc: 8 }
const shivanAngel  = { name: 'Aurelia, the Warleader', type_line: 'Legendary Creature — Angel', color_identity: ['R', 'W'], cmc: 6 }
const wurmcoil     = { name: 'Wurmcoil Engine', type_line: 'Artifact Creature — Phyrexian Wurm', color_identity: [], cmc: 6 }
const solRing      = { name: 'Sol Ring', type_line: 'Artifact', color_identity: [], cmc: 1 }
const swordFP      = { name: 'Sword of Feast and Famine', type_line: 'Artifact — Equipment', color_identity: [], cmc: 3 }
const batterskull  = { name: 'Batterskull', type_line: 'Artifact — Equipment', color_identity: [], cmc: 5 }
const skullclamp   = { name: 'Skullclamp', type_line: 'Artifact — Equipment', color_identity: [], cmc: 1 }
const rancor       = { name: 'Rancor', type_line: 'Enchantment — Aura', color_identity: ['G'], cmc: 1 }
const phyrexianArena = { name: 'Phyrexian Arena', type_line: 'Enchantment', color_identity: ['B'], cmc: 3 }
const gitaxian     = { name: 'Gitaxian Probe', type_line: 'Sorcery', color_identity: ['U'], cmc: 0 }
const solemn       = { name: 'Solemn Simulacrum', type_line: 'Artifact Creature — Golem', color_identity: [], cmc: 4 }

const ctxFor = (commander, chosenColors) =>
  getCommanderRuleContext({ commanders: [commander], chosenColors })

describe('parseRulebreakerClause', () => {
  it('ignores text with no Rulebreaker clause', () => {
    expect(getCardCommanderRules({ name: 'Sol Ring', oracle_text: '{T}: Add {C}{C}.' })).toEqual([])
    expect(parseRulebreakerClause('')).toBe(null)
    expect(parseRulebreakerClause('Flying, trample')).toBe(null)
  })

  it('parses each printed MBC clause into exactly one rule', () => {
    for (const card of [GRIZZLEGOM, MAULAR, SELUMA, EVERFORGER, UNLUCKIEST, VALKO, TOLABOW, WHTZ]) {
      expect(getCardCommanderRules(card), card.name).toHaveLength(1)
    }
  })

  it('reads a Rulebreaker clause off a double-faced back face', () => {
    const dfc = {
      name: 'Hypothetical Rulebreaker',
      card_faces: [
        { type_line: 'Legendary Creature — Angel', oracle_text: 'Flying' },
        { type_line: 'Legendary Creature — Demon', oracle_text: 'Rulebreaker — A deck with this commander can have Angel cards of any color identity.' },
      ],
    }
    expect(getCardCommanderRules(dfc)).toHaveLength(1)
  })
})

describe('offColorIdentity without a rulebreaker', () => {
  it('matches the plain Commander rule', () => {
    expect(offColorIdentity(bolt, ['W'])).toEqual(['R'])
    expect(offColorIdentity(bolt, ['R', 'W'])).toEqual([])
    expect(offColorIdentity(solRing, ['W'])).toEqual([])
  })

  it('is unchanged by an inactive context', () => {
    const ctx = getCommanderRuleContext({ commanders: [{ name: 'Sol Ring', oracle_text: '' }] })
    expect(ctx.active).toBe(false)
    expect(offColorIdentity(bolt, ['W'], ctx)).toEqual(['R'])
  })
})

describe('Grizzlegom — any land cards', () => {
  const ctx = ctxFor(GRIZZLEGOM)

  it('allows off-color nonbasic and basic lands alike', () => {
    expect(offColorIdentity(badlands, ['G', 'R'], ctx)).toEqual([])
    expect(offColorIdentity(swamp, ['G', 'R'], ctx)).toEqual([])
  })

  it('still restricts nonland cards', () => {
    expect(offColorIdentity(push, ['G', 'R'], ctx)).toEqual(['B'])
    expect(offColorIdentity(baneslayer, ['G', 'R'], ctx)).toEqual(['W'])
  })
})

describe('Maular — big creatures of any identity', () => {
  const ctx = ctxFor(MAULAR)

  it('allows off-color creatures at mana value 7 or greater', () => {
    expect(offColorIdentity(razaketh, ['G'], ctx)).toEqual([])
    expect(offColorIdentity(griselbrand, ['G'], ctx)).toEqual([])
  })

  it('rejects off-color creatures below mana value 7', () => {
    expect(offColorIdentity(shivanAngel, ['G'], ctx)).toEqual(['R', 'W'])
    expect(offColorIdentity(baneslayer, ['G'], ctx)).toEqual(['W'])
  })

  it('rejects an off-color noncreature however expensive', () => {
    expect(offColorIdentity({ ...phyrexianArena, cmc: 9 }, ['G'], ctx)).toEqual(['B'])
  })

  it('allows basic lands but not off-color nonbasics', () => {
    expect(offColorIdentity(swamp, ['G'], ctx)).toEqual([])
    expect(offColorIdentity(snowSwamp, ['G'], ctx)).toEqual([])
    expect(offColorIdentity(badlands, ['G'], ctx)).toEqual(['B', 'R'])
  })
})

describe('Seluma — Angel cards of any identity', () => {
  const ctx = ctxFor(SELUMA)

  it('allows off-color Angels', () => {
    expect(offColorIdentity(shivanAngel, ['W'], ctx)).toEqual([])
    expect(offColorIdentity(baneslayer, ['W'], ctx)).toEqual([])
  })

  it('rejects off-color non-Angels', () => {
    expect(offColorIdentity(bolt, ['W'], ctx)).toEqual(['R'])
    expect(offColorIdentity(rancor, ['W'], ctx)).toEqual(['G'])
  })
})

describe('The Everforger — artifact creatures and Equipment', () => {
  const ctx = ctxFor(EVERFORGER)

  it('exempts artifact creatures and Equipment regardless of the colorless commander', () => {
    expect(offColorIdentity({ ...wurmcoil, color_identity: ['B'] }, [], ctx)).toEqual([])
    expect(offColorIdentity({ ...batterskull, color_identity: ['W'] }, [], ctx)).toEqual([])
    expect(offColorIdentity({ ...skullclamp, color_identity: ['R'] }, [], ctx)).toEqual([])
    expect(offColorIdentity({ ...swordFP, color_identity: ['B', 'G'] }, [], ctx)).toEqual([])
  })

  it('does not exempt a plain artifact or a nonartifact creature', () => {
    expect(offColorIdentity({ ...solRing, color_identity: ['G'] }, [], ctx)).toEqual(['G'])
    expect(offColorIdentity(baneslayer, [], ctx)).toEqual(['W'])
  })

  it('leaves genuinely colorless artifacts legal either way', () => {
    expect(offColorIdentity(solemn, [], ctx)).toEqual([])
  })
})

describe('The Unluckiest Planeswalker — Aura cards', () => {
  const ctx = ctxFor(UNLUCKIEST)

  it('exempts Auras only', () => {
    expect(offColorIdentity(rancor, ['R'], ctx)).toEqual([])
    expect(offColorIdentity(phyrexianArena, ['R'], ctx)).toEqual(['B'])
  })
})

describe('Valko Indorian — Phyrexian cards', () => {
  const ctx = ctxFor(VALKO)

  it('exempts cards with the Phyrexian subtype', () => {
    expect(offColorIdentity({ ...wurmcoil, color_identity: ['W'] }, ['B'], ctx)).toEqual([])
  })

  it('does not exempt a card that merely has Phyrexian in its name', () => {
    expect(offColorIdentity({ ...phyrexianArena, color_identity: ['G'] }, ['B'], ctx)).toEqual(['G'])
  })
})

describe('Tolabow — one chosen color for instants and sorceries', () => {
  it('surfaces a pending color choice', () => {
    const ctx = ctxFor(TOLABOW)
    expect(ctx.colorChoices).toHaveLength(1)
    expect(ctx.colorChoices[0]).toMatchObject({ source: 'Tolabow, Loch Rascal', count: 1 })
    expect(ctx.colorChoices[0].selected).toEqual([])
  })

  it('restricts instants and sorceries normally until a color is chosen', () => {
    const ctx = ctxFor(TOLABOW)
    expect(offColorIdentity(bolt, ['U'], ctx)).toEqual(['R'])
  })

  it('admits instants and sorceries of the chosen color', () => {
    const ctx = ctxFor(TOLABOW, { 'tolabow, loch rascal': ['R'] })
    expect(offColorIdentity(bolt, ['U'], ctx)).toEqual([])
    expect(offColorIdentity(ponder, ['U'], ctx)).toEqual([])
    expect(offColorIdentity(gitaxian, ['U'], ctx)).toEqual([])
  })

  it('still rejects a second off-color instant', () => {
    const ctx = ctxFor(TOLABOW, { 'tolabow, loch rascal': ['R'] })
    expect(offColorIdentity(push, ['U'], ctx)).toEqual(['B'])
  })

  it('does not extend the choice to permanents', () => {
    const ctx = ctxFor(TOLABOW, { 'tolabow, loch rascal': ['R'] })
    expect(offColorIdentity({ name: 'Goblin Guide', type_line: 'Creature — Goblin Scout', color_identity: ['R'] }, ['U'], ctx)).toEqual(['R'])
  })

  it('honours only the first choice when more colors are supplied', () => {
    const ctx = ctxFor(TOLABOW, { 'tolabow, loch rascal': ['R', 'B'] })
    expect(offColorIdentity(bolt, ['U'], ctx)).toEqual([])
    expect(offColorIdentity(push, ['U'], ctx)).toEqual(['B'])
  })

  it('allows basic lands of any color', () => {
    const ctx = ctxFor(TOLABOW)
    expect(offColorIdentity(swamp, ['U'], ctx)).toEqual([])
    expect(offColorIdentity(badlands, ['U'], ctx)).toEqual(['B', 'R'])
  })
})

describe('chosen-color commanders', () => {
  // "choose a color before the game begins. <name> is the chosen color" is a
  // characteristic-defining ability, and CR 903.4 folds CDA-defined colors into
  // color identity while CR 604.3 makes CDAs work outside the game. So the pick
  // is a DECKBUILDING color — same mechanism that gives Transguild Courier a
  // WUBRG identity off a {4} mana cost.
  //
  // Scryfall reports all three of these as color_identity: [] because it can't
  // encode "whatever the player picks". That is a data-model limit, not a rules
  // statement — treating it as colorless silently forbids the deck's own color.
  const PIPER = {
    name: 'The Prismatic Piper',
    type_line: 'Legendary Creature — Elemental',
    color_identity: [],
    oracle_text: 'If The Prismatic Piper is your commander, choose a color before the game begins. The Prismatic Piper is the chosen color.\nPartner (You can have two commanders if both have partner.)',
  }
  const CLARA = {
    name: 'Clara Oswald',
    type_line: 'Legendary Creature — Human Advisor',
    color_identity: [],
    oracle_text: 'Impossible Girl — If Clara Oswald is your commander, choose a color before the game begins. Clara Oswald is the chosen color.\nIf a triggered ability of a Doctor you control triggers, that ability triggers an additional time.\nDoctor\'s companion (You can have two commanders if the other is the Doctor.)',
  }
  const FACELESS = {
    name: 'Faceless One',
    type_line: 'Legendary Creature — Shapeshifter',
    color_identity: [],
    oracle_text: 'If Faceless One is your commander, choose a color before the game begins. Faceless One is the chosen color.\nChoose a Background (You can have a Background as a second commander.)',
  }

  it('parses all three printings into a color choice', () => {
    for (const card of [PIPER, CLARA, FACELESS]) {
      const rules = getCardCommanderRules(card)
      expect(rules, card.name).toHaveLength(1)
      expect(rules[0], card.name).toMatchObject({ identityColors: true, chooseColors: 1 })
    }
  })

  it('surfaces a picker labelled as a commander color, not a Rulebreaker one', () => {
    const ctx = getCommanderRuleContext({ commanders: [CLARA] })
    expect(ctx.colorChoices).toHaveLength(1)
    expect(ctx.colorChoices[0]).toMatchObject({ label: 'Commander color', count: 1 })
  })

  it('contributes no color until the player picks', () => {
    const ctx = getCommanderRuleContext({ commanders: [PIPER] })
    expect(ctx.identityColors).toEqual([])
    expect(offColorIdentity(bolt, [], ctx)).toEqual(['R'])
  })

  it('adds the chosen color to the deck identity', () => {
    const ctx = getCommanderRuleContext({
      commanders: [PIPER], chosenColors: { 'the prismatic piper': ['R'] },
    })
    expect(ctx.identityColors).toEqual(['R'])
    // Every card type benefits — this widens the identity, it doesn't exempt a
    // subset the way a Rulebreaker does.
    expect(offColorIdentity(bolt, [], ctx)).toEqual([])
    expect(offColorIdentity(rancor, ['R'], ctx)).toEqual(['G'])
  })

  it('combines with a partner commander\'s own identity', () => {
    // Piper + a mono-white partner, red chosen → deck is R/W.
    const ctx = getCommanderRuleContext({
      commanders: [PIPER], chosenColors: { 'the prismatic piper': ['R'] },
    })
    expect(offColorIdentity(shivanAngel, ['W'], ctx)).toEqual([])
    expect(offColorIdentity(push, ['W'], ctx)).toEqual(['B'])
  })

  it('does not fire on in-game "choose a color" effects', () => {
    // Alloy Golem says "is the chosen color" but about a permanent entering the
    // battlefield, not a commander before the game.
    expect(getCardCommanderRules({
      name: 'Alloy Golem',
      oracle_text: 'As Alloy Golem enters, choose a color.\nThis creature is the chosen color. (It\'s still an artifact.)',
    })).toEqual([])
    expect(getCardCommanderRules({
      name: 'Iona, Shield of Emeria',
      oracle_text: 'Flying\nAs Iona enters, choose a color.\nYour opponents can\'t cast spells of the chosen color.',
    })).toEqual([])
  })
})

describe('Whtz — no maximum deck size', () => {
  it('flags the deck-size exemption and nothing else', () => {
    const ctx = ctxFor(WHTZ)
    expect(ctx.noMaxDeckSize).toBe(true)
    expect(offColorIdentity(bolt, ['U', 'W'], ctx)).toEqual(['R'])
  })

  it('leaves noMaxDeckSize false for the other rulebreakers', () => {
    expect(ctxFor(SELUMA).noMaxDeckSize).toBe(false)
  })
})

describe('multiple commanders', () => {
  it('unions the rules of a partner pair', () => {
    const ctx = getCommanderRuleContext({ commanders: [SELUMA, GRIZZLEGOM] })
    expect(ctx.rules).toHaveLength(2)
    expect(offColorIdentity(baneslayer, ['G', 'R'], ctx)).toEqual([])
    expect(offColorIdentity(badlands, ['G', 'R'], ctx)).toEqual([])
    // Neither rule covers instants, so the plain rule still applies.
    expect(offColorIdentity(push, ['G', 'R'], ctx)).toEqual(['B'])
  })
})

describe('explainExemption', () => {
  it('names the rule carrying an off-color card', () => {
    const ctx = ctxFor(SELUMA)
    expect(explainExemption(shivanAngel, ['W'], ctx)?.source).toBe('Seluma, Light of Aysen')
  })

  it('returns null for a card that needs no exemption', () => {
    const ctx = ctxFor(SELUMA)
    expect(explainExemption(baneslayer, ['W'], ctx)).toBe(null)
    expect(explainExemption(bolt, ['W'], ctx)).toBe(null)
  })
})

describe('sanitizeColors', () => {
  it('keeps WUBRG letters, uppercases, dedupes, and drops junk', () => {
    expect(sanitizeColors(['r', 'R', 'x', null, 'U'])).toEqual(['R', 'U'])
    expect(sanitizeColors(null)).toEqual([])
  })
})

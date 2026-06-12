import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('./scryfall', () => ({
  sfGet: vi.fn(),
}))

import {
  isMassLandDenial,
  isExtraTurn,
  isNonlandTutor,
  normalizeGameChangerNames,
  fetchGameChangerNames,
  analyzeBracket,
} from './commanderBracket'
import { sfGet } from './scryfall'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

// All oracle texts below are REAL Scryfall oracle text (fetched 2026-06),
// not paraphrases — detector regexes are validated against the actual wording.
const ORACLE = {
  armageddon:       'Destroy all lands.',
  jokulhaups:       "Destroy all artifacts, creatures, and lands. They can't be regenerated.",
  ruination:        'Destroy all nonbasic lands.',
  sunder:           "Return all lands to their owners' hands.",
  winterOrb:        "As long as this artifact is untapped, players can't untap more than one land during their untap steps.",
  impendingDisaster:'At the beginning of your upkeep, if there are seven or more lands on the battlefield, sacrifice this enchantment and destroy all lands.',
  wrathOfGod:       "Destroy all creatures. They can't be regenerated.",
  smallpox:         'Each player loses 1 life, discards a card, sacrifices a creature of their choice, then sacrifices a land of their choice.',
  timeWarp:         'Target player takes an extra turn after this one.',
  nexusOfFate:      "Take an extra turn after this one.\nIf Nexus of Fate would be put into a graveyard from anywhere, reveal Nexus of Fate and shuffle it into its owner's library instead.",
  temporalMastery:  "Take an extra turn after this one. Exile Temporal Mastery.\nMiracle {1}{U}",
  diabolicTutor:    'Search your library for a card, put that card into your hand, then shuffle.',
  cultivate:        'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.',
  solRing:          '{T}: Add {C}{C}.',
}

describe('isMassLandDenial', () => {
  it('detects mass land destruction', () => {
    expect(isMassLandDenial(ORACLE.armageddon)).toBe(true)
    expect(isMassLandDenial(ORACLE.jokulhaups)).toBe(true)
    expect(isMassLandDenial(ORACLE.ruination)).toBe(true)
    expect(isMassLandDenial(ORACLE.impendingDisaster)).toBe(true)
  })
  it('detects mass land bounce and untap denial', () => {
    expect(isMassLandDenial(ORACLE.sunder)).toBe(true)
    expect(isMassLandDenial(ORACLE.winterOrb)).toBe(true)
  })
  it('does not flag board wipes or symmetric single-land sacrifice', () => {
    expect(isMassLandDenial(ORACLE.wrathOfGod)).toBe(false)
    expect(isMassLandDenial(ORACLE.smallpox)).toBe(false)
    expect(isMassLandDenial('')).toBe(false)
    expect(isMassLandDenial(null)).toBe(false)
  })
})

describe('isExtraTurn', () => {
  it('detects extra-turn spells in both phrasings', () => {
    expect(isExtraTurn(ORACLE.timeWarp)).toBe(true)        // "takes an extra turn"
    expect(isExtraTurn(ORACLE.nexusOfFate)).toBe(true)     // "Take an extra turn"
    expect(isExtraTurn(ORACLE.temporalMastery)).toBe(true)
  })
  it('ignores unrelated cards', () => {
    expect(isExtraTurn(ORACLE.wrathOfGod)).toBe(false)
    expect(isExtraTurn(null)).toBe(false)
  })
})

describe('isNonlandTutor', () => {
  it('counts generic and creature tutors', () => {
    expect(isNonlandTutor(ORACLE.diabolicTutor)).toBe(true)
    expect(isNonlandTutor('Search your library for a creature card, reveal it, put it into your hand, then shuffle.')).toBe(true)
  })
  it('does not count land ramp as a tutor', () => {
    expect(isNonlandTutor(ORACLE.cultivate)).toBe(false)
    expect(isNonlandTutor('Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.')).toBe(false)
    expect(isNonlandTutor('Search your library for a Plains card.')).toBe(false)
  })
})

describe('normalizeGameChangerNames', () => {
  it('matches double-faced names by full name and front face', () => {
    const set = normalizeGameChangerNames(["Tergrid, God of Fright // Tergrid's Lantern", 'Rhystic Study'])
    expect(set.has('rhystic study')).toBe(true)
    expect(set.has('tergrid, god of fright')).toBe(true)
    expect(set.has("tergrid, god of fright // tergrid's lantern")).toBe(true)
  })
})

describe('fetchGameChangerNames', () => {
  it('fetches from Scryfall and caches in localStorage', async () => {
    const store = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, v),
    })
    sfGet.mockResolvedValueOnce({ data: [{ name: 'Rhystic Study' }, { name: 'Cyclonic Rift' }], has_more: false })

    const set = await fetchGameChangerNames()
    expect(set.has('rhystic study')).toBe(true)
    expect(sfGet).toHaveBeenCalledTimes(1)

    // Second call served from cache — no new fetch.
    const cached = await fetchGameChangerNames()
    expect(cached.has('cyclonic rift')).toBe(true)
    expect(sfGet).toHaveBeenCalledTimes(1)
  })

  it('follows pagination when has_more is set', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
    sfGet
      .mockResolvedValueOnce({ data: [{ name: 'A' }], has_more: true, next_page: 'https://api.scryfall.com/page2' })
      .mockResolvedValueOnce({ data: [{ name: 'B' }], has_more: false })
    const set = await fetchGameChangerNames({ force: true })
    expect(set.has('a')).toBe(true)
    expect(set.has('b')).toBe(true)
  })
})

describe('analyzeBracket', () => {
  const GC = normalizeGameChangerNames(['Rhystic Study', 'Cyclonic Rift', 'Demonic Tutor', 'The One Ring', 'Thassa\'s Oracle'])
  const card = (name, oracle = '', cmc = 0) => ({ name, oracle_text: oracle, cmc, qty: 1 })

  it('returns Bracket 1 for a deck with no flags', () => {
    const result = analyzeBracket({ cards: [card('Wrath of God', ORACLE.wrathOfGod, 4), card('Cultivate', ORACLE.cultivate, 3)], gameChangerNames: GC })
    expect(result.bracket).toBe(1)
    expect(result.label).toBe('Exhibition')
    expect(result.reasons).toHaveLength(0)
  })

  it('floors at 3 for 1-3 Game Changers, 4 for more than 3', () => {
    const three = analyzeBracket({ cards: [card('Rhystic Study'), card('Cyclonic Rift'), card('Demonic Tutor')], gameChangerNames: GC })
    expect(three.bracket).toBe(3)
    expect(three.gameChangers).toHaveLength(3)

    const four = analyzeBracket({ cards: [card('Rhystic Study'), card('Cyclonic Rift'), card('Demonic Tutor'), card('The One Ring')], gameChangerNames: GC })
    expect(four.bracket).toBe(4)
  })

  it('floors at 4 for mass land denial', () => {
    const result = analyzeBracket({ cards: [card('Armageddon', ORACLE.armageddon, 4)], gameChangerNames: GC })
    expect(result.bracket).toBe(4)
    expect(result.massLandDenial).toEqual(['Armageddon'])
  })

  it('floors at 2 for one extra-turn spell, 3 for three or more', () => {
    const one = analyzeBracket({ cards: [card('Time Warp', ORACLE.timeWarp, 5)], gameChangerNames: GC })
    expect(one.bracket).toBe(2)

    const three = analyzeBracket({
      cards: [card('Time Warp', ORACLE.timeWarp, 5), card('Nexus of Fate', ORACLE.nexusOfFate, 7), card('Temporal Mastery', ORACLE.temporalMastery, 7)],
      gameChangerNames: GC,
    })
    expect(three.bracket).toBe(3)
  })

  it('floors at 4 for a fast two-card combo, 3 for a slow one', () => {
    const cards = [card("Thassa's Oracle", '', 2), card('Demonic Consultation', '', 1), card('Big Combo Piece', '', 8), card('Other Big Piece', '', 7)]
    const fast = analyzeBracket({ cards, gameChangerNames: new Set(), comboCardLists: [["Thassa's Oracle", 'Demonic Consultation']] })
    expect(fast.bracket).toBe(4)
    expect(fast.twoCardCombos[0].early).toBe(true)

    const slow = analyzeBracket({ cards, gameChangerNames: new Set(), comboCardLists: [['Big Combo Piece', 'Other Big Piece']] })
    expect(slow.bracket).toBe(3)
    expect(slow.twoCardCombos[0].early).toBe(false)
  })

  it('dedupes combo variants that use the same two cards', () => {
    const cards = [card('A', '', 1), card('B', '', 2), card('C', '', 3)]
    const result = analyzeBracket({
      cards,
      gameChangerNames: new Set(),
      // Spellbook returns one entry per variant — A+B appears twice.
      comboCardLists: [['A', 'B'], ['B', 'A'], ['A', 'C']],
    })
    expect(result.twoCardCombos).toHaveLength(2)
  })

  it('reports combo counts in the reason when there are several', () => {
    const cards = [card('A', '', 1), card('B', '', 2), card('C', '', 3)]
    const result = analyzeBracket({
      cards,
      gameChangerNames: new Set(),
      comboCardLists: [['A', 'B'], ['A', 'C']],
    })
    expect(result.bracket).toBe(4)
    expect(result.reasons[0].reason).toContain('2 fast two-card combos')
    expect(result.reasons[0].reason).toContain('e.g.')
  })

  it('ignores 3+ card combos for the two-card floor', () => {
    const result = analyzeBracket({ cards: [card('A'), card('B'), card('C')], gameChangerNames: new Set(), comboCardLists: [['A', 'B', 'C']] })
    expect(result.bracket).toBe(1)
    expect(result.twoCardCombos).toHaveLength(0)
  })

  it('reports tutors and fast mana as soft signals without raising the bracket', () => {
    const result = analyzeBracket({
      cards: [card('Diabolic Tutor', ORACLE.diabolicTutor, 4), card('Sol Ring', ORACLE.solRing, 1)],
      gameChangerNames: GC,
    })
    expect(result.bracket).toBe(1)
    expect(result.tutors).toEqual(['Diabolic Tutor'])
    expect(result.fastMana).toEqual(['Sol Ring'])
  })

  it('reports combosChecked=false when the combo check has not run', () => {
    expect(analyzeBracket({ cards: [], gameChangerNames: new Set() }).combosChecked).toBe(false)
    expect(analyzeBracket({ cards: [], gameChangerNames: new Set(), comboCardLists: [] }).combosChecked).toBe(true)
  })

  it('matches a Game Changer commander by front face name', () => {
    const gc = normalizeGameChangerNames(["Tergrid, God of Fright // Tergrid's Lantern"])
    const result = analyzeBracket({ cards: [card('Tergrid, God of Fright')], gameChangerNames: gc })
    expect(result.bracket).toBe(3)
  })
})

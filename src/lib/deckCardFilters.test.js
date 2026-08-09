import { describe, it, expect, vi } from 'vitest'

// deckCardFilters → deckBuilderApi → scryfall/supabase; mock the leaves like
// deckBuilderApi.test.js does so the module graph loads in the node test env.
vi.mock('./scryfall', () => ({
  sfGet: vi.fn(),
  sfUrl: (u) => u,
  getImageUri: () => null,
  getPrice: () => null,
}))
vi.mock('./supabase', () => ({ sb: { from: vi.fn(), rpc: vi.fn() } }))

import {
  EMPTY_DECK_CARD_FILTERS,
  DECK_CARD_TYPE_OPTIONS,
  matchesDeckCardFilters,
  matchesDeckCardSearch,
  countActiveCardFilters,
  countAdvancedCardFilters,
  computeDeckFilterPresence,
  availableFilterOptions,
  deckBoardFilterOptions,
  DECK_FILTER_PARTS,
  DECK_FILTER_INLINE_PARTS,
  DECK_FILTER_MENU_PARTS,
  manaValueGroupKey,
  colorGroupKey,
  MANA_VALUE_GROUP_ORDER,
  COLOR_GROUP_ORDER,
} from './deckCardFilters'

const card = (over = {}) => ({
  name: 'Test Card',
  type_line: 'Creature — Human',
  color_identity: ['W'],
  cmc: 2,
  ...over,
})

describe('matchesDeckCardFilters', () => {
  it('passes everything with empty filters', () => {
    expect(matchesDeckCardFilters(card(), null, EMPTY_DECK_CARD_FILTERS)).toBe(true)
    expect(matchesDeckCardFilters(card(), null, null)).toBe(true)
  })

  it('filters by color identity with modes', () => {
    const f = { ...EMPTY_DECK_CARD_FILTERS, colors: ['R'], colorMode: 'includes' }
    expect(matchesDeckCardFilters(card({ color_identity: ['R'] }), null, f)).toBe(true)
    expect(matchesDeckCardFilters(card({ color_identity: ['W'] }), null, f)).toBe(false)
    const atMost = { ...EMPTY_DECK_CARD_FILTERS, colors: ['W', 'U'], colorMode: 'at_most' }
    expect(matchesDeckCardFilters(card({ color_identity: ['W'] }), null, atMost)).toBe(true)
    expect(matchesDeckCardFilters(card({ color_identity: ['W', 'B'] }), null, atMost)).toBe(false)
  })

  it('filters by card type group', () => {
    const f = { ...EMPTY_DECK_CARD_FILTERS, types: ['Instants', 'Sorceries'] }
    expect(matchesDeckCardFilters(card({ type_line: 'Instant' }), null, f)).toBe(true)
    expect(matchesDeckCardFilters(card({ type_line: 'Sorcery' }), null, f)).toBe(true)
    expect(matchesDeckCardFilters(card({ type_line: 'Creature — Goblin' }), null, f)).toBe(false)
  })

  it('filters by rarity from the Scryfall entry, excluding unknowns', () => {
    const f = { ...EMPTY_DECK_CARD_FILTERS, rarities: ['mythic'] }
    expect(matchesDeckCardFilters(card(), { rarity: 'mythic' }, f)).toBe(true)
    expect(matchesDeckCardFilters(card(), { rarity: 'common' }, f)).toBe(false)
    expect(matchesDeckCardFilters(card(), null, f)).toBe(false)
  })

  it('filters by CMC bounds (either bound optional)', () => {
    expect(matchesDeckCardFilters(card({ cmc: 3 }), null, { ...EMPTY_DECK_CARD_FILTERS, cmcMin: '2' })).toBe(true)
    expect(matchesDeckCardFilters(card({ cmc: 1 }), null, { ...EMPTY_DECK_CARD_FILTERS, cmcMin: '2' })).toBe(false)
    expect(matchesDeckCardFilters(card({ cmc: 3 }), null, { ...EMPTY_DECK_CARD_FILTERS, cmcMax: '3' })).toBe(true)
    expect(matchesDeckCardFilters(card({ cmc: 4 }), null, { ...EMPTY_DECK_CARD_FILTERS, cmcMax: '3' })).toBe(false)
    expect(matchesDeckCardFilters(card({ cmc: undefined }), null, { ...EMPTY_DECK_CARD_FILTERS, cmcMax: '0' })).toBe(true)
  })

  it('counts active filters for the trigger badge', () => {
    expect(countActiveCardFilters(EMPTY_DECK_CARD_FILTERS)).toBe(0)
    expect(countActiveCardFilters({ ...EMPTY_DECK_CARD_FILTERS, colors: ['W'], cmcMin: '1', cmcMax: '3' })).toBe(3)
  })
})

describe('computeDeckFilterPresence', () => {
  it('collects only the boards, colors, types, and rarities in the deck', () => {
    const rarities = { a: 'rare', b: 'common' }
    const deck = [
      card({ name: 'a', board: 'main', color_identity: ['R'], type_line: 'Creature — Goblin' }),
      card({ name: 'b', board: 'side', color_identity: [], type_line: 'Artifact' }),
    ]
    const p = computeDeckFilterPresence(deck, dc => rarities[dc.name])
    expect([...p.boards].sort()).toEqual(['main', 'side'])
    expect([...p.colors].sort()).toEqual(['C', 'R'])
    expect([...p.types].sort()).toEqual(['Artifacts', 'Creatures'])
    expect([...p.rarities].sort()).toEqual(['common', 'rare'])
  })

  it('treats a missing/blank board as main and empty color identity as colorless', () => {
    const p = computeDeckFilterPresence([card({ board: null, color_identity: null })])
    expect([...p.boards]).toEqual(['main'])
    expect([...p.colors]).toEqual(['C'])
  })

  it('ignores unresolved rarities and handles an empty deck', () => {
    const noRarity = computeDeckFilterPresence([card()], () => null)
    expect(noRarity.rarities.size).toBe(0)
    const empty = computeDeckFilterPresence([])
    expect(empty.boards.size).toBe(0)
    expect(empty.colors.size).toBe(0)
  })
})

describe('availableFilterOptions', () => {
  it('keeps only options present in the deck, preserving option order', () => {
    expect(availableFilterOptions(DECK_CARD_TYPE_OPTIONS, new Set(['Lands', 'Creatures'])))
      .toEqual(['Creatures', 'Lands'])
  })

  it('keeps a selected option visible even when no longer present, so it can be cleared', () => {
    expect(availableFilterOptions(['common', 'uncommon', 'rare'], new Set(['common']), ['rare']))
      .toEqual(['common', 'rare'])
  })

  it('returns all options when presence is unknown', () => {
    expect(availableFilterOptions(['W', 'U'], null)).toEqual(['W', 'U'])
  })
})

describe('matchesDeckCardSearch', () => {
  const bolt = { name: 'Lightning Bolt', type_line: 'Instant', mana_cost: '{R}', set_code: 'LEA', collector_number: '161' }
  const boltSf = { oracle_text: 'Lightning Bolt deals 3 damage to any target.' }
  const scales = { name: 'Hardened Scales', type_line: 'Enchantment', mana_cost: '{G}' }
  const scalesSf = { oracle_text: 'If one or more +1/+1 counters would be put on a creature you control, that many plus one are put on it instead.' }

  it('matches everything on an empty or whitespace query', () => {
    expect(matchesDeckCardSearch(bolt, boltSf, '')).toBe(true)
    expect(matchesDeckCardSearch(bolt, boltSf, '   ')).toBe(true)
    expect(matchesDeckCardSearch(bolt, boltSf, null)).toBe(true)
  })

  it('matches rules text, not just the printed identity', () => {
    // The reported case: "counter" should surface everything that interacts
    // with counters, not only a card named Counterspell.
    expect(matchesDeckCardSearch(scales, scalesSf, 'counter')).toBe(true)
    expect(matchesDeckCardSearch(scales, scalesSf, 'COUNTER')).toBe(true)
  })

  it('still matches name, type, mana cost, set and collector number', () => {
    for (const q of ['lightning', 'instant', '{r}', 'lea', '161']) {
      expect(matchesDeckCardSearch(bolt, boltSf, q)).toBe(true)
    }
  })

  it('reads the back face of a double-faced card', () => {
    // An MDFC's land half is part of what the card does.
    const dfc = { name: 'Agadeem\'s Awakening', type_line: 'Sorcery // Land' }
    const dfcSf = {
      card_faces: [
        { oracle_text: 'Return from your graveyard to the battlefield any number of target creature cards.' },
        { oracle_text: 'As Agadeem, the Undercrypt enters, you may pay 3 life.' },
      ],
    }
    expect(matchesDeckCardSearch(dfc, dfcSf, 'undercrypt')).toBe(true)
  })

  it('ignores parenthetical reminder text', () => {
    // Reminder text restates rules the card already spells out, so matching it
    // only widens false positives.
    const treasure = { name: 'Ancient Copper Dragon', type_line: 'Creature — Dragon' }
    const sf = { oracle_text: 'Create that many Treasure tokens. (It\'s an artifact with "{T}, Sacrifice this token: Add one mana of any color.")' }
    expect(matchesDeckCardSearch(treasure, sf, 'treasure')).toBe(true)
    expect(matchesDeckCardSearch(treasure, sf, 'sacrifice this token')).toBe(false)
  })

  it('falls back to the row when the printing has not resolved yet', () => {
    // builderSfMap is populated asynchronously; until it lands the row still
    // has to be findable by name.
    expect(matchesDeckCardSearch(bolt, undefined, 'lightning')).toBe(true)
    expect(matchesDeckCardSearch(bolt, undefined, 'damage')).toBe(false)
    expect(matchesDeckCardSearch({ ...bolt, oracle_text: boltSf.oracle_text }, undefined, 'damage')).toBe(true)
  })

  it('excludes a card that matches on neither identity nor text', () => {
    expect(matchesDeckCardSearch(bolt, boltSf, 'counter')).toBe(false)
    expect(matchesDeckCardSearch(scales, scalesSf, 'lightning')).toBe(false)
  })
})

describe('deckBoardFilterOptions', () => {
  const presence = boards => ({ boards: new Set(boards) })

  it('offers All plus only the boards the deck actually uses', () => {
    expect(deckBoardFilterOptions(presence(['main', 'side']), 'all').map(f => f.id))
      .toEqual(['all', 'main', 'side'])
  })

  it('collapses to a single option for a deck with one board', () => {
    // The inline bar hides the board group below two real choices, so a plain
    // 100-card deck shows search + colors and nothing else.
    expect(deckBoardFilterOptions(presence(['main']), 'all').map(f => f.id))
      .toEqual(['all', 'main'])
  })

  it('keeps a stale selection listed so it can still be cleared', () => {
    // Last maybeboard card removed while the maybe filter was active.
    expect(deckBoardFilterOptions(presence(['main']), 'maybe').map(f => f.id))
      .toEqual(['all', 'main', 'maybe'])
  })

  it('returns every board when presence is unknown', () => {
    expect(deckBoardFilterOptions(null, 'all').map(f => f.id))
      .toEqual(['all', 'main', 'attraction', 'side', 'maybe'])
  })
})

describe('deck filter surface split', () => {
  it('splits every section across the inline bar and the More filters menu', () => {
    // Desktop renders only these two lists. Anything in neither would be
    // reachable on mobile but silently unreachable on desktop.
    expect([...DECK_FILTER_INLINE_PARTS, ...DECK_FILTER_MENU_PARTS].sort())
      .toEqual([...DECK_FILTER_PARTS].sort())
  })

  it('assigns each section to exactly one desktop surface', () => {
    const overlap = DECK_FILTER_INLINE_PARTS.filter(p => DECK_FILTER_MENU_PARTS.includes(p))
    expect(overlap).toEqual([])
  })
})

describe('countAdvancedCardFilters', () => {
  it('counts only the sections the More filters menu owns', () => {
    expect(countAdvancedCardFilters(EMPTY_DECK_CARD_FILTERS)).toBe(0)
    expect(countAdvancedCardFilters({
      ...EMPTY_DECK_CARD_FILTERS, types: ['Creatures'], rarities: ['mythic'], cmcMin: '2', cmcMax: '5',
    })).toBe(4)
  })

  it('ignores filters the inline bar owns, so they never badge the menu', () => {
    // A color pip is visible and clearable in the toolbar; badging "More"
    // for it would point at a menu that cannot clear it.
    const colored = { ...EMPTY_DECK_CARD_FILTERS, colors: ['R', 'G'] }
    expect(countAdvancedCardFilters(colored)).toBe(0)
    expect(countActiveCardFilters(colored)).toBe(1)
  })

  it('counts a multi-select section once, unlike a mana-value range', () => {
    expect(countAdvancedCardFilters({ ...EMPTY_DECK_CARD_FILTERS, types: ['Creatures', 'Lands'] })).toBe(1)
    expect(countAdvancedCardFilters({ ...EMPTY_DECK_CARD_FILTERS, cmcMin: '2', cmcMax: '5' })).toBe(2)
  })

  it('treats a zero mana-value bound as set, not empty', () => {
    expect(countAdvancedCardFilters({ ...EMPTY_DECK_CARD_FILTERS, cmcMax: '0' })).toBe(1)
  })

  it('tolerates a null filter object', () => {
    expect(countAdvancedCardFilters(null)).toBe(0)
  })
})

describe('manaValueGroupKey', () => {
  it('buckets by mana value with a 7+ cap and a Lands bucket', () => {
    expect(manaValueGroupKey(card({ cmc: 0, type_line: 'Artifact' }))).toBe('0')
    expect(manaValueGroupKey(card({ cmc: 3.5 }))).toBe('3') // half mana symbols floor
    expect(manaValueGroupKey(card({ cmc: 7 }))).toBe('7+')
    expect(manaValueGroupKey(card({ cmc: 12 }))).toBe('7+')
    expect(manaValueGroupKey(card({ cmc: 0, type_line: 'Basic Land — Island' }))).toBe('Lands')
    expect(manaValueGroupKey(card({ cmc: undefined, type_line: 'Instant' }))).toBe('0')
  })

  it('every key it produces is in the declared order list', () => {
    for (const c of [0, 1, 5, 7, 15]) {
      expect(MANA_VALUE_GROUP_ORDER).toContain(manaValueGroupKey(card({ cmc: c })))
    }
    expect(MANA_VALUE_GROUP_ORDER).toContain(manaValueGroupKey(card({ type_line: 'Land' })))
  })
})

describe('colorGroupKey', () => {
  it('groups mono colors, multicolor, colorless, and lands', () => {
    expect(colorGroupKey(card({ color_identity: ['U'] }))).toBe('Blue')
    expect(colorGroupKey(card({ color_identity: ['B', 'R'] }))).toBe('Multicolor')
    expect(colorGroupKey(card({ color_identity: [], type_line: 'Artifact' }))).toBe('Colorless')
    expect(colorGroupKey(card({ color_identity: null, type_line: 'Artifact' }))).toBe('Colorless')
    expect(colorGroupKey(card({ color_identity: ['G'], type_line: 'Land — Forest' }))).toBe('Lands')
  })

  it('a land-creature groups with creatures, matching the type grouping', () => {
    // classifyCardType checks creature before land — Dryad Arbor stays green.
    expect(colorGroupKey(card({ color_identity: ['G'], type_line: 'Land Creature — Forest Dryad' }))).toBe('Green')
  })

  it('an artifact land groups with lands, matching the type grouping', () => {
    // Seat of the Synod is a land first — it must not land in Colorless with
    // the mana rocks.
    expect(colorGroupKey(card({ color_identity: ['U'], type_line: 'Artifact Land' }))).toBe('Lands')
    expect(manaValueGroupKey(card({ cmc: 0, type_line: 'Artifact Land' }))).toBe('Lands')
  })

  it('every key it produces is in the declared order list', () => {
    for (const ci of [['W'], ['U'], ['B'], ['R'], ['G'], ['W', 'U'], []]) {
      expect(COLOR_GROUP_ORDER).toContain(colorGroupKey(card({ color_identity: ci, type_line: 'Sorcery' })))
    }
  })
})

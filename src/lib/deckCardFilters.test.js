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
  countActiveCardFilters,
  computeDeckFilterPresence,
  availableFilterOptions,
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

  it('every key it produces is in the declared order list', () => {
    for (const ci of [['W'], ['U'], ['B'], ['R'], ['G'], ['W', 'U'], []]) {
      expect(COLOR_GROUP_ORDER).toContain(colorGroupKey(card({ color_identity: ci, type_line: 'Sorcery' })))
    }
  })
})

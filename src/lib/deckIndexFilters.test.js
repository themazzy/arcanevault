import { describe, it, expect } from 'vitest'
import {
  matchColorIdentity,
  EMPTY_DECK_INDEX_FILTERS,
  filterDeckIndex,
  sortDeckIndex,
  describeActiveFilters,
  countActiveFilters,
  clearFilterChip,
  deckColorsOf,
} from './deckIndexFilters'

function deck(over = {}) {
  const { meta, ...rest } = over
  return {
    id: Math.random().toString(36).slice(2),
    name: 'Test Deck',
    type: 'builder_deck',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    deck_color_identity: null,
    __meta: { ...meta },
    ...rest,
  }
}

describe('matchColorIdentity', () => {
  it('returns true when nothing is selected', () => {
    expect(matchColorIdentity(['W', 'U'], [], 'includes')).toBe(true)
    expect(matchColorIdentity(['W', 'U'], null, 'exact')).toBe(true)
  })

  it('includes: deck identity must contain every selected color', () => {
    expect(matchColorIdentity(['W', 'U', 'B'], ['W', 'U'], 'includes')).toBe(true)
    expect(matchColorIdentity(['W'], ['W', 'U'], 'includes')).toBe(false)
  })

  it('exact: identities must match exactly', () => {
    expect(matchColorIdentity(['W', 'U'], ['U', 'W'], 'exact')).toBe(true)
    expect(matchColorIdentity(['W', 'U', 'B'], ['W', 'U'], 'exact')).toBe(false)
    expect(matchColorIdentity(['W'], ['W', 'U'], 'exact')).toBe(false)
  })

  it('at_most: deck identity must be within the selected colors', () => {
    expect(matchColorIdentity(['W'], ['W', 'U'], 'at_most')).toBe(true)
    expect(matchColorIdentity(['W', 'U'], ['W', 'U'], 'at_most')).toBe(true)
    expect(matchColorIdentity(['W', 'B'], ['W', 'U'], 'at_most')).toBe(false)
  })

  it('treats an empty identity as colorless so the C pip matches', () => {
    expect(matchColorIdentity([], ['C'], 'includes')).toBe(true)
    expect(matchColorIdentity([], ['C'], 'exact')).toBe(true)
    expect(matchColorIdentity([], ['W', 'C'], 'at_most')).toBe(true)
    expect(matchColorIdentity(['W'], ['C'], 'includes')).toBe(false)
  })
})

describe('filterDeckIndex', () => {
  const decks = [
    deck({ name: 'Urza Storm', type: 'builder_deck', deck_color_identity: ['U'], meta: { format: 'commander', bracket: 4, is_public: true, tags: ['combo'], commanderName: 'Urza, Lord High Artificer' } }),
    deck({ name: 'Goblin Pile', type: 'deck', deck_color_identity: ['R'], meta: { format: 'commander', bracket: 2, tags: ['aggro'] } }),
    deck({ name: 'Modern Burn', type: 'builder_deck', deck_color_identity: ['R'], meta: { format: 'modern' } }),
  ]

  it('passes everything through with empty filters', () => {
    expect(filterDeckIndex(decks, EMPTY_DECK_INDEX_FILTERS)).toHaveLength(3)
  })

  it('search matches name, commander, and tags', () => {
    expect(filterDeckIndex(decks, { search: 'goblin' }).map(d => d.name)).toEqual(['Goblin Pile'])
    expect(filterDeckIndex(decks, { search: 'lord high' }).map(d => d.name)).toEqual(['Urza Storm'])
    expect(filterDeckIndex(decks, { search: 'aggro' }).map(d => d.name)).toEqual(['Goblin Pile'])
  })

  it('filters by type, visibility, format, bracket, and tags', () => {
    expect(filterDeckIndex(decks, { type: 'collection' }).map(d => d.name)).toEqual(['Goblin Pile'])
    expect(filterDeckIndex(decks, { visibility: 'public' }).map(d => d.name)).toEqual(['Urza Storm'])
    expect(filterDeckIndex(decks, { visibility: 'private' })).toHaveLength(2)
    expect(filterDeckIndex(decks, { format: 'modern' }).map(d => d.name)).toEqual(['Modern Burn'])
    expect(filterDeckIndex(decks, { bracket: 4 }).map(d => d.name)).toEqual(['Urza Storm'])
    expect(filterDeckIndex(decks, { tags: ['aggro', 'combo'] })).toHaveLength(2)
  })

  it('missing format defaults to commander', () => {
    const noFormat = deck({ name: 'Legacy Meta', meta: {} })
    expect(filterDeckIndex([noFormat], { format: 'commander' })).toHaveLength(1)
  })

  it('filters by color identity with the given mode', () => {
    expect(filterDeckIndex(decks, { colors: ['R'], colorMode: 'includes' })).toHaveLength(2)
    expect(filterDeckIndex(decks, { colors: ['U'], colorMode: 'exact' }).map(d => d.name)).toEqual(['Urza Storm'])
  })
})

describe('deckColorsOf', () => {
  it('prefers aggregated deck colors, falls back to commander identity', () => {
    expect(deckColorsOf(deck({ deck_color_identity: ['B', 'G'] }))).toEqual(['B', 'G'])
    expect(deckColorsOf(deck({ deck_color_identity: [], meta: { commanderColorIdentity: ['W'] } }))).toEqual(['W'])
  })
})

describe('sortDeckIndex', () => {
  const a = deck({ name: 'Alpha', created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-02T00:00:00Z', card_count: 60, meta: { format: 'modern', bracket: 3 } })
  const b = deck({ name: 'Beta', created_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-02T00:00:00Z', card_count: 100, meta: { format: 'commander' } })

  it('sorts by each key', () => {
    expect(sortDeckIndex([b, a], 'name').map(d => d.name)).toEqual(['Alpha', 'Beta'])
    expect(sortDeckIndex([a, b], 'name_desc').map(d => d.name)).toEqual(['Beta', 'Alpha'])
    expect(sortDeckIndex([a, b], 'created').map(d => d.name)).toEqual(['Beta', 'Alpha'])
    expect(sortDeckIndex([a, b], 'updated').map(d => d.name)).toEqual(['Beta', 'Alpha'])
    expect(sortDeckIndex([b, a], 'format').map(d => d.name)).toEqual(['Beta', 'Alpha']) // commander < modern
    expect(sortDeckIndex([b, a], 'bracket').map(d => d.name)).toEqual(['Alpha', 'Beta']) // bracket desc, null last
    expect(sortDeckIndex([a, b], 'count').map(d => d.name)).toEqual(['Beta', 'Alpha'])   // count desc
  })

  it('does not mutate the input array', () => {
    const input = [b, a]
    sortDeckIndex(input, 'name')
    expect(input[0].name).toBe('Beta')
  })
})

describe('filter chips', () => {
  const filters = {
    ...EMPTY_DECK_INDEX_FILTERS,
    type: 'builder',
    format: 'commander',
    colors: ['W', 'U'],
    colorMode: 'exact',
    bracket: 3,
    tags: ['combo', 'budget'],
  }

  it('describes each active filter as a removable chip', () => {
    const chips = describeActiveFilters(filters, { formatLabel: 'Commander / EDH' })
    expect(chips.map(c => c.key)).toEqual(['type', 'format', 'colors', 'bracket', 'tag:combo', 'tag:budget'])
    expect(chips.find(c => c.key === 'format').label).toBe('Commander / EDH')
    expect(chips.find(c => c.key === 'colors').label).toBe('Exactly WU')
    expect(countActiveFilters(filters)).toBe(6)
    expect(countActiveFilters(EMPTY_DECK_INDEX_FILTERS)).toBe(0)
  })

  it('clearFilterChip resets exactly the chip that was clicked', () => {
    expect(clearFilterChip(filters, 'format').format).toBe('all')
    expect(clearFilterChip(filters, 'colors').colors).toEqual([])
    expect(clearFilterChip(filters, 'tag:combo').tags).toEqual(['budget'])
    // untouched keys survive
    expect(clearFilterChip(filters, 'format').colors).toEqual(['W', 'U'])
  })
})

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
  deckCompletion,
  isDeckUnsynced,
  normalizeDeckSort,
  describeSortDirection,
  DECK_INDEX_SORTS,
} from './deckIndexFilters'

// Stands in for a FORMATS lookup; the real one is passed from Builder.jsx.
const deckSizeFor = id => ({ commander: 100, modern: 60, standard: 60 })[id]

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

describe('tag match mode', () => {
  const decks = [
    deck({ name: 'Both',  meta: { tags: ['combo', 'budget'] } }),
    deck({ name: 'One',   meta: { tags: ['combo'] } }),
    deck({ name: 'Other', meta: { tags: ['aggro'] } }),
  ]

  it('any (default) matches decks carrying at least one selected tag', () => {
    expect(filterDeckIndex(decks, { tags: ['combo', 'budget'] }).map(d => d.name))
      .toEqual(['Both', 'One'])
  })

  it('all requires every selected tag to be present', () => {
    expect(filterDeckIndex(decks, { tags: ['combo', 'budget'], tagMode: 'all' }).map(d => d.name))
      .toEqual(['Both'])
  })
})

describe('deckCompletion', () => {
  it('compares card count against the format target', () => {
    expect(deckCompletion(deck({ card_count: 100, meta: { format: 'commander' } }), deckSizeFor)).toBe('complete')
    expect(deckCompletion(deck({ card_count: 87,  meta: { format: 'commander' } }), deckSizeFor)).toBe('under')
    expect(deckCompletion(deck({ card_count: 117, meta: { format: 'commander' } }), deckSizeFor)).toBe('over')
    expect(deckCompletion(deck({ card_count: 60,  meta: { format: 'modern' } }), deckSizeFor)).toBe('complete')
  })

  it('returns null when the count or the target is unknown', () => {
    expect(deckCompletion(deck({ card_count: null, meta: { format: 'commander' } }), deckSizeFor)).toBe(null)
    expect(deckCompletion(deck({ card_count: 40, meta: { format: 'pauper' } }), deckSizeFor)).toBe(null)
    expect(deckCompletion(deck({ card_count: 100 }), undefined)).toBe(null)
  })

  it('filters the index, and is a no-op without a size resolver', () => {
    const decks = [
      deck({ name: 'Full',  card_count: 100, meta: { format: 'commander' } }),
      deck({ name: 'Short', card_count: 87,  meta: { format: 'commander' } }),
      deck({ name: 'Bloat', card_count: 117, meta: { format: 'commander' } }),
    ]
    expect(filterDeckIndex(decks, { completion: 'over' }, { deckSizeFor }).map(d => d.name)).toEqual(['Bloat'])
    expect(filterDeckIndex(decks, { completion: 'under' }, { deckSizeFor }).map(d => d.name)).toEqual(['Short'])
    expect(filterDeckIndex(decks, { completion: 'complete' }, { deckSizeFor }).map(d => d.name)).toEqual(['Full'])
    // No resolver → the filter cannot be evaluated, so nothing matches rather
    // than silently passing everything through.
    expect(filterDeckIndex(decks, { completion: 'over' })).toEqual([])
  })
})

describe('isDeckUnsynced', () => {
  it('is true only for a linked pair with pending drift', () => {
    expect(isDeckUnsynced({ linked_deck_id: 'x', sync_state: { unsynced_builder: true } })).toBe(true)
    expect(isDeckUnsynced({ linked_builder_id: 'x', sync_state: { unsynced_collection: true } })).toBe(true)
    expect(isDeckUnsynced({ linked_deck_id: 'x', sync_state: {} })).toBe(false)
    // drift flags without a link are meaningless
    expect(isDeckUnsynced({ sync_state: { unsynced_builder: true } })).toBe(false)
    expect(isDeckUnsynced({})).toBe(false)
    expect(isDeckUnsynced(null)).toBe(false)
  })

  it('filters the index', () => {
    const decks = [
      deck({ name: 'Drifted', meta: { linked_deck_id: 'a', sync_state: { unsynced_builder: true } } }),
      deck({ name: 'Clean',   meta: { linked_deck_id: 'b', sync_state: {} } }),
      deck({ name: 'Solo',    meta: {} }),
    ]
    expect(filterDeckIndex(decks, { unsyncedOnly: true }).map(d => d.name)).toEqual(['Drifted'])
    expect(filterDeckIndex(decks, { unsyncedOnly: false })).toHaveLength(3)
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

  it('reverses every key when the direction is flipped', () => {
    expect(sortDeckIndex([a, b], 'name',    'desc').map(d => d.name)).toEqual(['Beta', 'Alpha'])
    expect(sortDeckIndex([a, b], 'created', 'asc').map(d => d.name)).toEqual(['Alpha', 'Beta'])
    expect(sortDeckIndex([a, b], 'updated', 'asc').map(d => d.name)).toEqual(['Alpha', 'Beta'])
    expect(sortDeckIndex([a, b], 'count',   'asc').map(d => d.name)).toEqual(['Alpha', 'Beta'])
    expect(sortDeckIndex([a, b], 'bracket', 'asc').map(d => d.name)).toEqual(['Beta', 'Alpha'])
    expect(sortDeckIndex([a, b], 'format',  'desc').map(d => d.name)).toEqual(['Alpha', 'Beta'])
  })

  it('breaks ties by name ascending regardless of direction', () => {
    const x = deck({ name: 'Xenagos', card_count: 100 })
    const y = deck({ name: 'Atraxa',  card_count: 100 })
    expect(sortDeckIndex([x, y], 'count', 'desc').map(d => d.name)).toEqual(['Atraxa', 'Xenagos'])
    expect(sortDeckIndex([x, y], 'count', 'asc').map(d => d.name)).toEqual(['Atraxa', 'Xenagos'])
  })

  it('still honours the retired name_desc key from saved preferences', () => {
    expect(normalizeDeckSort('name_desc')).toEqual({ sortBy: 'name', dir: 'desc' })
    expect(sortDeckIndex([a, b], 'name_desc').map(d => d.name)).toEqual(['Beta', 'Alpha'])
    expect(DECK_INDEX_SORTS.name_desc).toBeUndefined()
  })

  it('falls back to updated/desc for an unknown key', () => {
    expect(normalizeDeckSort('nonsense')).toEqual({ sortBy: 'updated', dir: 'desc' })
    expect(normalizeDeckSort('count', 'sideways').dir).toBe('desc')
  })

  it('labels the direction in the terms of the key being sorted', () => {
    expect(describeSortDirection('updated', 'desc')).toBe('Newest first')
    expect(describeSortDirection('name', 'asc')).toBe('A→Z')
    expect(describeSortDirection('count', 'asc')).toBe('Fewest first')
  })

  it('uses meaningful deck changes instead of maintenance updates for recent order', () => {
    const contentRecent = deck({
      name: 'Content recent',
      updated_at: '2026-06-01T00:00:00Z',
      deck_modified_at: '2026-05-30T00:00:00Z',
    })
    const maintenanceRecent = deck({
      name: 'Maintenance recent',
      updated_at: '2026-06-02T00:00:00Z',
      deck_modified_at: '2026-05-01T00:00:00Z',
    })

    expect(sortDeckIndex([maintenanceRecent, contentRecent], 'updated').map(d => d.name))
      .toEqual(['Content recent', 'Maintenance recent'])
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

  it('adds chips for the new size / sync / tag-mode filters', () => {
    const chips = describeActiveFilters({
      ...EMPTY_DECK_INDEX_FILTERS,
      completion: 'over',
      unsyncedOnly: true,
      tags: ['combo', 'budget'],
      tagMode: 'all',
    })
    expect(chips.map(c => c.key)).toEqual(['completion', 'unsyncedOnly', 'tag:combo', 'tag:budget', 'tagMode'])
    expect(chips.find(c => c.key === 'completion').label).toBe('Over target')
    expect(chips.find(c => c.key === 'unsyncedOnly').label).toBe('Unsynced')
  })

  it('omits the tag-mode chip when it cannot change the result', () => {
    const oneTag = describeActiveFilters({ ...EMPTY_DECK_INDEX_FILTERS, tags: ['combo'], tagMode: 'all' })
    expect(oneTag.map(c => c.key)).toEqual(['tag:combo'])
  })

  it('clearFilterChip resets the new filters to their defaults', () => {
    const active = { ...EMPTY_DECK_INDEX_FILTERS, completion: 'under', unsyncedOnly: true, tagMode: 'all' }
    expect(clearFilterChip(active, 'completion').completion).toBe('all')
    expect(clearFilterChip(active, 'unsyncedOnly').unsyncedOnly).toBe(false)
    expect(clearFilterChip(active, 'tagMode').tagMode).toBe('any')
  })

  it('clearFilterChip resets exactly the chip that was clicked', () => {
    expect(clearFilterChip(filters, 'format').format).toBe('all')
    expect(clearFilterChip(filters, 'colors').colors).toEqual([])
    expect(clearFilterChip(filters, 'tag:combo').tags).toEqual(['budget'])
    // untouched keys survive
    expect(clearFilterChip(filters, 'format').colors).toEqual(['W', 'U'])
  })
})

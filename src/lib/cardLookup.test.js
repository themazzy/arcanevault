import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./cardSearch', () => ({ searchCardNames: vi.fn() }))

import { fetchAutocomplete, buildLookupQuery, hasLookupFilters } from './cardLookup'
import { searchCardNames } from './cardSearch'

const EMPTY_FILTERS = {
  foil: 'all', colors: [], colorMode: 'identity', rarity: [], typeLine: [],
  oracleText: '', artist: '', sets: [], formats: [],
  cmcOp: 'any', cmcMin: '', cmcMax: '',
  powerOp: 'any', powerVal: '', toughOp: 'any', toughVal: '',
  colorCountMin: 0, colorCountMax: 5,
}

describe('buildLookupQuery', () => {
  it('anchors free-text search to the name field, not a bare term', () => {
    const q = buildLookupQuery('void', EMPTY_FILTERS)
    expect(q).toBe('name:"void"')
  })

  it('strips embedded quotes from the search text', () => {
    const q = buildLookupQuery('"void"', EMPTY_FILTERS)
    expect(q).toBe('name:"void"')
  })

  it('still combines the name term with other filters', () => {
    const q = buildLookupQuery('crush', { ...EMPTY_FILTERS, rarity: ['mythic'], sets: ['who'] })
    expect(q).toBe('name:"crush" rarity:mythic set:who')
  })

  it('omits the name term entirely when search is empty', () => {
    const q = buildLookupQuery('', { ...EMPTY_FILTERS, rarity: ['rare'] })
    expect(q).toBe('rarity:rare')
  })
})

describe('hasLookupFilters', () => {
  it('is false when every filter is at its default', () => {
    expect(hasLookupFilters(EMPTY_FILTERS)).toBe(false)
  })

  it('is true when any filter is set', () => {
    expect(hasLookupFilters({ ...EMPTY_FILTERS, rarity: ['rare'] })).toBe(true)
  })
})

describe('fetchAutocomplete', () => {
  beforeEach(() => { searchCardNames.mockReset() })
  afterEach(() => { vi.restoreAllMocks() })

  // The dropdown is name-anchored + exact-match-first by construction now:
  // searchCardNames ranks exact → prefix → fuzzy server-side (and its Scryfall
  // fallback applies sortByNameRelevance), so "Void" can't be crowded out of
  // the capped list by oracle-text-only matches.
  it('delegates to searchCardNames with the trimmed term and the 9-entry cap', async () => {
    searchCardNames.mockResolvedValueOnce([{ id: 'exact', name: 'Void' }])
    const result = await fetchAutocomplete('  void ')
    expect(searchCardNames).toHaveBeenCalledWith('void', { limit: 9 })
    expect(result[0].name).toBe('Void')
  })

  it('returns [] without searching for a blank query', async () => {
    const result = await fetchAutocomplete('   ')
    expect(result).toEqual([])
    expect(searchCardNames).not.toHaveBeenCalled()
  })
})

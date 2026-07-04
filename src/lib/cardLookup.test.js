import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./scryfall', () => ({ sfGet: vi.fn() }))

import { fetchAutocomplete, buildLookupQuery, hasLookupFilters } from './cardLookup'
import { sfGet } from './scryfall'

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
  beforeEach(() => { sfGet.mockReset() })
  afterEach(() => { vi.restoreAllMocks() })

  it('sends the query anchored to name: so oracle-text mentions are excluded', async () => {
    sfGet.mockResolvedValueOnce({ data: [] })
    await fetchAutocomplete('void')
    const url = sfGet.mock.calls[0][0]
    expect(url).toContain(encodeURIComponent('name:"void"'))
  })

  it('returns [] without hitting Scryfall for a blank query', async () => {
    const result = await fetchAutocomplete('   ')
    expect(result).toEqual([])
    expect(sfGet).not.toHaveBeenCalled()
  })

  // Regression test for the reported bug: a bare "void" search matches every
  // card that mentions the word in oracle text, and with the dropdown capped
  // to 9 entries, those unrelated matches could crowd out the literal card
  // named "Void" entirely. name: anchoring plus relevance sorting fixes both.
  it('keeps an exact name match in the capped top-9 even with many other matches', async () => {
    const filler = Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, name: `Aardvark Void Nomad ${i}` }))
    sfGet.mockResolvedValueOnce({ data: [...filler, { id: 'exact', name: 'Void' }] })
    const result = await fetchAutocomplete('void')
    expect(result).toHaveLength(9)
    expect(result[0].name).toBe('Void')
  })
})

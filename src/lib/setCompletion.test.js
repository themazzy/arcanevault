import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('./scryfall', () => ({
  sfGet: vi.fn(),
  getPrice: (card, foil, { price_source } = {}) => {
    const field = price_source === 'tcgplayer_market' ? 'usd' : 'eur'
    const raw = card?.prices?.[field]
    return raw != null ? Number(raw) : null
  },
}))
vi.mock('./supabase', () => ({ sb: {} }))
vi.mock('./deckBuilderWrites', () => ({
  requireCardPrintIds: vi.fn(rows => Promise.resolve(rows)),
  toListItemRow: vi.fn(row => row),
}))

import { fetchSetCards, computeMissingCards, missingCostTotal, collectorNumberCompare } from './setCompletion'
import { sfGet } from './scryfall'

afterEach(() => vi.clearAllMocks())

describe('collectorNumberCompare', () => {
  it('sorts numerically, then lexically for suffixes and non-numeric numbers', () => {
    expect(['10', '2', '1'].sort(collectorNumberCompare)).toEqual(['1', '2', '10'])
    expect(['10a', '10', '2'].sort(collectorNumberCompare)).toEqual(['2', '10', '10a'])
  })
})

describe('computeMissingCards', () => {
  const setCards = [
    { name: 'Alpha', collector_number: '1' },
    { name: 'Beta', collector_number: '2' },
    { name: 'Gamma', collector_number: '10' },
  ]
  it('returns cards whose collector number is not owned, in collector order', () => {
    const missing = computeMissingCards(setCards, new Set(['2']))
    expect(missing.map(c => c.name)).toEqual(['Alpha', 'Gamma'])
  })
  it('returns empty when everything is owned', () => {
    expect(computeMissingCards(setCards, new Set(['1', '2', '10']))).toEqual([])
  })
})

describe('missingCostTotal', () => {
  it('sums prices in the active source and counts priced cards', () => {
    const missing = [
      { prices: { eur: '1.50', usd: '2.00' } },
      { prices: { eur: null, usd: '4.00' } },
      { prices: {} },
    ]
    const eur = missingCostTotal(missing, 'cardmarket_trend')
    expect(eur.total).toBeCloseTo(1.5)
    expect(eur.priced).toBe(1)

    const usd = missingCostTotal(missing, 'tcgplayer_market')
    expect(usd.total).toBeCloseTo(6)
    expect(usd.priced).toBe(2)
  })
})

describe('fetchSetCards', () => {
  it('paginates and caches per set code', async () => {
    sfGet
      .mockResolvedValueOnce({ data: [{ name: 'A', collector_number: '1' }], has_more: true, next_page: 'https://api.scryfall.com/p2' })
      .mockResolvedValueOnce({ data: [{ name: 'B', collector_number: '2' }], has_more: false })

    const cards = await fetchSetCards('tst')
    expect(cards.map(c => c.name)).toEqual(['A', 'B'])
    expect(sfGet).toHaveBeenCalledTimes(2)

    // Second call: served from the session cache.
    const again = await fetchSetCards('TST')
    expect(again).toHaveLength(2)
    expect(sfGet).toHaveBeenCalledTimes(2)
  })
})

import { describe, it, expect, vi } from 'vitest'

vi.mock('./scryfall', () => ({
  getPrice: (card, foil, { price_source } = {}) => {
    const field = price_source === 'tcgplayer_market' ? (foil ? 'usd_foil' : 'usd') : (foil ? 'eur_foil' : 'eur')
    const raw = card?.prices?.[field]
    return raw != null ? Number(raw) : null
  },
}))

import { pickPrintingForMode } from './printingOptimize'

const prints = [
  { id: 'a', released_at: '2019-01-01', prices: { eur: '5.00', eur_foil: '12.00' } },
  { id: 'b', released_at: '2023-06-01', prices: { eur: '1.50', eur_foil: '3.00' } },
  { id: 'c', released_at: '2015-03-01', prices: { eur: '9.00' } },              // no foil price
  { id: 'd', released_at: '2026-02-01', prices: {} },                            // unpriced
]

describe('pickPrintingForMode', () => {
  it('newest / oldest by released_at', () => {
    expect(pickPrintingForMode(prints, 'newest').id).toBe('d')  // 2026
    expect(pickPrintingForMode(prints, 'oldest').id).toBe('c')  // 2015
  })

  it('cheapest / expensive by nonfoil price, ignoring unpriced', () => {
    expect(pickPrintingForMode(prints, 'cheapest', { priceSource: 'cardmarket_trend' }).id).toBe('b') // 1.50
    expect(pickPrintingForMode(prints, 'expensive', { priceSource: 'cardmarket_trend' }).id).toBe('c') // 9.00
  })

  it('uses the foil price when foil=true', () => {
    // foil prices: a=12, b=3 (c/d none) → cheapest foil = b, expensive foil = a
    expect(pickPrintingForMode(prints, 'cheapest', { foil: true, priceSource: 'cardmarket_trend' }).id).toBe('b')
    expect(pickPrintingForMode(prints, 'expensive', { foil: true, priceSource: 'cardmarket_trend' }).id).toBe('a')
  })

  it('returns null when nothing is priced', () => {
    const none = [{ id: 'x', prices: {} }]
    expect(pickPrintingForMode(none, 'cheapest', { priceSource: 'cardmarket_trend' })).toBeNull()
  })

  it('returns null / handles empty input', () => {
    expect(pickPrintingForMode([], 'newest')).toBeNull()
    expect(pickPrintingForMode(null, 'cheapest')).toBeNull()
  })
})

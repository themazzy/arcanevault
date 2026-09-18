import { describe, it, expect } from 'vitest'
import { HISTORY_SOURCES, historySource } from './priceHistory'

// The chart and the stored series it read were removed 2026-09-18 (see
// priceHistory.js). What survives is the mapping price alerts speak through,
// so these assert the three fields the alert path actually reads —
// priceAlerts.js matches on `currency`, MoversPanel renders `symbol`/`label`.

describe('historySource', () => {
  it('maps each price source to its currency, symbol and label', () => {
    expect(historySource('cardmarket_trend')).toEqual({ symbol: '€', label: 'Cardmarket', currency: 'eur' })
    expect(historySource('tcgplayer_market')).toEqual({ symbol: '$', label: 'TCGplayer', currency: 'usd' })
  })

  it('falls back to Cardmarket for an unknown or missing source', () => {
    expect(historySource('something_else').currency).toBe('eur')
    expect(historySource(undefined).currency).toBe('eur')
    expect(historySource(null).currency).toBe('eur')
  })

  // card_price_moves.currency is written lowercase by the sync, and
  // priceAlerts.js compares it with `move.currency !== currency`. Uppercasing
  // these to match PRICE_SOURCES in scryfall.js would silently match nothing
  // and every alert would stop firing.
  it('keeps currency codes lowercase to match card_price_moves', () => {
    for (const source of Object.values(HISTORY_SOURCES)) {
      expect(source.currency).toBe(source.currency.toLowerCase())
    }
  })
})

import { describe, it, expect } from 'vitest'
import { currencyForPriceSource } from './priceSourceCurrency'

describe('currencyForPriceSource', () => {
  it('maps every known Scryfall price source to its real currency', () => {
    expect(currencyForPriceSource('cardmarket_trend')).toBe('EUR')
    expect(currencyForPriceSource('tcgplayer_market')).toBe('USD')
    expect(currencyForPriceSource('tcgplayer_etched')).toBe('USD')
    expect(currencyForPriceSource('mtgo_tix'))        .toBe('TIX')
  })

  it('returns the fallback for unknown / empty inputs', () => {
    expect(currencyForPriceSource('unknown'))      .toBe('EUR')
    expect(currencyForPriceSource(undefined))      .toBe('EUR')
    expect(currencyForPriceSource(null))           .toBe('EUR')
    expect(currencyForPriceSource(''))             .toBe('EUR')
  })

  it('honours a custom fallback when the source is unknown', () => {
    expect(currencyForPriceSource('unknown', 'USD')).toBe('USD')
    expect(currencyForPriceSource(null,      'TIX')).toBe('TIX')
  })

  it('regression: tcgplayer_etched and mtgo_tix are NOT EUR', () => {
    // The bug this helper fixes: the inline `=== "tcgplayer_market" ? "USD" : "EUR"`
    // ternary tagged etched cards and Magic Online tix cards as EUR.
    expect(currencyForPriceSource('tcgplayer_etched')).not.toBe('EUR')
    expect(currencyForPriceSource('mtgo_tix'))        .not.toBe('EUR')
  })
})

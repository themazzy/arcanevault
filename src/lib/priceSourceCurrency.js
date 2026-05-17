// Currency code for each Scryfall-derived price source. Used by Trading.jsx
// when stamping the purchase_price currency on received cards.
//
// Previously this was inlined as
//   price_source === 'tcgplayer_market' ? 'USD' : 'EUR'
// which incorrectly tagged tcgplayer_etched (USD) and mtgo_tix (TIX) as EUR.
const CURRENCY_BY_SOURCE = {
  cardmarket_trend: 'EUR',
  tcgplayer_market: 'USD',
  tcgplayer_etched: 'USD',
  mtgo_tix:         'TIX',
}

export function currencyForPriceSource(priceSource, fallback = 'EUR') {
  return CURRENCY_BY_SOURCE[priceSource] || fallback
}

/**
 * Which marketplace a price alert speaks in.
 *
 * All that remains of the price-history feature. The stored series and the
 * chart over it were removed 2026-09-18: card_price_history cost 142 MB of a
 * 500 MB database — a third of the budget for one chart — because the sync
 * rewrote all 101,579 rows daily as the window slid, so Postgres held ~1.6x
 * the live data as churn space that no VACUUM could return.
 *
 * Price alerts were deliberately kept, and cost nothing extra: movers are
 * computed from the staged arrays in memory during the sync and stored in
 * card_price_moves (~456 kB), so they never needed the history table at all.
 *
 * Kept separate from PRICE_SOURCES in src/lib/scryfall.js on purpose: that one
 * carries uppercase currency codes ('EUR') and longer labels, while
 * card_price_moves.currency is lowercase and MoversPanel wants the short name.
 * Merging the two means touching alert matching, which buys no space.
 */
export const HISTORY_SOURCES = {
  cardmarket_trend: { symbol: '€', label: 'Cardmarket', currency: 'eur' },
  tcgplayer_market: { symbol: '$', label: 'TCGplayer', currency: 'usd' },
}

export function historySource(priceSourceId) {
  return HISTORY_SOURCES[priceSourceId] || HISTORY_SOURCES.cardmarket_trend
}

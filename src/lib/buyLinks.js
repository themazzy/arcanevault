// Cross-vendor "buy this card" links. We deep-link to the exact card via
// Scryfall's purchase_uris when the cached card object carries them, and fall
// back to a name search on each vendor otherwise (always works, even offline
// caches that strip purchase_uris). Card Kingdom is name-search only — Scryfall
// does not expose a Card Kingdom purchase URI.

export const BUY_VENDORS = [
  {
    id: 'tcgplayer',
    label: 'TCGplayer',
    search: name => `https://www.tcgplayer.com/search/magic/product?productLineName=magic&q=${encodeURIComponent(name)}`,
  },
  {
    id: 'cardmarket',
    label: 'Cardmarket',
    search: name => `https://www.cardmarket.com/en/Magic/Products/Search?searchString=${encodeURIComponent(name)}`,
  },
  {
    id: 'cardkingdom',
    label: 'Card Kingdom',
    search: name => `https://www.cardkingdom.com/catalog/search?search=header&filter%5Bname%5D=${encodeURIComponent(name)}`,
  },
]

// Strip Scryfall affiliate/referral query noise but keep the deep link itself.
function cleanScryfallPurchaseUri(uri) {
  if (typeof uri !== 'string' || !/^https?:\/\//i.test(uri)) return null
  return uri
}

/**
 * @param {object} card  A Scryfall-shaped card ({ name, purchase_uris? }).
 * @returns {{id,label,url}[]}  One entry per vendor (empty if no name).
 */
export function buyLinksForCard(card) {
  const name = (card?.name || '').trim()
  if (!name) return []
  const pu = card?.purchase_uris || {}
  return BUY_VENDORS.map(v => {
    const exact = v.id === 'cardkingdom' ? null : cleanScryfallPurchaseUri(pu[v.id])
    return { id: v.id, label: v.label, url: exact || v.search(name) }
  })
}

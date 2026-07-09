// Scryfall lookup URLs for a card-detail view, most specific first.
// `cards/named?exact=` returns Scryfall's default (usually newest) printing,
// so it is only the last resort — deck rows know their exact print via
// scryfall_id or set_code + collector_number.
// `card` may be a deck-card-like object or a bare card name string.
const SF = 'https://api.scryfall.com'

export function scryfallCardDetailUrls(card) {
  const urls = []
  if (card && typeof card === 'object') {
    if (card.scryfall_id) urls.push(`${SF}/cards/${card.scryfall_id}`)
    if (card.set_code && card.collector_number) {
      urls.push(`${SF}/cards/${String(card.set_code).toLowerCase()}/${encodeURIComponent(card.collector_number)}`)
    }
  }
  const name = typeof card === 'string' ? card : card?.name
  if (name) urls.push(`${SF}/cards/named?exact=${encodeURIComponent(name)}&format=json`)
  return urls
}

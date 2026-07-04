/**
 * Shared helper for ranking Scryfall search results by name relevance.
 *
 * Bare Scryfall search terms (and even `name:` field searches) don't know that
 * a literal, exact name match should outrank a more popular card whose name
 * merely contains the same word — e.g. searching "Void" should surface the
 * card actually named "Void" ahead of "Void Winnower" or "Encroaching Void",
 * regardless of the requested sort order (name/released/edhrec/etc).
 */
export function sortByNameRelevance(cards, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return cards
  const rank = (card) => {
    const name = (card?.name || '').toLowerCase()
    if (name === q) return 0
    if (name.startsWith(q)) return 1
    return 2
  }
  return (cards || [])
    .map((card, index) => ({ card, index, rank: rank(card) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(entry => entry.card)
}

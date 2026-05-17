// Cheap content fingerprint over (id, qty, foil) tuples. Detects swaps,
// foil/non-foil changes, and replacements that pure length+totalQty miss.
// Used by Home's background-sync to decide whether to re-render.
export function cardsContentHash(cards) {
  if (!cards?.length) return '0'
  const parts = new Array(cards.length)
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i]
    parts[i] = `${c.id}:${c.qty || 1}:${c.foil ? 1 : 0}`
  }
  parts.sort()
  return parts.join('|')
}

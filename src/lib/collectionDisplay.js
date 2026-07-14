export function getCacheTtlMs(cacheTtlHours) {
  return Number(cacheTtlHours || 0) * 3600000
}

export function getSelectedDisplayQuantity(displayCards, selected, splitState) {
  const cardsByKey = new Map(
    (displayCards || []).map(card => [card._displayKey || card.id, card]),
  )

  return [...(selected || [])].reduce((sum, key) => {
    if (!cardsByKey.has(key)) return sum
    return sum + (splitState?.get(key) ?? 1)
  }, 0)
}

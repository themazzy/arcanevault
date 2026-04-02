function normalizeName(name) {
  return (name || '').trim().toLowerCase()
}

function cloneOwnedCards(cards) {
  return (cards || []).map(card => ({
    id: card.id,
    scryfall_id: card.scryfall_id || null,
    name: card.name || '',
    qty: card.qty || 0,
    card_print_id: card.card_print_id || null,
    set_code: card.set_code || null,
    collector_number: card.collector_number || null,
    foil: !!card.foil,
  }))
}

function sameExactPrinting(deckCard, ownedCard) {
  if (!deckCard || !ownedCard) return false
  if (deckCard.scryfall_id && ownedCard.scryfall_id && deckCard.scryfall_id !== ownedCard.scryfall_id) return false
  if (!!deckCard.foil !== !!ownedCard.foil) return false
  return true
}

function takeFromPool(pool, remainingById, qtyNeeded, predicate = null) {
  const allocations = []
  let remaining = qtyNeeded

  for (const card of pool) {
    if (remaining <= 0) break
    if (predicate && !predicate(card)) continue

    const available = remainingById.get(card.id) || 0
    if (available <= 0) continue

    const usedQty = Math.min(available, remaining)
    allocations.push({
      card_id: card.id,
      qty: usedQty,
      card_print_id: card.card_print_id || null,
      set_code: card.set_code || null,
      collector_number: card.collector_number || null,
      foil: !!card.foil,
      name: card.name || '',
      scryfall_id: card.scryfall_id || null,
    })
    remainingById.set(card.id, available - usedQty)
    remaining -= usedQty
  }

  return allocations
}

export function planDeckAllocations(deckCards, ownedCards) {
  const owned = cloneOwnedCards(ownedCards)
  const remainingById = new Map(owned.map(card => [card.id, card.qty]))
  const byScryfallId = new Map()
  const byName = new Map()

  for (const card of owned) {
    if (card.scryfall_id) {
      const list = byScryfallId.get(card.scryfall_id) || []
      list.push(card)
      byScryfallId.set(card.scryfall_id, list)
    }

    const nameKey = normalizeName(card.name)
    if (nameKey) {
      const list = byName.get(nameKey) || []
      list.push(card)
      byName.set(nameKey, list)
    }
  }

  const items = []

  for (const dc of deckCards || []) {
    const neededQty = dc.qty || 0
    const exactPool = dc.scryfall_id ? (byScryfallId.get(dc.scryfall_id) || []).filter(card => sameExactPrinting(dc, card)) : []
    const namePool = byName.get(normalizeName(dc.name)) || []
    const exactCandidates = exactPool
      .map(card => ({
        card_id: card.id,
        available_qty: remainingById.get(card.id) || 0,
        card_print_id: card.card_print_id || null,
        scryfall_id: card.scryfall_id || null,
        name: card.name || '',
        set_code: card.set_code || null,
        collector_number: card.collector_number || null,
        foil: !!card.foil,
      }))
      .filter(card => card.available_qty > 0)
    const otherCandidates = namePool
      .filter(card => !sameExactPrinting(dc, card))
      .map(card => ({
        card_id: card.id,
        available_qty: remainingById.get(card.id) || 0,
        card_print_id: card.card_print_id || null,
        scryfall_id: card.scryfall_id || null,
        name: card.name || '',
        set_code: card.set_code || null,
        collector_number: card.collector_number || null,
        foil: !!card.foil,
      }))
      .filter(card => card.available_qty > 0)

    const exactAllocations = takeFromPool(exactPool, remainingById, neededQty)
    const exactQty = exactAllocations.reduce((sum, row) => sum + row.qty, 0)
    const otherAllocations = takeFromPool(
      namePool,
      remainingById,
      neededQty - exactQty,
      card => !sameExactPrinting(dc, card)
    )
    const otherQty = otherAllocations.reduce((sum, row) => sum + row.qty, 0)
    const totalAdd = exactQty + otherQty

    items.push({
      dc,
      neededQty,
      addExact: exactQty,
      addOther: otherQty,
      totalAdd,
      missingQty: Math.max(0, neededQty - totalAdd),
      exactAllocations,
      otherAllocations,
      exactCandidates,
      otherCandidates,
      allocations: [...exactAllocations, ...otherAllocations],
    })
  }

  return items
}

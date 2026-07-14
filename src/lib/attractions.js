export const ATTRACTION_BOARD = 'attraction'
export const ATTRACTION_MIN_CONSTRUCTED = 10

export function isAttractionCard(card, sfCard = null) {
  const typeLine = String(sfCard?.type_line || card?.type_line || '')
  return /\bAttraction\b/i.test(typeLine)
}

export function attractionLightsOf(card, sfCard = null) {
  const lights = sfCard?.attraction_lights || card?.attraction_lights
  if (!Array.isArray(lights)) return []
  return [...new Set(lights.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 6))]
    .sort((a, b) => a - b)
}

export function formatAttractionLights(card, sfCard = null) {
  const lights = attractionLightsOf(card, sfCard)
  return lights.length ? lights.join(', ') : ''
}

// Attractions belong in their supplementary deck, but keeping one on the
// maybeboard is useful while brewing. Non-Attractions can never occupy the
// Attraction board.
export function boardForCard(card, sfCard = null, requestedBoard = 'main') {
  const requested = requestedBoard || 'main'
  if (isAttractionCard(card, sfCard)) return requested === 'maybe' ? 'maybe' : ATTRACTION_BOARD
  return requested === ATTRACTION_BOARD ? 'main' : requested
}

export function getAttractionDeckWarnings(cards, sfMap = {}) {
  const rows = Array.isArray(cards) ? cards : []
  const sfFor = card => sfMap[`${card?.set_code || ''}-${card?.collector_number || ''}`] || null
  const attractionRows = rows.filter(card => card?.board === ATTRACTION_BOARD)
  const misplaced = rows.filter(card => card?.board !== ATTRACTION_BOARD && card?.board !== 'maybe' && isAttractionCard(card, sfFor(card)))
  const warnings = []

  for (const card of misplaced) {
    warnings.push({
      key: `attraction-zone:${card.id || card.name}`,
      level: 'error',
      targetCardId: card.id,
      summary: `${card.name || 'Attraction'}: wrong deck`,
      detail: 'Attraction cards must be in the supplementary Attraction deck and do not count toward the main deck.',
    })
  }

  const invalid = attractionRows.filter(card => !isAttractionCard(card, sfFor(card)))
  for (const card of invalid) {
    warnings.push({
      key: `not-attraction:${card.id || card.name}`,
      level: 'error',
      targetCardId: card.id,
      summary: `${card.name || 'Card'} is not an Attraction`,
      detail: 'Only cards with the Attraction subtype can be in the Attraction deck.',
    })
  }

  if (!attractionRows.length) return warnings

  const count = attractionRows.reduce((sum, card) => sum + Math.max(0, Number(card.qty) || 0), 0)
  if (count < ATTRACTION_MIN_CONSTRUCTED) {
    warnings.push({
      key: 'attraction-size',
      level: 'error',
      summary: `Attraction deck ${count}/${ATTRACTION_MIN_CONSTRUCTED}`,
      detail: `Constructed Attraction decks require at least ${ATTRACTION_MIN_CONSTRUCTED} cards with different English names.`,
    })
  }

  const byName = new Map()
  for (const card of attractionRows) {
    const name = String(card?.name || '').trim().toLowerCase()
    if (!name) continue
    byName.set(name, [...(byName.get(name) || []), card])
  }
  for (const group of byName.values()) {
    const qty = group.reduce((sum, card) => sum + Math.max(0, Number(card.qty) || 0), 0)
    if (qty <= 1) continue
    const name = group[0]?.name || 'Attraction'
    warnings.push({
      key: `attraction-duplicate:${name.toLowerCase()}`,
      level: 'error',
      targetCardIds: group.map(card => card.id).filter(Boolean),
      summary: `${name}: ${qty} copies`,
      detail: 'Constructed Attraction decks may contain only one card of each English name. Choose one light-pattern printing.',
    })
  }

  return warnings
}

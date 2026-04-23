export function getCardLegalityWarnings({
  card,
  formatId,
  formatLabel,
  isEDH = false,
  commanderColorIdentity = [],
} = {}) {
  if (!card) return []

  const warnings = []
  const cardName = card.name || 'This card'
  const identity = Array.isArray(card.color_identity) ? card.color_identity : []
  const allowed = Array.isArray(commanderColorIdentity) ? commanderColorIdentity : []

  if (isEDH && allowed.length > 0) {
    const outside = identity.filter(color => !allowed.includes(color))
    if (outside.length) {
      warnings.push({
        reason: 'color_identity',
        text: `${cardName} is outside commander color identity (${outside.join('')}).`,
      })
    }
  }

  const legality = card.legalities?.[formatId]
  if (legality === 'not_legal' || legality === 'banned') {
    warnings.push({
      reason: 'format_legality',
      text: `${cardName} is ${legality.replace('_', ' ')} in ${formatLabel || formatId || 'this format'}.`,
    })
  }

  return warnings
}

const WARNING_GROUPS = [
  { id: 'requirements', label: 'Deck requirements' },
  { id: 'color', label: 'Color identity' },
  { id: 'legality', label: 'Format legality' },
  { id: 'copies', label: 'Copy limits' },
  { id: 'attractions', label: 'Attraction deck' },
  { id: 'companion', label: 'Companion' },
  { id: 'other', label: 'Other issues' },
]

export function getWarningTargetIds(warning) {
  if (!warning) return []
  const values = warning.targetCardIds || (warning.targetCardId ? [warning.targetCardId] : [])
  return [...new Set(values.map(String).filter(Boolean))]
}

export function getFirstWarningTargetId(warnings, validCardIds = null) {
  const allowed = validCardIds ? new Set([...validCardIds].map(String)) : null
  for (const warning of warnings || []) {
    const target = getWarningTargetIds(warning).find(id => !allowed || allowed.has(id))
    if (target) return target
  }
  return null
}

export function getWarningGroupId(warning) {
  const key = String(warning?.key || '')
  if (/^(color:|companion-ci)/.test(key)) return 'color'
  if (/^(legality:|restricted:)/.test(key)) return 'legality'
  if (/^(duplicate:|attraction-duplicate:)/.test(key)) return 'copies'
  if (/^(attraction-|not-attraction:)/.test(key)) return 'attractions'
  if (/^companion/.test(key)) return 'companion'
  if (/^(size-|no-commander|commander)/.test(key)) return 'requirements'
  return 'other'
}

export function groupDeckWarnings(warnings) {
  const grouped = new Map(WARNING_GROUPS.map(group => [group.id, []]))
  for (const warning of warnings || []) {
    grouped.get(getWarningGroupId(warning)).push(warning)
  }
  return WARNING_GROUPS
    .map(group => ({ ...group, warnings: grouped.get(group.id) }))
    .filter(group => group.warnings.length > 0)
}

export function getDeckWarningRevealPlan({
  targetId,
  deckCards,
  visibleDeckCards,
  groupBy,
  deckView,
  getCardGroup,
  normalizeBoard,
}) {
  const normalizedTargetId = String(targetId || '')
  const card = (deckCards || []).find(row => String(row.id) === normalizedTargetId)
  if (!card) return null

  let collapsedKey = null
  if (groupBy !== 'none') {
    const board = normalizeBoard(card.board)
    const group = getCardGroup(card)
    collapsedKey = deckView === 'stacks' ? `${board}:stack:${group}` : `${board}:${group}`
  }

  return {
    card,
    targetId: normalizedTargetId,
    clearFilters: !(visibleDeckCards || []).some(row => String(row.id) === normalizedTargetId),
    collapsedKey,
  }
}

export function scrollAndFocusDeckWarningTarget(container, targetId, { reduceMotion = false } = {}) {
  const normalizedTargetId = String(targetId)
  const target = [...(container?.querySelectorAll('[data-deck-card-id]') || [])]
    .find(element => element.dataset.deckCardId === normalizedTargetId)

  if (!target) return null

  target.scrollIntoView({
    behavior: reduceMotion ? 'auto' : 'smooth',
    block: 'center',
    inline: 'nearest',
  })
  try { target.focus({ preventScroll: true }) } catch { target.focus() }
  return target
}

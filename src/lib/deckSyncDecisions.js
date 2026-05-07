/**
 * Pure helpers used by SyncModal / MakeDeckModal to render decision rows and
 * categorize sync diffs. No React, no IO. Safe to test directly.
 */

// ── Allocation planning ─────────────────────────────────────────────────────

export function buildChosenAllocations(item, exactVersionOnly, chosenOtherCardId) {
  const exactAllocations = item.exactAllocations || []
  const exactQty = exactAllocations.reduce((sum, row) => sum + row.qty, 0)
  let otherAllocations = exactVersionOnly ? [] : (item.otherAllocations || [])

  if (!exactVersionOnly && chosenOtherCardId) {
    const candidate = (item.otherCandidates || []).find(row => row.card_id === chosenOtherCardId)
    const remainingNeeded = Math.max(0, (item.neededQty || 0) - exactQty)
    if (candidate && remainingNeeded > 0) {
      // Honor the user's explicit pick: use up to what's available on the chosen
      // candidate, even if it can't cover everything. Anything left over falls
      // through to missingQty rather than silently substituting a different
      // printing the user didn't choose.
      const useQty = Math.min(remainingNeeded, candidate.available_qty || 0)
      otherAllocations = useQty > 0
        ? [{
            card_id: candidate.card_id,
            qty: useQty,
            card_print_id: candidate.card_print_id || null,
            scryfall_id: candidate.scryfall_id || null,
            name: candidate.name || item.dc.name,
            set_code: candidate.set_code || null,
            collector_number: candidate.collector_number || null,
            foil: !!candidate.foil,
          }]
        : []
    }
  }

  const addExact = exactQty
  const addOther = otherAllocations.reduce((sum, row) => sum + row.qty, 0)
  const totalAdd = addExact + addOther
  return {
    exactAllocations,
    otherAllocations,
    allocations: [...exactAllocations, ...otherAllocations],
    addExact,
    addOther,
    totalAdd,
    missingQty: Math.max(0, (item.neededQty || 0) - totalAdd),
  }
}

export function buildChosenPrintingSelections(items, chosenOtherCardIds) {
  return (items || [])
    .map(item => {
      const chosenCardId = chosenOtherCardIds?.[item.dc.id]
      if (!chosenCardId) return null
      const candidate = (item.otherCandidates || []).find(row => row.card_id === chosenCardId)
      if (!candidate) return null
      return {
        deckCardId: item.dc.id,
        candidate,
      }
    })
    .filter(Boolean)
}

// ── Format helpers ──────────────────────────────────────────────────────────

export function formatOwnedPrinting(row) {
  if (!row) return 'owned printing'
  const setPart = row.set_code ? String(row.set_code).toUpperCase() : null
  const numberPart = row.collector_number ? `#${row.collector_number}` : null
  const parts = [setPart, numberPart].filter(Boolean)
  const label = parts.length ? parts.join(' ') : 'owned printing'
  return row.foil ? `${label} foil` : label
}

export function formatQtyLabel(qty, suffix = 'copy') {
  if (qty === 1) return `${qty} ${suffix}`
  return `${qty} ${suffix === 'copy' ? 'copies' : `${suffix}s`}`
}

export function getFolderKindLabel(folderOrType) {
  const type = typeof folderOrType === 'string' ? folderOrType : folderOrType?.type
  return type === 'binder' ? 'Binder' : type === 'deck' ? 'Deck' : 'Folder'
}

export function formatPlacementLabel(folder) {
  if (!folder) return 'Collection'
  return `${getFolderKindLabel(folder)}: ${folder.name || 'Untitled'}`
}

export function summarizePlacementParts(parts) {
  const merged = new Map()
  for (const part of parts || []) {
    const key = `${part.type || ''}:${part.name || ''}`
    const existing = merged.get(key) || { ...part, qty: 0 }
    existing.qty += part.qty || 0
    merged.set(key, existing)
  }
  const labels = [...merged.values()].map(part => `${part.qty}x ${formatPlacementLabel(part)}`)
  if (!labels.length) return 'available collection placements'
  if (labels.length <= 2) return labels.join(', ')
  return `${labels.slice(0, 2).join(', ')} +${labels.length - 2} more`
}

// ── Decision categorization & previews ──────────────────────────────────────

export function getDecisionCategory(row, builderOnly, collectionOnly) {
  if (builderOnly.some(item => item.key === row.key)) return 'builderOnly'
  if (collectionOnly.some(item => item.key === row.key)) return 'collectionOnly'
  return 'conflict'
}

export function getDecisionPreview(row, resolution, context = {}) {
  const {
    addedByKey = new Map(),
    changedByKey = new Map(),
    removedByKey = new Map(),
    selectedMoveTarget = null,
  } = context

  const name = row.builder?.name || row.collection?.name || 'Card'
  if (resolution === 'keep') return `${name} stays unchanged in both places for now.`
  if (resolution === 'collection') {
    if ((row.collectionQty || 0) === (row.builderQty || 0)) return `${name} already matches the current Collection Deck.`
    return `Deck Builder will change from ${row.builderQty || 0} to ${row.collectionQty || 0}. Collection cards stay where they are.`
  }

  const addItem = addedByKey.get(row.key)
  if (addItem) {
    if (addItem.totalAdd > 0 && addItem.missingQty > 0) {
      return `Move ${addItem.totalAdd} owned ${addItem.totalAdd === 1 ? 'copy' : 'copies'} into Collection Deck. ${addItem.missingQty} ${addItem.missingQty === 1 ? 'copy is' : 'copies are'} still missing.`
    }
    if (addItem.totalAdd > 0) {
      return `Move ${addItem.totalAdd} owned ${addItem.totalAdd === 1 ? 'copy' : 'copies'} into Collection Deck.`
    }
    if (addItem.missingQty > 0) {
      return `${addItem.missingQty} ${addItem.missingQty === 1 ? 'copy is' : 'copies are'} missing, so no collection copies can move in.`
    }
  }

  const changedItem = changedByKey.get(row.key)
  if (changedItem) {
    if (changedItem.newQty > changedItem.oldQty) {
      const delta = changedItem.newQty - changedItem.oldQty
      return `Increase Collection Deck by ${delta} ${delta === 1 ? 'copy' : 'copies'}.`
    }
    if (changedItem.newQty < changedItem.oldQty) {
      const delta = changedItem.oldQty - changedItem.newQty
      const destLabel = selectedMoveTarget
        ? `${selectedMoveTarget.type === 'binder' ? 'Binder' : 'Deck'}: ${selectedMoveTarget.name}`
        : 'your chosen destination'
      return `Move ${delta} ${delta === 1 ? 'copy' : 'copies'} out of Collection Deck to ${destLabel}.`
    }
  }

  const removedItem = removedByKey.get(row.key)
  if (removedItem) {
    const delta = removedItem.allocRow?.qty || 0
    const destLabel = selectedMoveTarget
      ? `${selectedMoveTarget.type === 'binder' ? 'Binder' : 'Deck'}: ${selectedMoveTarget.name}`
      : 'your chosen destination'
    return `Move all ${delta} ${delta === 1 ? 'copy' : 'copies'} out of Collection Deck to ${destLabel}.`
  }

  return `${name} will follow the Deck Builder version.`
}

export function getDecisionOptionLabels(row, context = {}) {
  const { addedByKey = new Map() } = context
  if (row.category === 'builderOnly') {
    const addItem = addedByKey.get(row.key)
    const hasOwned = (addItem?.totalAdd || 0) > 0
    const hasMissing = (addItem?.missingQty || 0) > 0
    const builderLabel = hasOwned && hasMissing
      ? 'Add owned copies, keep rest missing'
      : hasOwned
        ? 'Add owned copy to Collection Deck'
        : 'Keep as missing in Deck Builder'
    return {
      builder: builderLabel,
      collection: 'Remove from Deck Builder',
      keep: 'Leave unsynced',
    }
  }

  if (row.category === 'collectionOnly') {
    return {
      builder: 'Move out of Collection Deck',
      collection: 'Add back to Deck Builder',
      keep: 'Leave in Collection Deck only',
    }
  }

  return {
    builder: 'Match Collection Deck to Builder',
    collection: 'Match Builder to Collection Deck',
    keep: 'Leave quantity mismatch',
  }
}

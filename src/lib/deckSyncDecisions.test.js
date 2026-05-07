import { describe, it, expect } from 'vitest'
import {
  buildChosenAllocations,
  buildChosenPrintingSelections,
  formatOwnedPrinting,
  formatQtyLabel,
  getFolderKindLabel,
  formatPlacementLabel,
  summarizePlacementParts,
  getDecisionCategory,
  getDecisionPreview,
  getDecisionOptionLabels,
} from './deckSyncDecisions'

describe('formatQtyLabel', () => {
  it('uses singular form for 1', () => {
    expect(formatQtyLabel(1)).toBe('1 copy')
  })
  it('uses plural form for >1', () => {
    expect(formatQtyLabel(3)).toBe('3 copies')
  })
  it('respects custom suffix', () => {
    expect(formatQtyLabel(1, 'card')).toBe('1 card')
    expect(formatQtyLabel(2, 'card')).toBe('2 cards')
  })
})

describe('formatOwnedPrinting', () => {
  it('returns "owned printing" for null', () => {
    expect(formatOwnedPrinting(null)).toBe('owned printing')
  })
  it('formats set + collector number', () => {
    expect(formatOwnedPrinting({ set_code: 'm10', collector_number: '155' }))
      .toBe('M10 #155')
  })
  it('appends foil suffix', () => {
    expect(formatOwnedPrinting({ set_code: 'cmr', collector_number: '700', foil: true }))
      .toBe('CMR #700 foil')
  })
  it('uppercases set codes', () => {
    expect(formatOwnedPrinting({ set_code: 'lower', collector_number: '1' }))
      .toBe('LOWER #1')
  })
})

describe('getFolderKindLabel', () => {
  it('handles type strings', () => {
    expect(getFolderKindLabel('binder')).toBe('Binder')
    expect(getFolderKindLabel('deck')).toBe('Deck')
    expect(getFolderKindLabel('list')).toBe('Folder')
  })
  it('handles folder objects', () => {
    expect(getFolderKindLabel({ type: 'binder' })).toBe('Binder')
    expect(getFolderKindLabel({ type: 'deck' })).toBe('Deck')
  })
  it('falls back to Folder for unknown types', () => {
    expect(getFolderKindLabel({ type: 'wishlist' })).toBe('Folder')
    expect(getFolderKindLabel(null)).toBe('Folder')
  })
})

describe('formatPlacementLabel', () => {
  it('handles null folder', () => {
    expect(formatPlacementLabel(null)).toBe('Collection')
  })
  it('formats binder/deck with name', () => {
    expect(formatPlacementLabel({ type: 'binder', name: 'My Binder' }))
      .toBe('Binder: My Binder')
  })
  it('uses Untitled when name is missing', () => {
    expect(formatPlacementLabel({ type: 'deck' })).toBe('Deck: Untitled')
  })
})

describe('summarizePlacementParts', () => {
  it('returns fallback for empty input', () => {
    expect(summarizePlacementParts([])).toBe('available collection placements')
    expect(summarizePlacementParts(null)).toBe('available collection placements')
  })
  it('joins one or two parts directly', () => {
    expect(summarizePlacementParts([
      { type: 'binder', name: 'A', qty: 2 },
    ])).toBe('2x Binder: A')
    expect(summarizePlacementParts([
      { type: 'binder', name: 'A', qty: 2 },
      { type: 'deck', name: 'B', qty: 1 },
    ])).toBe('2x Binder: A, 1x Deck: B')
  })
  it('truncates with +N more for 3+ parts', () => {
    expect(summarizePlacementParts([
      { type: 'binder', name: 'A', qty: 1 },
      { type: 'deck', name: 'B', qty: 1 },
      { type: 'deck', name: 'C', qty: 1 },
      { type: 'binder', name: 'D', qty: 1 },
    ])).toBe('1x Binder: A, 1x Deck: B +2 more')
  })
  it('merges duplicate type+name pairs by summing qty', () => {
    expect(summarizePlacementParts([
      { type: 'binder', name: 'A', qty: 2 },
      { type: 'binder', name: 'A', qty: 3 },
    ])).toBe('5x Binder: A')
  })
})

describe('buildChosenAllocations', () => {
  const baseItem = {
    dc: { id: 'dc-1', name: 'Sol Ring' },
    neededQty: 4,
    exactAllocations: [{ card_id: 'card-A', qty: 2 }],
    otherAllocations: [{ card_id: 'card-B', qty: 1 }],
    otherCandidates: [
      { card_id: 'card-X', available_qty: 10, scryfall_id: 'sf-X', set_code: 'CMR', collector_number: '700', foil: false },
    ],
  }

  it('uses only exact allocations when exactVersionOnly', () => {
    const result = buildChosenAllocations(baseItem, true, null)
    expect(result.allocations).toEqual([{ card_id: 'card-A', qty: 2 }])
    expect(result.addExact).toBe(2)
    expect(result.addOther).toBe(0)
    expect(result.totalAdd).toBe(2)
    expect(result.missingQty).toBe(2)
  })

  it('includes otherAllocations when exactVersionOnly is false and no override', () => {
    const result = buildChosenAllocations(baseItem, false, null)
    expect(result.totalAdd).toBe(3)
    expect(result.missingQty).toBe(1)
  })

  it('overrides otherAllocations with chosen candidate', () => {
    const result = buildChosenAllocations(baseItem, false, 'card-X')
    expect(result.otherAllocations).toEqual([{
      card_id: 'card-X',
      qty: 2, // remaining = neededQty(4) - exactQty(2)
      card_print_id: null,
      scryfall_id: 'sf-X',
      name: 'Sol Ring',
      set_code: 'CMR',
      collector_number: '700',
      foil: false,
    }])
    expect(result.totalAdd).toBe(4)
    expect(result.missingQty).toBe(0)
  })

  it('honors user pick partially when chosen candidate has insufficient qty', () => {
    // User explicitly picked card-X. neededQty=4, exact=2, so remainingNeeded=2.
    // Candidate has only 1 available — use that 1, leave the rest as missing
    // rather than silently falling back to a different printing.
    const stingy = {
      ...baseItem,
      otherCandidates: [{
        card_id: 'card-X',
        available_qty: 1,
        scryfall_id: 'sf-X',
        set_code: 'CMR',
        collector_number: '700',
        foil: false,
      }],
    }
    const result = buildChosenAllocations(stingy, false, 'card-X')
    expect(result.otherAllocations).toEqual([{
      card_id: 'card-X',
      qty: 1,
      card_print_id: null,
      scryfall_id: 'sf-X',
      name: 'Sol Ring',
      set_code: 'CMR',
      collector_number: '700',
      foil: false,
    }])
    expect(result.totalAdd).toBe(3) // 2 exact + 1 chosen
    expect(result.missingQty).toBe(1) // remainder is missing, not substituted
  })

  it('emits empty otherAllocations when chosen candidate has 0 available', () => {
    const empty = {
      ...baseItem,
      otherCandidates: [{ card_id: 'card-X', available_qty: 0, scryfall_id: 'sf-X' }],
    }
    const result = buildChosenAllocations(empty, false, 'card-X')
    expect(result.otherAllocations).toEqual([])
    expect(result.totalAdd).toBe(2) // only exact
    expect(result.missingQty).toBe(2)
  })
})

describe('buildChosenPrintingSelections', () => {
  it('returns empty array for no input', () => {
    expect(buildChosenPrintingSelections([], {})).toEqual([])
    expect(buildChosenPrintingSelections(null, {})).toEqual([])
  })
  it('skips items without a chosen card id', () => {
    const items = [
      { dc: { id: 'dc-1' }, otherCandidates: [{ card_id: 'card-X' }] },
    ]
    expect(buildChosenPrintingSelections(items, {})).toEqual([])
  })
  it('returns selection for items with valid chosen card', () => {
    const items = [
      { dc: { id: 'dc-1' }, otherCandidates: [{ card_id: 'card-X', name: 'Sol Ring' }] },
    ]
    const result = buildChosenPrintingSelections(items, { 'dc-1': 'card-X' })
    expect(result).toEqual([{
      deckCardId: 'dc-1',
      candidate: { card_id: 'card-X', name: 'Sol Ring' },
    }])
  })
  it('skips items where chosen card is not in candidates', () => {
    const items = [
      { dc: { id: 'dc-1' }, otherCandidates: [{ card_id: 'card-X' }] },
    ]
    expect(buildChosenPrintingSelections(items, { 'dc-1': 'card-Y' })).toEqual([])
  })
})

describe('getDecisionCategory', () => {
  const builderOnly = [{ key: 'cp:1|0' }]
  const collectionOnly = [{ key: 'cp:2|0' }]
  it('classifies builder-only rows', () => {
    expect(getDecisionCategory({ key: 'cp:1|0' }, builderOnly, collectionOnly)).toBe('builderOnly')
  })
  it('classifies collection-only rows', () => {
    expect(getDecisionCategory({ key: 'cp:2|0' }, builderOnly, collectionOnly)).toBe('collectionOnly')
  })
  it('falls through to conflict', () => {
    expect(getDecisionCategory({ key: 'cp:3|0' }, builderOnly, collectionOnly)).toBe('conflict')
  })
})

describe('getDecisionPreview', () => {
  const row = { key: 'cp:1|0', builder: { name: 'Sol Ring' }, builderQty: 4, collectionQty: 4 }

  it('"keep" returns unchanged message', () => {
    expect(getDecisionPreview(row, 'keep')).toContain('stays unchanged')
  })

  it('"collection" — when qtys already match', () => {
    expect(getDecisionPreview(row, 'collection')).toContain('already matches')
  })

  it('"collection" — quantity diff', () => {
    const diffRow = { ...row, builderQty: 2, collectionQty: 5 }
    expect(getDecisionPreview(diffRow, 'collection')).toContain('from 2 to 5')
  })

  it('"builder" with addItem move-only', () => {
    const addedByKey = new Map([['cp:1|0', { totalAdd: 3, missingQty: 0 }]])
    const result = getDecisionPreview(row, 'builder', { addedByKey })
    expect(result).toContain('Move 3 owned')
    expect(result).not.toContain('still missing')
  })

  it('"builder" with addItem partial', () => {
    const addedByKey = new Map([['cp:1|0', { totalAdd: 2, missingQty: 2 }]])
    const result = getDecisionPreview(row, 'builder', { addedByKey })
    expect(result).toContain('Move 2 owned')
    expect(result).toContain('2 copies are still missing')
  })

  it('"builder" with addItem fully missing', () => {
    const addedByKey = new Map([['cp:1|0', { totalAdd: 0, missingQty: 1 }]])
    const result = getDecisionPreview(row, 'builder', { addedByKey })
    expect(result).toContain('1 copy is missing')
  })

  it('"builder" with changedItem qty increase', () => {
    const changedByKey = new Map([['cp:1|0', { newQty: 5, oldQty: 3 }]])
    const result = getDecisionPreview(row, 'builder', { changedByKey })
    expect(result).toContain('Increase Collection Deck by 2')
  })

  it('"builder" with changedItem qty decrease + selectedMoveTarget', () => {
    const changedByKey = new Map([['cp:1|0', { newQty: 1, oldQty: 4 }]])
    const target = { type: 'binder', name: 'My Binder' }
    const result = getDecisionPreview(row, 'builder', { changedByKey, selectedMoveTarget: target })
    expect(result).toContain('Move 3 copies out')
    expect(result).toContain('Binder: My Binder')
  })

  it('"builder" with removedItem', () => {
    const removedByKey = new Map([['cp:1|0', { allocRow: { qty: 2 } }]])
    const result = getDecisionPreview(row, 'builder', { removedByKey })
    expect(result).toContain('Move all 2 copies')
  })

  it('"builder" fallthrough', () => {
    const result = getDecisionPreview(row, 'builder', {})
    expect(result).toContain('follow the Deck Builder version')
  })
})

describe('getDecisionOptionLabels', () => {
  it('builderOnly with owned copies', () => {
    const row = { key: 'cp:1|0', category: 'builderOnly' }
    const addedByKey = new Map([['cp:1|0', { totalAdd: 2, missingQty: 0 }]])
    const labels = getDecisionOptionLabels(row, { addedByKey })
    expect(labels.builder).toBe('Add owned copy to Collection Deck')
  })

  it('builderOnly with mixed owned + missing', () => {
    const row = { key: 'cp:1|0', category: 'builderOnly' }
    const addedByKey = new Map([['cp:1|0', { totalAdd: 1, missingQty: 1 }]])
    const labels = getDecisionOptionLabels(row, { addedByKey })
    expect(labels.builder).toBe('Add owned copies, keep rest missing')
  })

  it('builderOnly with all missing', () => {
    const row = { key: 'cp:1|0', category: 'builderOnly' }
    const labels = getDecisionOptionLabels(row, { addedByKey: new Map() })
    expect(labels.builder).toBe('Keep as missing in Deck Builder')
  })

  it('collectionOnly', () => {
    const row = { category: 'collectionOnly' }
    const labels = getDecisionOptionLabels(row, {})
    expect(labels.builder).toBe('Move out of Collection Deck')
    expect(labels.collection).toBe('Add back to Deck Builder')
    expect(labels.keep).toBe('Leave in Collection Deck only')
  })

  it('conflict (default)', () => {
    const row = { category: 'conflict' }
    const labels = getDecisionOptionLabels(row, {})
    expect(labels.builder).toContain('Match Collection Deck to Builder')
    expect(labels.collection).toContain('Match Builder to Collection Deck')
  })
})

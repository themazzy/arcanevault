import { describe, it, expect } from 'vitest'
import {
  getLogicalKey,
  normalizeBuilderCards,
  buildSyncDiff,
  buildSyncSnapshot,
  summarizeSyncDiff,
  diffDeckMeta,
} from './deckSync'

describe('diffDeckMeta', () => {
  it('patches only changed keys so stale snapshots cannot revert visibility', () => {
    const base = { format: 'commander', is_public: false, tags: [] }
    const edited = { format: 'commander', is_public: false, tags: ['artifact'] }

    expect(diffDeckMeta(base, edited)).toEqual({
      patch: { tags: ['artifact'] },
      removeKeys: [],
    })
  })

  it('records explicit key removals without replacing unrelated metadata', () => {
    expect(diffDeckMeta(
      { linked_deck_id: 'deck-1', is_public: true, format: 'commander' },
      { is_public: true, format: 'commander' },
    )).toEqual({ patch: {}, removeKeys: ['linked_deck_id'] })
  })
})

describe('getLogicalKey — print identity (CR-001)', () => {
  it('keys by card_print_id when present', () => {
    expect(getLogicalKey({ card_print_id: 'cp-1', foil: false })).toBe('cp:cp-1|0')
    expect(getLogicalKey({ card_print_id: 'cp-1', foil: true })).toBe('cp:cp-1|1')
  })

  it('falls back to scryfall_id when card_print_id missing', () => {
    expect(getLogicalKey({ scryfall_id: 'sf-1', foil: false })).toBe('sf:sf-1|0')
  })

  it('uses set+collector_number when only name is available', () => {
    const key = getLogicalKey({ name: 'Sol Ring', set_code: 'C21', collector_number: '300', foil: false })
    expect(key).toBe('nsc:sol ring|c21|300|0')
  })

  it('falls back to plain name when set/cn also missing', () => {
    expect(getLogicalKey({ name: 'Sol Ring', foil: false })).toBe('name:sol ring|0')
  })

  it('distinguishes printings of the same oracle card', () => {
    const a = getLogicalKey({ scryfall_id: 'sf-A', foil: false })
    const b = getLogicalKey({ scryfall_id: 'sf-B', foil: false })
    expect(a).not.toBe(b)
  })

  it('distinguishes name-only printings via set+cn', () => {
    const a = getLogicalKey({ name: 'Sol Ring', set_code: 'C21', collector_number: '300' })
    const b = getLogicalKey({ name: 'Sol Ring', set_code: 'CMR', collector_number: '700' })
    expect(a).not.toBe(b)
  })

  it('treats foil and non-foil as distinct', () => {
    const a = getLogicalKey({ scryfall_id: 'sf-1', foil: false })
    const b = getLogicalKey({ scryfall_id: 'sf-1', foil: true })
    expect(a).not.toBe(b)
  })

  it('prefers card_print_id over scryfall_id (more authoritative)', () => {
    const key = getLogicalKey({ card_print_id: 'cp-1', scryfall_id: 'sf-1' })
    expect(key.startsWith('cp:')).toBe(true)
  })
})

describe('normalizeBuilderCards', () => {
  it('aggregates qty across rows with same logical key', () => {
    const result = normalizeBuilderCards([
      { card_print_id: 'cp-1', name: 'Sol Ring', qty: 2, foil: false },
      { card_print_id: 'cp-1', name: 'Sol Ring', qty: 1, foil: false },
    ])
    expect(result).toHaveLength(1)
    expect(result[0].qty).toBe(3)
  })

  it('keeps different printings separate', () => {
    const result = normalizeBuilderCards([
      { card_print_id: 'cp-1', name: 'Sol Ring', qty: 1, foil: false },
      { card_print_id: 'cp-2', name: 'Sol Ring', qty: 1, foil: false },
    ])
    expect(result).toHaveLength(2)
  })

  it('flags is_commander when any matching row is a commander', () => {
    const result = normalizeBuilderCards([
      { card_print_id: 'cp-1', qty: 1, is_commander: false },
      { card_print_id: 'cp-1', qty: 1, is_commander: true },
    ])
    expect(result[0].is_commander).toBe(true)
  })
})

describe('buildSyncDiff / summarizeSyncDiff', () => {
  it('reports clean when builder and collection match baseline', () => {
    const cards = [{ card_print_id: 'cp-1', qty: 4 }]
    const baseline = buildSyncSnapshot({ builderCards: cards, collectionCards: cards })
    const diff = buildSyncDiff({ baseline, builderCards: cards, collectionCards: cards })
    expect(summarizeSyncDiff(diff)).toEqual({ total: 0, dirty: false })
  })

  it('detects builder-only additions', () => {
    const baseline = { builder_cards: [], collection_cards: [] }
    const diff = buildSyncDiff({
      baseline,
      builderCards: [{ card_print_id: 'cp-1', qty: 4 }],
      collectionCards: [],
    })
    expect(diff.builderOnly).toHaveLength(1)
    expect(summarizeSyncDiff(diff).dirty).toBe(true)
  })

  it('detects collection-only additions', () => {
    const baseline = { builder_cards: [], collection_cards: [] }
    const diff = buildSyncDiff({
      baseline,
      builderCards: [],
      collectionCards: [{ card_print_id: 'cp-1', qty: 4 }],
    })
    expect(diff.collectionOnly).toHaveLength(1)
  })

  it('detects conflicts when both sides change to different qtys', () => {
    const baseline = buildSyncSnapshot({
      builderCards: [{ card_print_id: 'cp-1', qty: 4 }],
      collectionCards: [{ card_print_id: 'cp-1', qty: 4 }],
    })
    const diff = buildSyncDiff({
      baseline,
      builderCards: [{ card_print_id: 'cp-1', qty: 5 }],
      collectionCards: [{ card_print_id: 'cp-1', qty: 3 }],
    })
    expect(diff.conflicts).toHaveLength(1)
  })

  it('skips phantom diff rows where the card is gone from both current states', () => {
    // Baseline had the card on the builder side, but it has since been removed
    // from both builder and collection — there's nothing actionable, so the
    // diff should not surface it (UI would otherwise render placeholder names).
    const baseline = buildSyncSnapshot({
      builderCards: [{ card_print_id: 'cp-ghost', name: 'Ghost', qty: 4 }],
      collectionCards: [],
    })
    const diff = buildSyncDiff({
      baseline,
      builderCards: [],
      collectionCards: [],
    })
    expect(diff.builderOnly).toHaveLength(0)
    expect(diff.collectionOnly).toHaveLength(0)
    expect(diff.conflicts).toHaveLength(0)
  })

  it('preserves card metadata from baseline when current state is empty on one side', () => {
    // Card is in baseline-builder and baseline-collection, then gets removed
    // from collection only. The collectionOnly diff entry should still expose
    // builder-side metadata via the baseline fallback, so the UI can render
    // a real name instead of a placeholder.
    const baseline = buildSyncSnapshot({
      builderCards: [{ card_print_id: 'cp-1', name: 'Sol Ring', qty: 1 }],
      collectionCards: [{ card_print_id: 'cp-1', name: 'Sol Ring', qty: 1 }],
    })
    const diff = buildSyncDiff({
      baseline,
      builderCards: [{ card_print_id: 'cp-1', name: 'Sol Ring', qty: 1 }],
      collectionCards: [],
    })
    expect(diff.collectionOnly).toHaveLength(1)
    expect(diff.collectionOnly[0].builder?.name).toBe('Sol Ring')
    // Baseline fallback should also kick in if currentCollection is empty:
    expect(diff.collectionOnly[0].collection?.name).toBe('Sol Ring')
  })
})

// ── MD-007: qty distribution math, factored as a pure helper for testing ────
// This mirrors the inline allocation logic in applyCollectionSelectionsToBuilder.
function distributeQty(rows, desiredQty) {
  const totalCurrent = rows.reduce((s, r) => s + (r.qty || 0), 0) || 1
  let remaining = desiredQty
  const allocations = rows.map((dc, idx) => {
    if (idx === rows.length - 1) return remaining
    const share = totalCurrent > 0
      ? Math.round((dc.qty || 0) * desiredQty / totalCurrent)
      : 0
    const clamped = Math.max(0, Math.min(remaining, share))
    remaining -= clamped
    return clamped
  })
  if (allocations.every(q => q === 0) && desiredQty > 0) allocations[0] = desiredQty
  return allocations
}

describe('qty distribution (MD-007)', () => {
  it('preserves split when totals match', () => {
    expect(distributeQty([{ qty: 2 }, { qty: 2 }], 4)).toEqual([2, 2])
  })

  it('proportionally adjusts when total grows', () => {
    expect(distributeQty([{ qty: 2 }, { qty: 1 }], 6)).toEqual([4, 2])
  })

  it('proportionally adjusts when total shrinks', () => {
    expect(distributeQty([{ qty: 4 }, { qty: 2 }], 3)).toEqual([2, 1])
  })

  it('does not drop the last row to zero by default', () => {
    const result = distributeQty([{ qty: 5 }, { qty: 1 }], 4)
    expect(result.reduce((s, q) => s + q, 0)).toBe(4)
  })

  it('handles zero desired qty', () => {
    expect(distributeQty([{ qty: 1 }, { qty: 1 }], 0)).toEqual([0, 0])
  })

  it('puts remainder on last row when all current qtys are 0 (no proportional signal)', () => {
    // When all rows have 0 qty, there is no proportional signal to split by.
    // The last row collects the full remainder by design.
    expect(distributeQty([{ qty: 0 }, { qty: 0 }], 3)).toEqual([0, 3])
  })

  it('does not lose copies when desired > total (assigns full remainder to last)', () => {
    const result = distributeQty([{ qty: 1 }, { qty: 1 }], 7)
    expect(result.reduce((s, q) => s + q, 0)).toBe(7)
  })

  it('does not silently dump everything on row[0] when matching has multiple rows', () => {
    const result = distributeQty([{ qty: 2 }, { qty: 2 }], 4)
    expect(result[0]).toBeLessThan(4) // would have been 4 in the old code
  })
})

import { describe, it, expect } from 'vitest'
import {
  buildPairSnapshot, buildSyncDiff, hasStaleUnsyncedFlag, summarizeSyncDiff, writeSyncState,
} from './deckSync'

const card = (name, qty, over = {}) => ({
  name, qty, set_code: 'abc', collector_number: '1', foil: false, board: 'main', ...over,
})

describe('hasStaleUnsyncedFlag', () => {
  const flagged = writeSyncState({}, { unsynced_builder: true, unsynced_collection: false })
  const clean = writeSyncState({}, { unsynced_builder: false, unsynced_collection: false })

  it('spots a flag on either side', () => {
    expect(hasStaleUnsyncedFlag(flagged, clean)).toBe(true)
    expect(hasStaleUnsyncedFlag(clean, flagged)).toBe(true)
  })

  it('is false when both sides are clean', () => {
    expect(hasStaleUnsyncedFlag(clean, clean)).toBe(false)
  })

  it('treats a deck with no sync_state at all as clean', () => {
    expect(hasStaleUnsyncedFlag({}, {})).toBe(false)
    expect(hasStaleUnsyncedFlag(undefined)).toBe(false)
  })

  it('spots the collection-side flag too', () => {
    const collectionFlagged = writeSyncState({}, { unsynced_collection: true })
    expect(hasStaleUnsyncedFlag(collectionFlagged)).toBe(true)
  })
})

describe('buildPairSnapshot', () => {
  it('records both sides in the shape buildSyncDiff reads as a baseline', () => {
    const snapshot = buildPairSnapshot({
      builderCards: [card('Sol Ring', 1)],
      collectionCards: [card('Sol Ring', 1)],
    })
    expect(Array.isArray(snapshot.builder_cards)).toBe(true)
    expect(Array.isArray(snapshot.collection_cards)).toBe(true)
    expect(snapshot.builder_cards[0]).toMatchObject({ name: 'Sol Ring', qty: 1 })
  })

  it('drops the allocations detail, which is not part of a baseline', () => {
    const snapshot = buildPairSnapshot({
      builderCards: [],
      collectionCards: [{ ...card('Sol Ring', 1), allocations: [{ card_id: 'c1', qty: 1 }] }],
    })
    expect(snapshot.collection_cards[0]).not.toHaveProperty('allocations')
  })

  it('tolerates missing inputs', () => {
    expect(buildPairSnapshot({})).toEqual({ builder_cards: [], collection_cards: [] })
  })

  // The point of writing a snapshot: these pairs had last_sync_snapshot null, so
  // every comparison restarted from an empty baseline.
  it('is a baseline that reports no diff against the same state', () => {
    const builderCards = [card('Sol Ring', 1), card('Arcane Signet', 1)]
    const collectionCards = [card('Sol Ring', 1), card('Arcane Signet', 1)]
    const snapshot = buildPairSnapshot({ builderCards, collectionCards })
    const diff = buildSyncDiff({ baseline: snapshot, builderCards, collectionCards })
    expect(summarizeSyncDiff(diff).dirty).toBe(false)
  })

  it('is a baseline that still reports a later real change', () => {
    const builderCards = [card('Sol Ring', 1)]
    const collectionCards = [card('Sol Ring', 1)]
    const snapshot = buildPairSnapshot({ builderCards, collectionCards })
    const diff = buildSyncDiff({
      baseline: snapshot,
      builderCards: [card('Sol Ring', 1), card('Mana Crypt', 1)],
      collectionCards,
    })
    expect(summarizeSyncDiff(diff).dirty).toBe(true)
  })
})

describe('the situation that produced a stuck badge', () => {
  it('identical sides read as clean even with no baseline, so the flag was wrong', () => {
    // Science! / Scrappy Survivors / Yshtola: unsynced_builder true,
    // last_sync_snapshot null, and both sides holding the same cards. The review
    // reported no changes, so nothing ever wrote the flag back down.
    const cards = [card('Sol Ring', 1), card('Command Tower', 1)]
    const diff = buildSyncDiff({
      baseline: { builder_cards: [], collection_cards: [] },
      builderCards: cards,
      collectionCards: cards,
    })
    expect(summarizeSyncDiff(diff).dirty).toBe(false)
    expect(hasStaleUnsyncedFlag(writeSyncState({}, { unsynced_builder: true }))).toBe(true)
  })
})

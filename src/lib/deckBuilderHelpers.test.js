import { describe, it, expect } from 'vitest'
import { deckAllocationKeys, allocationSetHas, mergeOtherDeckAllocationKeys, collectCardIdentities, mainBoardCards, chunkIds, cardNameMatchKeys } from './deckBuilderHelpers'

describe('deckAllocationKeys / allocationSetHas', () => {
  it('matches a deck card against an allocation in another deck via the shared card_print_id', () => {
    // Regression case: "Raise the Palisade" (LTC #23, non-foil) — one owned
    // copy allocated to "Temmet zombies", the same print also listed in
    // "elementals upgrade". The ownership badge must recognize it as
    // committed elsewhere rather than reporting it as free "Owned" stock.
    const deckCardInOtherDeck = {
      card_print_id: '95411110-ec23-4273-bbf0-441a58d91361',
      scryfall_id: null,
      name: 'Raise the Palisade',
      foil: false,
    }
    const allocationRow = {
      card_print_id: '95411110-ec23-4273-bbf0-441a58d91361',
      scryfall_id: null,
      name: 'Raise the Palisade',
      foil: false,
      deck_id: 'temmet-zombies-id',
    }

    const inOtherDeckSet = new Set(deckAllocationKeys(allocationRow))
    expect(allocationSetHas(inOtherDeckSet, deckCardInOtherDeck)).toBe(true)
  })

  it('matches on scryfall_id + foil even when card_print_id is absent', () => {
    const dc = { scryfall_id: 'sf-1', name: 'Sol Ring', foil: true }
    const set = new Set(deckAllocationKeys({ scryfall_id: 'sf-1', name: 'Sol Ring', foil: true }))
    expect(allocationSetHas(set, dc)).toBe(true)
  })

  it('falls back to name + foil when print and scryfall ids differ (different printing)', () => {
    const dc = { card_print_id: 'print-A', scryfall_id: 'sf-A', name: 'Forest', foil: false }
    const set = new Set(deckAllocationKeys({ card_print_id: 'print-B', scryfall_id: 'sf-B', name: 'Forest', foil: false }))
    expect(allocationSetHas(set, dc)).toBe(true)
  })

  it('does not match a different card name', () => {
    const dc = { card_print_id: 'print-A', scryfall_id: 'sf-A', name: 'Forest', foil: false }
    const set = new Set(deckAllocationKeys({ card_print_id: 'print-B', scryfall_id: 'sf-B', name: 'Island', foil: false }))
    expect(allocationSetHas(set, dc)).toBe(false)
  })
})

describe('mergeOtherDeckAllocationKeys', () => {
  // Regression: a card added from search/recs after the deck loaded was never
  // part of the load-time allocation fetch, so the ownership badge showed
  // "Owned" even when every copy was committed to another deck. Late adds
  // fetch their own allocations and merge them into the existing set.
  it('marks a late-added card as committed when its allocation lives in another deck', () => {
    const prev = new Set(['name:sol ring|0'])
    const addedCard = { scryfall_id: 'sf-bolt', name: 'Lightning Bolt', foil: false }
    const allocations = [
      { scryfall_id: 'sf-bolt', card_print_id: 'print-bolt', name: 'Lightning Bolt', foil: false, deck_id: 'other-deck' },
    ]

    const next = mergeOtherDeckAllocationKeys(prev, allocations, ['this-deck', 'linked-coll-deck'])
    expect(allocationSetHas(next, addedCard)).toBe(true)
    // Existing entries survive the merge
    expect(next.has('name:sol ring|0')).toBe(true)
  })

  it('excludes allocations belonging to the current deck pair', () => {
    const allocations = [
      { scryfall_id: 'sf-bolt', name: 'Lightning Bolt', foil: false, deck_id: 'linked-coll-deck' },
    ]
    const next = mergeOtherDeckAllocationKeys(new Set(), allocations, ['this-deck', 'linked-coll-deck'])
    expect(next.size).toBe(0)
  })

  it('returns the previous set unchanged when nothing merges (no re-render churn)', () => {
    const prev = new Set(['name:sol ring|0'])
    expect(mergeOtherDeckAllocationKeys(prev, [], ['this-deck'])).toBe(prev)
    expect(mergeOtherDeckAllocationKeys(prev, null, [null])).toBe(prev)
  })

  it('ignores null entries in the excluded deck ids (unlinked builder deck)', () => {
    const allocations = [
      { scryfall_id: 'sf-bolt', name: 'Lightning Bolt', foil: false, deck_id: 'some-deck' },
    ]
    // getAllocationDeckId() returns null for an unlinked builder deck — a null
    // exclusion must not filter out real allocation rows.
    const next = mergeOtherDeckAllocationKeys(new Set(), allocations, ['this-deck', null])
    expect(allocationSetHas(next, { name: 'Lightning Bolt', foil: false })).toBe(true)
  })
})

describe('collectCardIdentities', () => {
  it('collects print ids, scryfall ids, and names, skipping missing fields', () => {
    const cards = [
      { card_print_id: 'p1', scryfall_id: 's1', name: 'Sol Ring' },
      { card_print_id: null, scryfall_id: 's2', name: 'Forest' },
      { name: 'Basic land with no print info yet' },
    ]
    expect(collectCardIdentities(cards)).toEqual({
      cardPrintIds: ['p1'],
      scryfallIds: ['s1', 's2'],
      names: ['Sol Ring', 'Forest', 'Basic land with no print info yet'],
    })
  })

  it('returns empty arrays for an empty or missing card list', () => {
    expect(collectCardIdentities([])).toEqual({ cardPrintIds: [], scryfallIds: [], names: [] })
    expect(collectCardIdentities(undefined)).toEqual({ cardPrintIds: [], scryfallIds: [], names: [] })
  })
})

describe('mainBoardCards', () => {
  // Regression: the Deck tab counter and the Build Assistant were summing
  // side/maybe rows into the main-deck count.
  it('keeps only main-board rows, commander included', () => {
    const rows = [
      { name: 'Atraxa', board: 'main', is_commander: true, qty: 1 },
      { name: 'Sol Ring', board: 'main', qty: 1 },
      { name: 'Negate', board: 'side', qty: 2 },
      { name: 'Craterhoof Behemoth', board: 'maybe', qty: 1 },
    ]
    expect(mainBoardCards(rows).map(r => r.name)).toEqual(['Atraxa', 'Sol Ring'])
  })

  it('treats missing or unknown board values as main', () => {
    const rows = [
      { name: 'Legacy row with no board', qty: 1 },
      { name: 'Garbage board', board: 'bogus', qty: 1 },
      { name: 'Maybe row', board: 'maybe', qty: 1 },
    ]
    expect(mainBoardCards(rows).map(r => r.name)).toEqual(['Legacy row with no board', 'Garbage board'])
  })

  it('returns an empty array for a missing list', () => {
    expect(mainBoardCards(undefined)).toEqual([])
  })
})

describe('chunkIds', () => {
  // .in() filters put ids in the request URL; bulk deletes must chunk so a
  // large batch can't overflow URL-length limits.
  it('splits ids into batches of the given size', () => {
    expect(chunkIds(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']])
  })

  it('defaults to batches of 100', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`)
    const batches = chunkIds(ids)
    expect(batches.map(b => b.length)).toEqual([100, 100, 50])
    expect(batches.flat()).toEqual(ids)
  })

  it('returns no batches for an empty or missing list', () => {
    expect(chunkIds([])).toEqual([])
    expect(chunkIds(undefined)).toEqual([])
  })
})

describe('cardNameMatchKeys', () => {
  // Regression: EDHREC recommends DFCs by front-face name ("Michiko's Reign of
  // Truth") while deck rows store the full Scryfall name — the rec never
  // disappeared from the Recommendations tab after being added to the deck.
  it('returns the full name and the front-face name for a DFC', () => {
    expect(cardNameMatchKeys("Michiko's Reign of Truth // Portrait of Michiko-hime"))
      .toEqual(["michiko's reign of truth // portrait of michiko-hime", "michiko's reign of truth"])
  })

  it('handles the separator without surrounding spaces', () => {
    expect(cardNameMatchKeys('Fire//Ice')).toEqual(['fire//ice', 'fire'])
  })

  it('returns a single lowercased key for a normal card', () => {
    expect(cardNameMatchKeys('Sol Ring')).toEqual(['sol ring'])
  })

  it('returns no keys for empty input', () => {
    expect(cardNameMatchKeys('')).toEqual([])
    expect(cardNameMatchKeys(null)).toEqual([])
    expect(cardNameMatchKeys(undefined)).toEqual([])
  })
})

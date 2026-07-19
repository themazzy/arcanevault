import { describe, it, expect } from 'vitest'
import { deckAllocationKeys, allocationSetHas, mergeOtherDeckAllocationKeys, collectCardIdentities, mainBoardCards, chunkIds, cardNameMatchKeys, countDeckCards, dedupeDeckRowsForInsert, deckRowPrintKey, placementFilterNames, canBeCommander, getCommanderProfile } from './deckBuilderHelpers'

describe('placementFilterNames', () => {
  it('preserves original casing — the remote placement fetch matches names case-sensitively', () => {
    // Regression: MakeDeckModal passed normalizeCardName output ("fellwar
    // stone") to refreshRemotePlacementSnapshot, whose SQL name filter is
    // case-sensitive — every card owned only in a different printing than the
    // decklist's came back "not owned".
    expect(placementFilterNames([
      { name: 'Fellwar Stone' },
      { name: 'Azorius Chancery' },
    ])).toEqual(['Fellwar Stone', 'Azorius Chancery'])
  })

  it('trims, dedupes, and drops empty names', () => {
    expect(placementFilterNames([
      { name: '  Sol Ring ' },
      { name: 'Sol Ring' },
      { name: '' },
      { name: null },
      null,
    ])).toEqual(['Sol Ring'])
  })

  it('returns an empty list for null input', () => {
    expect(placementFilterNames(null)).toEqual([])
  })
})

describe('countDeckCards', () => {
  it('sums copies, not rows — a qty row counts all its copies', () => {
    expect(countDeckCards([
      { name: 'Sol Ring', qty: 1 },
      { name: 'Forest', qty: 8 },
      { name: 'Island', qty: 10 },
    ])).toBe(19)
  })

  it('treats a missing qty as one copy', () => {
    expect(countDeckCards([{ name: 'Cmd' }, { name: 'Rock', qty: 2 }])).toBe(3)
  })

  it('returns 0 for empty / null input', () => {
    expect(countDeckCards([])).toBe(0)
    expect(countDeckCards(null)).toBe(0)
  })
})

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

  it('does not treat a different printing of the same card as allocated', () => {
    const dc = { card_print_id: 'print-A', scryfall_id: 'sf-A', name: 'Forest', foil: false }
    const set = new Set(deckAllocationKeys({ card_print_id: 'print-B', scryfall_id: 'sf-B', name: 'Forest', foil: false }))
    expect(allocationSetHas(set, dc)).toBe(false)
  })

  it('does not treat the opposite foil finish of the same printing as allocated', () => {
    const dc = { card_print_id: 'print-A', scryfall_id: 'sf-A', name: 'Forest', foil: true }
    const set = new Set(deckAllocationKeys({ card_print_id: 'print-A', scryfall_id: 'sf-A', name: 'Forest', foil: false }))
    expect(allocationSetHas(set, dc)).toBe(false)
  })

  it('falls back to scryfall id when an allocation has no card_print_id', () => {
    const dc = { card_print_id: 'print-A', scryfall_id: 'sf-A', name: 'Forest', foil: false }
    const set = new Set(deckAllocationKeys({ card_print_id: null, scryfall_id: 'sf-A', name: 'Forest', foil: false }))
    expect(allocationSetHas(set, dc)).toBe(true)
  })

  it('falls back to name when a legacy allocation has no print identifiers', () => {
    const dc = { card_print_id: 'print-A', scryfall_id: 'sf-A', name: 'Forest', foil: false }
    const set = new Set(deckAllocationKeys({ card_print_id: null, scryfall_id: null, name: 'Forest', foil: false }))
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
    const addedCard = { card_print_id: 'print-bolt', scryfall_id: 'sf-bolt', name: 'Lightning Bolt', foil: false }
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
    expect(next.has('sf:sf-bolt|0')).toBe(true)
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

describe('deckRowPrintKey', () => {
  it('keys on card_print_id + foil + normalized board', () => {
    expect(deckRowPrintKey({ card_print_id: 'p1', foil: false, board: 'main' })).toBe('p1|0|main')
    expect(deckRowPrintKey({ card_print_id: 'p1', foil: true, board: 'main' })).toBe('p1|1|main')
  })

  it('treats an unknown board as main (matching normalizeBoard)', () => {
    expect(deckRowPrintKey({ card_print_id: 'p1', board: 'bogus' })).toBe('p1|0|main')
  })

  it('falls back to scryfall_id then print key when card_print_id is absent', () => {
    expect(deckRowPrintKey({ scryfall_id: 's1', board: 'main' })).toBe('s1|0|main')
    expect(deckRowPrintKey({ set_code: 'neo', collector_number: '42', board: 'side' })).toBe('neo-42|0|side')
  })
})

describe('dedupeDeckRowsForInsert', () => {
  // Regression: the Build Assistant's bulk auto-fill inserted every resolved row
  // blindly. A pick already in the deck (or two picks resolving to the same
  // print) violated deck_cards_unique_print_board_idx (deck_id, card_print_id,
  // foil, board), 409'd, and rolled back the ENTIRE batch — "Auto-fill failed".
  it('drops a row that already exists in the deck', () => {
    const existing = [{ card_print_id: 'p1', foil: false, board: 'main' }]
    const incoming = [
      { id: 'a', card_print_id: 'p1', foil: false, board: 'main' }, // collides
      { id: 'b', card_print_id: 'p2', foil: false, board: 'main' },
    ]
    const { rows, skipped } = dedupeDeckRowsForInsert(incoming, existing)
    expect(rows.map(r => r.id)).toEqual(['b'])
    expect(skipped).toBe(1)
  })

  it('drops a later duplicate within the same batch', () => {
    const incoming = [
      { id: 'a', card_print_id: 'p1', foil: false, board: 'main' },
      { id: 'b', card_print_id: 'p1', foil: false, board: 'main' }, // dup of a
    ]
    const { rows, skipped } = dedupeDeckRowsForInsert(incoming, [])
    expect(rows.map(r => r.id)).toEqual(['a'])
    expect(skipped).toBe(1)
  })

  it('keeps the same print when foil or board differ (distinct index keys)', () => {
    const incoming = [
      { id: 'a', card_print_id: 'p1', foil: false, board: 'main' },
      { id: 'b', card_print_id: 'p1', foil: true, board: 'main' },  // different foil
      { id: 'c', card_print_id: 'p1', foil: false, board: 'side' }, // different board
    ]
    const { rows, skipped } = dedupeDeckRowsForInsert(incoming, [])
    expect(rows.map(r => r.id)).toEqual(['a', 'b', 'c'])
    expect(skipped).toBe(0)
  })

  it('returns everything untouched when there are no collisions', () => {
    const incoming = [
      { id: 'a', card_print_id: 'p1', foil: false, board: 'main' },
      { id: 'b', card_print_id: 'p2', foil: false, board: 'main' },
    ]
    const { rows, skipped } = dedupeDeckRowsForInsert(incoming, [])
    expect(rows).toHaveLength(2)
    expect(skipped).toBe(0)
  })
})

describe('canBeCommander — legendary Vehicles and Spacecraft (CR 903.3a, 2025)', () => {
  it('accepts a legendary Vehicle (RMS Titanic)', () => {
    expect(canBeCommander({ type_line: 'Legendary Artifact — Vehicle' })).toBe(true)
  })

  it('accepts a legendary Spacecraft', () => {
    expect(canBeCommander({ type_line: 'Legendary Artifact — Spacecraft' })).toBe(true)
  })

  it('still accepts a legendary creature', () => {
    expect(canBeCommander({ type_line: 'Legendary Creature — Human Wizard' })).toBe(true)
  })

  it('rejects a non-legendary Vehicle', () => {
    expect(canBeCommander({ type_line: 'Artifact — Vehicle' })).toBe(false)
  })

  it('rejects a legendary non-creature, non-Vehicle artifact', () => {
    expect(canBeCommander({ type_line: 'Legendary Artifact' })).toBe(false)
  })

  it('exposes isLegendaryVehicle on the commander profile', () => {
    expect(getCommanderProfile({ type_line: 'Legendary Artifact — Vehicle' }).isLegendaryVehicle).toBe(true)
    expect(getCommanderProfile({ type_line: 'Legendary Creature — Dwarf Pilot' }).isLegendaryVehicle).toBe(false)
  })
})

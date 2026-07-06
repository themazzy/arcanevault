import { describe, it, expect } from 'vitest'
import { deckAllocationKeys, allocationSetHas } from './deckBuilderHelpers'

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

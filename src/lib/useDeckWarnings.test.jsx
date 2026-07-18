// @vitest-environment jsdom

import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useDeckCardLegalityWarnings } from './useDeckWarnings'
import { getScryfallKey } from './scryfall'

const COMMANDER_FORMAT = { id: 'commander', label: 'Commander' }

function deckCard(overrides = {}) {
  return {
    id: overrides.id || 'dc1',
    name: overrides.name || 'Jeweled Lotus',
    board: overrides.board || 'main',
    qty: overrides.qty ?? 1,
    set_code: overrides.set_code || 'cmr',
    collector_number: overrides.collector_number || '319',
    color_identity: overrides.color_identity || [],
    ...overrides,
  }
}

describe('useDeckCardLegalityWarnings — legalities source fallback', () => {
  it('warns on a banned card whose legalities come only from the name map (card_prints path)', () => {
    const dc = deckCard({ name: 'Jeweled Lotus' })
    // builderSfMap resolved this card from card_prints — no legalities present,
    // mirroring the real post-import state that caused the missing warning.
    const builderSfMap = { [getScryfallKey(dc)]: { name: 'Jeweled Lotus', type_line: 'Artifact' } }
    const { result } = renderHook(() => useDeckCardLegalityWarnings({
      deckCards: [dc],
      builderSfMap,
      legalitiesByName: { 'jeweled lotus': { commander: 'banned' } },
      format: COMMANDER_FORMAT,
      isEDH: true,
      colorIdentity: [],
    }))
    const warnings = result.current.get('dc1') || []
    expect(warnings.some(w => w.reason === 'format_legality' && /banned/i.test(w.text))).toBe(true)
  })

  it('does not warn when the name map reports the card legal', () => {
    const dc = deckCard({ name: 'Sol Ring' })
    const builderSfMap = { [getScryfallKey(dc)]: { name: 'Sol Ring', type_line: 'Artifact' } }
    const { result } = renderHook(() => useDeckCardLegalityWarnings({
      deckCards: [dc],
      builderSfMap,
      legalitiesByName: { 'sol ring': { commander: 'legal' } },
      format: COMMANDER_FORMAT,
      isEDH: true,
      colorIdentity: [],
    }))
    const warnings = result.current.get('dc1') || []
    expect(warnings.some(w => w.reason === 'format_legality')).toBe(false)
  })

  it('prefers builderSfMap legalities over the name map when present', () => {
    const dc = deckCard({ name: 'Some Card' })
    const builderSfMap = {
      [getScryfallKey(dc)]: { name: 'Some Card', legalities: { commander: 'legal' } },
    }
    const { result } = renderHook(() => useDeckCardLegalityWarnings({
      deckCards: [dc],
      builderSfMap,
      // Stale/incorrect name-map entry should be ignored because sf has legalities.
      legalitiesByName: { 'some card': { commander: 'banned' } },
      format: COMMANDER_FORMAT,
      isEDH: true,
      colorIdentity: [],
    }))
    const warnings = result.current.get('dc1') || []
    expect(warnings.some(w => w.reason === 'format_legality')).toBe(false)
  })
})

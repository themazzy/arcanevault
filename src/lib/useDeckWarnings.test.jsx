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

  it('does not flag duplicates of a card whose text allows any number', () => {
    const a = deckCard({ id: 'r1', name: 'Relentless Rats', qty: 12 })
    const { result } = renderHook(() => useDeckCardLegalityWarnings({
      deckCards: [a],
      builderSfMap: {},
      legalitiesByName: { 'relentless rats': { commander: 'legal' } },
      copyLimitsByName: { 'relentless rats': Infinity },
      format: COMMANDER_FORMAT,
      isEDH: true,
      colorIdentity: [],
    }))
    expect((result.current.get('r1') || []).some(w => w.reason === 'duplicate')).toBe(false)
  })

  it('flags a capped card only once it exceeds its own limit', () => {
    const within = deckCard({ id: 'n1', name: 'Nazgûl', qty: 9 })
    const over = deckCard({ id: 'n2', name: 'Nazgûl', qty: 10 })
    const run = dc => renderHook(() => useDeckCardLegalityWarnings({
      deckCards: [dc],
      builderSfMap: {},
      legalitiesByName: { 'nazgûl': { commander: 'legal' } },
      copyLimitsByName: { 'nazgûl': 9 },
      format: COMMANDER_FORMAT,
      isEDH: true,
      colorIdentity: [],
    })).result.current

    expect((run(within).get('n1') || []).some(w => w.reason === 'duplicate')).toBe(false)
    const overWarnings = run(over).get('n2') || []
    expect(overWarnings.some(w => w.reason === 'duplicate' && /up to 9/.test(w.text))).toBe(true)
  })

  it('still flags an ordinary duplicate in a singleton format', () => {
    const dc = deckCard({ id: 'd1', name: 'Sol Ring', qty: 2 })
    const { result } = renderHook(() => useDeckCardLegalityWarnings({
      deckCards: [dc],
      builderSfMap: {},
      legalitiesByName: { 'sol ring': { commander: 'legal' } },
      copyLimitsByName: {},
      format: COMMANDER_FORMAT,
      isEDH: true,
      colorIdentity: [],
    }))
    expect((result.current.get('d1') || []).some(w => w.reason === 'duplicate')).toBe(true)
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

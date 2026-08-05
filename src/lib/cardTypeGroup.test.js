import { describe, it, expect } from 'vitest'
import { TYPE_GROUPS, classifyCardType } from './cardTypeGroup'

describe('classifyCardType', () => {
  it('maps each single-type card to its group', () => {
    expect(classifyCardType('Creature — Elf Druid')).toBe('Creatures')
    expect(classifyCardType('Legendary Planeswalker — Teferi')).toBe('Planeswalkers')
    expect(classifyCardType('Battle — Siege')).toBe('Battles')
    expect(classifyCardType('Instant')).toBe('Instants')
    expect(classifyCardType('Sorcery')).toBe('Sorceries')
    expect(classifyCardType('Artifact — Equipment')).toBe('Artifacts')
    expect(classifyCardType('Enchantment — Aura')).toBe('Enchantments')
    expect(classifyCardType('Land — Island')).toBe('Lands')
  })

  it('groups artifact lands with lands, not artifacts', () => {
    expect(classifyCardType('Artifact Land')).toBe('Lands')                   // Seat of the Synod
    expect(classifyCardType('Artifact Land — Urza\'s Mine')).toBe('Lands')    // Urza's Mine (ATQ)
  })

  it('groups enchantment lands with lands', () => {
    expect(classifyCardType('Enchantment Land — Urza\'s Saga')).toBe('Lands')
  })

  it('keeps land creatures with creatures', () => {
    expect(classifyCardType('Land Creature — Forest Dryad')).toBe('Creatures') // Dryad Arbor
  })

  it('keeps artifact creatures with creatures', () => {
    expect(classifyCardType('Artifact Creature — Golem')).toBe('Creatures')
  })

  it('is case-insensitive and safe on missing input', () => {
    expect(classifyCardType('ARTIFACT LAND')).toBe('Lands')
    expect(classifyCardType('')).toBe('Other')
    expect(classifyCardType()).toBe('Other')
    expect(classifyCardType(null)).toBe('Other')
  })

  it('only ever returns a declared group', () => {
    const lines = [
      'Creature', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land',
      'Artifact Land', 'Enchantment Land', 'Land Creature', 'Battle',
      'Planeswalker', 'Dungeon', '',
    ]
    for (const line of lines) expect(TYPE_GROUPS).toContain(classifyCardType(line))
  })
})

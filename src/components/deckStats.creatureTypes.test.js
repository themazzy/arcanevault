import { describe, it, expect } from 'vitest'
import { creatureSubtypesOf, getCreatureTypeCounts } from './DeckStats'

describe('creatureSubtypesOf', () => {
  it('parses subtypes after the em dash', () => {
    expect(creatureSubtypesOf('Legendary Creature — Goblin Warrior')).toEqual(['Goblin', 'Warrior'])
  })
  it('handles Kindred and Tribal types', () => {
    expect(creatureSubtypesOf('Kindred Instant — Elf')).toEqual(['Elf'])
    expect(creatureSubtypesOf('Tribal Sorcery — Goblin')).toEqual(['Goblin'])
  })
  it('parses both faces of a double-faced card', () => {
    expect(creatureSubtypesOf('Creature — Human Cleric // Creature — Vampire')).toEqual(['Human', 'Cleric', 'Vampire'])
  })
  it('ignores non-creature types and supertypes before the dash', () => {
    expect(creatureSubtypesOf('Artifact — Equipment')).toEqual([])
    expect(creatureSubtypesOf('Instant')).toEqual([])
    expect(creatureSubtypesOf('Basic Land — Mountain')).toEqual([])
    expect(creatureSubtypesOf('')).toEqual([])
    expect(creatureSubtypesOf(null)).toEqual([])
  })
  it('keeps Artifact Creature subtypes', () => {
    expect(creatureSubtypesOf('Artifact Creature — Golem')).toEqual(['Golem'])
  })
})

describe('getCreatureTypeCounts', () => {
  it('counts by quantity, dedupes within a card, sorts desc', () => {
    const cards = [
      { type_line: 'Creature — Goblin', qty: 3 },
      { type_line: 'Creature — Goblin Warrior', qty: 1 },
      { type_line: 'Creature — Elf Warrior', qty: 1 },
      { type_line: 'Creature — Goblin Goblin', qty: 2 }, // dedupe within card → counts once
    ]
    const counts = getCreatureTypeCounts(cards)
    const map = Object.fromEntries(counts)
    expect(map.Goblin).toBe(6)   // 3 + 1 + 2
    expect(map.Warrior).toBe(2)  // 1 + 1
    expect(map.Elf).toBe(1)
    expect(counts[0][0]).toBe('Goblin') // sorted by count desc
  })
  it('returns empty for a typeless / non-creature deck', () => {
    expect(getCreatureTypeCounts([{ type_line: 'Instant', qty: 4 }])).toEqual([])
  })
})

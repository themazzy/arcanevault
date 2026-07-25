import { describe, it, expect } from 'vitest'
import { buildDeckOptions } from './deckOptions'

const folder = (id, name, type, meta = null) => ({
  id, name, type, description: meta ? JSON.stringify(meta) : null,
})

// A linked pair as the app actually stores it: each half points at the other.
const linkedPair = (name, builderId, deckId) => [
  folder(builderId, name, 'builder_deck', { linked_deck_id: deckId }),
  folder(deckId, name, 'deck', { linked_builder_id: builderId }),
]

describe('linked pairs', () => {
  it('collapses a pair to one entry', () => {
    const options = buildDeckOptions(linkedPair('Yuriko', 'b1', 'd1'))
    expect(options).toHaveLength(1)
    expect(options[0].name).toBe('Yuriko')
  })

  it('keeps the builder half, because that is the id win rates are read by', () => {
    // /builder/:id queries game_results.deck_id against the builder folder id, so
    // recording against the collection half leaves the builder's win rate empty.
    expect(buildDeckOptions(linkedPair('Yuriko', 'b1', 'd1'))[0]).toMatchObject({
      id: 'b1', type: 'builder_deck',
    })
  })

  it('does not qualify the name once the duplicate is gone', () => {
    expect(buildDeckOptions(linkedPair('Yuriko', 'b1', 'd1'))[0].label).toBe('Yuriko')
  })

  it('keeps the collection half when its builder partner was not loaded', () => {
    // Dropping it on the strength of a dangling link would lose the deck entirely.
    const options = buildDeckOptions([
      folder('d1', 'Yuriko', 'deck', { linked_builder_id: 'b-missing' }),
    ])
    expect(options).toHaveLength(1)
    expect(options[0].id).toBe('d1')
  })

  it('handles several pairs alongside unpaired decks', () => {
    const options = buildDeckOptions([
      ...linkedPair('Shrines', 'b1', 'd1'),
      ...linkedPair('Vampires', 'b2', 'd2'),
      folder('b3', 'Slivers', 'builder_deck'),
      folder('d3', 'Precon', 'deck'),
    ])
    expect(options.map(o => o.name)).toEqual(['Precon', 'Shrines', 'Slivers', 'Vampires'])
    expect(options.map(o => o.id)).toEqual(['d3', 'b1', 'b3', 'b2'])
  })
})

describe('group folders', () => {
  it('never offers an organisational container as a deck', () => {
    const options = buildDeckOptions([
      folder('g1', 'Commander decks', 'deck', { isGroup: true }),
      folder('d1', 'Yuriko', 'deck'),
    ])
    expect(options.map(o => o.id)).toEqual(['d1'])
  })

  it('excludes builder-type groups too', () => {
    const options = buildDeckOptions([
      folder('g1', 'Brews', 'builder_deck', { isGroup: true }),
      folder('b1', 'Yuriko', 'builder_deck'),
    ])
    expect(options.map(o => o.id)).toEqual(['b1'])
  })
})

describe('coincidental name clashes', () => {
  it('qualifies both entries so they can be told apart', () => {
    // Two decks that merely share a name — not a pair, so both are real choices.
    const options = buildDeckOptions([
      folder('b1', 'Buff snake', 'builder_deck'),
      folder('d1', 'Buff snake', 'deck'),
    ])
    expect(options).toHaveLength(2)
    expect(options.map(o => o.label)).toEqual(['Buff snake · Builder', 'Buff snake · Collection'])
  })

  it('leaves unambiguous names alone', () => {
    const options = buildDeckOptions([
      folder('b1', 'Yuriko', 'builder_deck'),
      folder('d1', 'Shrines', 'deck'),
    ])
    expect(options.map(o => o.label)).toEqual(['Shrines', 'Yuriko'])
  })

  it('compares names case- and whitespace-insensitively', () => {
    const options = buildDeckOptions([
      folder('b1', 'Yuriko', 'builder_deck'),
      folder('d1', '  yuriko ', 'deck'),
    ])
    expect(options.every(o => o.label.includes('·'))).toBe(true)
  })
})

describe('sorting and shape', () => {
  it('sorts by name, ignoring case', () => {
    const options = buildDeckOptions([
      folder('1', 'zombies', 'deck'),
      folder('2', 'Angels', 'deck'),
      folder('3', 'myr', 'deck'),
    ])
    expect(options.map(o => o.name)).toEqual(['Angels', 'myr', 'zombies'])
  })

  it('returns id, name, type and label for each entry', () => {
    const [option] = buildDeckOptions([folder('b1', 'Yuriko', 'builder_deck')])
    expect(Object.keys(option).sort()).toEqual(['id', 'label', 'name', 'type'])
  })
})

describe('robustness', () => {
  it('ignores folder types that are not decks', () => {
    const options = buildDeckOptions([
      folder('f1', 'Binder', 'binder'),
      folder('f2', 'Wishlist', 'list'),
      folder('d1', 'Yuriko', 'deck'),
    ])
    expect(options.map(o => o.id)).toEqual(['d1'])
  })

  it('survives unparseable or absent descriptions', () => {
    const options = buildDeckOptions([
      { id: 'd1', name: 'Broken', type: 'deck', description: '{not json' },
      { id: 'd2', name: 'Absent', type: 'deck' },
    ])
    expect(options.map(o => o.name)).toEqual(['Absent', 'Broken'])
  })

  it('tolerates junk input', () => {
    expect(buildDeckOptions(null)).toEqual([])
    expect(buildDeckOptions([])).toEqual([])
    expect(buildDeckOptions([null, undefined, {}])).toEqual([])
  })
})

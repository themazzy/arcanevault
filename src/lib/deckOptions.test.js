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

// What get_my_decks() returns for a linked pair: the builder half is filtered out
// server-side, so only the collection row arrives.
const rpcLinkedPair = (name, builderId, deckId) => [
  folder(deckId, name, 'deck', { linked_builder_id: builderId }),
]

describe('linked pairs from get_my_decks (the real source)', () => {
  it('shows the single row the RPC returns', () => {
    const options = buildDeckOptions(rpcLinkedPair('Yuriko', 'b1', 'd1'))
    expect(options).toHaveLength(1)
    expect(options[0].name).toBe('Yuriko')
  })

  it('attributes the game to the builder half, which is what win rates read', () => {
    // get_my_decks keeps the collection row, but /builder/:id queries
    // game_results.deck_id against the builder folder id — a linked collection deck
    // navigates there via linked_builder_id. Recording against the collection id
    // would show in Stats and leave the deck builder's win rate empty.
    const [option] = buildDeckOptions(rpcLinkedPair('Yuriko', 'b1', 'd1'))
    expect(option.id).toBe('b1')        // stored in game_results.deck_id
    expect(option.folderId).toBe('d1')  // the row that was displayed
  })

  it('does not qualify the name — there is only one entry', () => {
    expect(buildDeckOptions(rpcLinkedPair('Yuriko', 'b1', 'd1'))[0].label).toBe('Yuriko')
  })

  it('respects hideFromBuilder, as the RPC does', () => {
    const options = buildDeckOptions([
      folder('d1', 'Retired brew', 'deck', { hideFromBuilder: true }),
      folder('b1', 'Yuriko', 'builder_deck'),
    ])
    expect(options.map(o => o.id)).toEqual(['b1'])
  })

  it('preserves the RPC ordering instead of re-sorting', () => {
    // get_my_decks orders by deck_modified_at desc, so the deck you last touched is
    // first — the useful default when picking one at the table.
    const options = buildDeckOptions([
      folder('1', 'zombies', 'builder_deck'),
      folder('2', 'Angels', 'builder_deck'),
      folder('3', 'myr', 'builder_deck'),
    ])
    expect(options.map(o => o.name)).toEqual(['zombies', 'Angels', 'myr'])
  })

  it('carries the card count through when the RPC supplies one', () => {
    const [option] = buildDeckOptions([{ ...folder('b1', 'Yuriko', 'builder_deck'), card_count: 99 }])
    expect(option.cardCount).toBe(99)
    expect(buildDeckOptions([folder('b2', 'No count', 'deck')])[0].cardCount).toBeNull()
  })
})

describe('raw folders fallback', () => {
  it('collapses a pair when both halves are present', () => {
    const options = buildDeckOptions(linkedPair('Yuriko', 'b1', 'd1'))
    expect(options).toHaveLength(1)
    expect(options[0].id).toBe('b1')
  })

  it('reaches the same attribution id by either route', () => {
    const viaRpc = buildDeckOptions(rpcLinkedPair('Yuriko', 'b1', 'd1'))[0].id
    const viaFolders = buildDeckOptions(linkedPair('Yuriko', 'b1', 'd1'))[0].id
    expect(viaRpc).toBe(viaFolders)
  })

  it('keeps the collection half when its builder partner was not loaded', () => {
    // Dropping it on the strength of a dangling link would lose the deck entirely.
    const options = buildDeckOptions([
      folder('d1', 'Yuriko', 'deck', { linked_builder_id: 'b-missing' }),
    ])
    expect(options).toHaveLength(1)
    expect(options[0].folderId).toBe('d1')
    // Still attributed to the builder it names, so a later repair lines up.
    expect(options[0].id).toBe('b-missing')
  })

  it('handles several pairs alongside unpaired decks', () => {
    const options = buildDeckOptions([
      ...linkedPair('Shrines', 'b1', 'd1'),
      ...linkedPair('Vampires', 'b2', 'd2'),
      folder('b3', 'Slivers', 'builder_deck'),
      folder('d3', 'Precon', 'deck'),
    ])
    expect(options.map(o => o.name)).toEqual(['Shrines', 'Vampires', 'Slivers', 'Precon'])
    expect(options.map(o => o.id)).toEqual(['b1', 'b2', 'b3', 'd3'])
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
    expect(options.map(o => o.label)).toEqual(['Yuriko', 'Shrines'])
  })

  it('compares names case- and whitespace-insensitively', () => {
    const options = buildDeckOptions([
      folder('b1', 'Yuriko', 'builder_deck'),
      folder('d1', '  yuriko ', 'deck'),
    ])
    expect(options.every(o => o.label.includes('·'))).toBe(true)
  })
})

describe('shape', () => {
  it('returns the fields the pickers need', () => {
    const [option] = buildDeckOptions([folder('b1', 'Yuriko', 'builder_deck')])
    expect(Object.keys(option).sort())
      .toEqual(['cardCount', 'folderId', 'id', 'label', 'name', 'type'])
  })

  it('attributes an unlinked deck to its own folder id', () => {
    expect(buildDeckOptions([folder('b1', 'Yuriko', 'builder_deck')])[0])
      .toMatchObject({ id: 'b1', folderId: 'b1' })
    expect(buildDeckOptions([folder('d1', 'Precon', 'deck')])[0])
      .toMatchObject({ id: 'd1', folderId: 'd1' })
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
    expect(options.map(o => o.name)).toEqual(['Broken', 'Absent'])
  })

  it('tolerates junk input', () => {
    expect(buildDeckOptions(null)).toEqual([])
    expect(buildDeckOptions([])).toEqual([])
    expect(buildDeckOptions([null, undefined, {}])).toEqual([])
  })
})

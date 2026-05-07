import { describe, it, expect, vi } from 'vitest'

// Stub supabase + deckBuilderApi so deckArt.js can be imported in Node without
// hitting IDB or the network. We never call the live `sb` in tests anyway.
vi.mock('./supabase', () => ({ sb: {} }))
vi.mock('./deckBuilderApi', () => ({
  parseDeckMeta: (str) => {
    if (str == null || str === '') return {}
    try { return typeof str === 'string' ? JSON.parse(str) : str } catch { return {} }
  },
  serializeDeckMeta: (meta) => JSON.stringify(meta || {}),
}))

const { enrichDecksWithCommanderArt } = await import('./deckArt')

/**
 * Build a chainable Supabase query mock. Each table maps to a config of:
 *   { selectResponse, updateCalls }
 * `from(table)` returns an object whose `.select().eq().in()` resolves with the
 * stored response, and `.update().eq()` records the call.
 */
function makeFakeClient(tableConfig = {}) {
  const updateCalls = []
  const client = {
    from(table) {
      const cfg = tableConfig[table] || { selectResponse: { data: [], error: null } }
      // Thenable builder: .select/.in/.eq all chainable, awaiting it resolves
      // with selectResponse — mirrors Supabase JS query builder behavior.
      const builder = {
        _table: table,
        select() { return builder },
        in() { return builder },
        eq() { return builder },
        then(onFulfilled, onRejected) {
          return Promise.resolve(cfg.selectResponse).then(onFulfilled, onRejected)
        },
        update(payload) {
          return {
            eq(col, val) {
              updateCalls.push({ table, col, val, payload })
              return Promise.resolve({ data: null, error: null })
            },
          }
        },
      }
      return builder
    },
  }
  return { client, updateCalls }
}

describe('enrichDecksWithCommanderArt', () => {
  it('returns input unchanged when every deck already has art', async () => {
    const decks = [
      { id: 'd1', type: 'builder_deck', description: JSON.stringify({ coverArtUri: 'http://example/art.jpg' }) },
    ]
    const { client, updateCalls } = makeFakeClient()
    const result = await enrichDecksWithCommanderArt(decks, { client, persist: true })
    expect(result).toBe(decks) // same reference — short-circuit
    expect(updateCalls).toHaveLength(0)
  })

  it('merges commander art from deck_cards_view and strips internal __artNeedsPersist flag', async () => {
    const decks = [
      { id: 'd1', type: 'builder_deck', description: '{}' },
    ]
    const { client, updateCalls } = makeFakeClient({
      deck_cards_view: {
        selectResponse: {
          data: [{
            deck_id: 'd1',
            name: 'Atraxa',
            scryfall_id: 'sf-atraxa',
            color_identity: ['W', 'U', 'B', 'G'],
            image_uri: 'http://example/atraxa.jpg',
            art_crop_uri: 'http://example/atraxa-crop.jpg',
            is_commander: true,
          }],
          error: null,
        },
      },
    })
    const result = await enrichDecksWithCommanderArt(decks, { client, persist: false })
    expect(result).toHaveLength(1)
    expect(result[0].__meta).toBeDefined()
    expect(result[0].description).not.toBe('{}') // updated
    expect('__artNeedsPersist' in result[0]).toBe(false) // stripped
    expect(updateCalls).toHaveLength(0) // persist:false skips writes
  })

  it('writes folder updates only when persist=true', async () => {
    const decks = [
      { id: 'd1', type: 'builder_deck', description: '{}' },
    ]
    const { client, updateCalls } = makeFakeClient({
      deck_cards_view: {
        selectResponse: {
          data: [{ deck_id: 'd1', name: 'Atraxa', scryfall_id: 'sf-atraxa', is_commander: true, image_uri: 'x' }],
          error: null,
        },
      },
    })
    await enrichDecksWithCommanderArt(decks, { client, persist: true })
    // Wait a microtask so the fire-and-forget Promise.all resolves before we assert.
    await new Promise(r => setTimeout(r, 10))
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0]).toMatchObject({ table: 'folders', col: 'id', val: 'd1' })
  })

  it('skips persist for decks that did not get enriched', async () => {
    const decks = [
      { id: 'd1', type: 'builder_deck', description: '{}' },
      { id: 'd2', type: 'builder_deck', description: '{}' },
    ]
    const { client, updateCalls } = makeFakeClient({
      deck_cards_view: {
        // Only d1 gets a commander row back
        selectResponse: {
          data: [{ deck_id: 'd1', name: 'X', scryfall_id: 'sf-x', is_commander: true, image_uri: 'x' }],
          error: null,
        },
      },
    })
    const result = await enrichDecksWithCommanderArt(decks, { client, persist: true })
    await new Promise(r => setTimeout(r, 10))
    expect(result).toHaveLength(2)
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].val).toBe('d1') // d2 was not enriched
  })

  it('falls back to deck_allocations_view for collection decks with named commander', async () => {
    const decks = [
      {
        id: 'd1',
        type: 'deck',
        description: JSON.stringify({ commanderName: 'Atraxa, Praetors Voice' }),
      },
    ]
    const { client, updateCalls } = makeFakeClient({
      deck_cards_view: {
        // No commander row in deck_cards (collection deck has no deck_cards rows)
        selectResponse: { data: [], error: null },
      },
      deck_allocations_view: {
        selectResponse: {
          data: [{
            deck_id: 'd1',
            name: 'Atraxa, Praetors Voice',
            scryfall_id: 'sf-atraxa',
            image_uri: 'http://example/atraxa.jpg',
          }],
          error: null,
        },
      },
    })
    const result = await enrichDecksWithCommanderArt(decks, { client, persist: false })
    expect(result[0].description).not.toBe(decks[0].description)
    expect(result[0].__meta).toBeDefined()
    // updateCalls is empty (persist:false), but the merge happened
    expect(updateCalls).toHaveLength(0)
  })

  it('does not persist when persist=false even with enrichments', async () => {
    const decks = [
      { id: 'd1', type: 'builder_deck', description: '{}' },
    ]
    const { client, updateCalls } = makeFakeClient({
      deck_cards_view: {
        selectResponse: {
          data: [{ deck_id: 'd1', name: 'X', scryfall_id: 'sf-x', is_commander: true, image_uri: 'x' }],
          error: null,
        },
      },
    })
    await enrichDecksWithCommanderArt(decks, { client, persist: false })
    await new Promise(r => setTimeout(r, 10))
    expect(updateCalls).toHaveLength(0)
  })
})

import { beforeEach, describe, it, expect } from 'vitest'
import { fetchDeckForView, isDeckPubliclyViewable } from './deckViewData'

// Minimal PostgREST-shaped stub. `settle` lets a test hold both requests open at
// once so it can observe whether they were issued concurrently.
function makeClient({ folder = null, folderError = null, cards = [], onCall = () => {} } = {}) {
  const deferred = []
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => {
            onCall('folders')
            return new Promise(resolve => deferred.push(() => resolve({ data: folder, error: folderError })))
          },
        }),
      }),
    }),
    rpc: (name, args) => {
      onCall(name, args)
      return new Promise(resolve => deferred.push(() => resolve({ data: cards, error: null })))
    },
  }
  return { client, settle: () => deferred.forEach(fn => fn()) }
}

const publicDeck = {
  id: 'deck-1',
  user_id: 'owner-1',
  name: 'Test Deck',
  description: JSON.stringify({ is_public: true }),
}
const privateDeck = { ...publicDeck, description: JSON.stringify({ is_public: false }) }

describe('fetchDeckForView', () => {
  it('issues both reads before either resolves', async () => {
    const calls = []
    const { client, settle } = makeClient({
      folder: publicDeck,
      cards: [{ name: 'Sol Ring' }],
      onCall: name => calls.push(name),
    })

    const pending = fetchDeckForView({ client, id: 'deck-1' })
    // Nothing has resolved yet, so anything already called was issued in
    // parallel. Serial code could only have called the first one.
    await Promise.resolve()
    expect(calls).toEqual(['folders', 'get_deck_cards_for_view'])

    settle()
    await pending
  })

  it('returns the deck, parsed meta, and cards for a public deck', async () => {
    const { client, settle } = makeClient({ folder: publicDeck, cards: [{ name: 'Sol Ring' }] })
    const pending = fetchDeckForView({ client, id: 'deck-1' })
    settle()

    const result = await pending
    expect(result.error).toBeUndefined()
    expect(result.deck.name).toBe('Test Deck')
    expect(result.meta.is_public).toBe(true)
    expect(result.cards).toEqual([{ name: 'Sol Ring' }])
  })

  it('hides a private deck from a stranger', async () => {
    const { client, settle } = makeClient({ folder: privateDeck, cards: [{ name: 'Sol Ring' }] })
    const pending = fetchDeckForView({ client, id: 'deck-1', viewerId: 'someone-else' })
    settle()

    // Reported as missing, not forbidden — a stranger should not be able to
    // probe which deck ids exist.
    expect(await pending).toEqual({ error: 'Deck not found' })
  })

  it('shows a private deck to its owner', async () => {
    const { client, settle } = makeClient({ folder: privateDeck, cards: [{ name: 'Sol Ring' }] })
    const pending = fetchDeckForView({ client, id: 'deck-1', viewerId: 'owner-1' })
    settle()

    expect((await pending).deck.id).toBe('deck-1')
  })

  it('reports a missing deck', async () => {
    const { client, settle } = makeClient({ folder: null })
    const pending = fetchDeckForView({ client, id: 'nope' })
    settle()

    expect(await pending).toEqual({ error: 'Deck not found' })
  })

  it('reports a failed folder read as missing', async () => {
    const { client, settle } = makeClient({ folder: null, folderError: { message: 'boom' } })
    const pending = fetchDeckForView({ client, id: 'deck-1' })
    settle()

    expect(await pending).toEqual({ error: 'Deck not found' })
  })

  it('renders a public deck with no cards rather than failing', async () => {
    const { client, settle } = makeClient({ folder: publicDeck, cards: null })
    const pending = fetchDeckForView({ client, id: 'deck-1' })
    settle()

    expect((await pending).cards).toEqual([])
  })
})

describe('isDeckPubliclyViewable', () => {
  const id = 'b29724b0-b79c-4cc0-b64b-dba7a5db17d8'
  const clientReturning = result => ({ rpc: async (name, args) => { calls.push([name, args]); return result } })
  let calls
  beforeEach(() => { calls = [] })

  it('asks get_deck_og_meta, which answers null for a deck nobody may see', async () => {
    expect(await isDeckPubliclyViewable({ client: clientReturning({ data: null, error: null }), id })).toBe(false)
    expect(calls).toEqual([['get_deck_og_meta', { p_deck_id: id }]])
  })

  it('is true only when the RPC returns deck metadata', async () => {
    const client = clientReturning({ data: { name: 'Atraxa' }, error: null })
    expect(await isDeckPubliclyViewable({ client, id })).toBe(true)
  })

  it('answers false when the lookup fails, so the caller shows a login page', async () => {
    expect(await isDeckPubliclyViewable({ client: clientReturning({ data: null, error: { message: 'boom' } }), id })).toBe(false)
    const throwing = { rpc: async () => { throw new Error('offline') } }
    expect(await isDeckPubliclyViewable({ client: throwing, id })).toBe(false)
    expect(await isDeckPubliclyViewable({ client: throwing, id: null })).toBe(false)
  })
})

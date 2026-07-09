import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubGlobal('navigator', { onLine: true })

// In-memory stand-ins for "server" (Supabase) and "local" (IDB) state so the
// sync orchestrator's merge behavior can be asserted end-to-end without a
// real database. Mirrors the chainable-stub pattern used in wishlistSync.test.js.
const sbState = { ownedCardsView: [], cardsTable: [] }
const idbState = { cards: [], meta: new Map() }

function applyFilters(rows, filters) {
  let out = rows
  for (const [col, val] of Object.entries(filters.eq)) out = out.filter(r => r[col] === val)
  // gt is only used on updated_at; compare as timestamps like Postgres would,
  // since the client (JS toISOString) and server format timestamps differently.
  for (const [col, val] of Object.entries(filters.gt)) out = out.filter(r => Date.parse(r[col]) > Date.parse(val))
  return out
}

function makeQuery(table) {
  const filters = { eq: {}, gt: {} }
  let rangeFrom = 0
  let rangeTo = Infinity
  const q = {
    select() { return q },
    eq(col, val) { filters.eq[col] = val; return q },
    gt(col, val) { filters.gt[col] = val; return q },
    order() { return q },
    range(from, to) { rangeFrom = from; rangeTo = to; return q },
    then(resolve, reject) {
      const source = table === 'owned_cards_view' ? sbState.ownedCardsView : sbState.cardsTable
      const rows = applyFilters(source, filters)
        .slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(rangeFrom, rangeTo + 1)
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject)
    },
  }
  return q
}

vi.mock('./supabase', () => ({ sb: { from: (t) => makeQuery(t) } }))

vi.mock('./db', () => ({
  getMeta: vi.fn(async (key) => idbState.meta.get(key) ?? null),
  setMeta: vi.fn(async (key, value) => { idbState.meta.set(key, value) }),
  getLocalCards: vi.fn(async (userId) => idbState.cards.filter(c => c.user_id === userId)),
  putCards: vi.fn(async (cards) => {
    for (const card of cards || []) {
      const i = idbState.cards.findIndex(c => c.id === card.id)
      if (i >= 0) idbState.cards[i] = card
      else idbState.cards.push(card)
    }
  }),
  deleteCard: vi.fn(async (id) => {
    idbState.cards = idbState.cards.filter(c => c.id !== id)
  }),
  deleteAllCards: vi.fn(async (userId) => {
    idbState.cards = idbState.cards.filter(c => c.user_id !== userId)
  }),
}))

import { computeIdsToDelete, syncOwnedCards, fetchCollectionCards } from './collectionFetchers'

const USER = 'user-1'

beforeEach(() => {
  sbState.ownedCardsView = []
  sbState.cardsTable = []
  idbState.cards = []
  idbState.meta = new Map()
})

describe('computeIdsToDelete', () => {
  it('returns ids present locally but absent from the fresh set', () => {
    const local = new Set(['a', 'b', 'c'])
    const fresh = new Set(['a', 'c'])
    expect(computeIdsToDelete(local, fresh)).toEqual(['b'])
  })

  it('returns an empty array when nothing was removed', () => {
    const local = new Set(['a', 'b'])
    const fresh = new Set(['a', 'b', 'c'])
    expect(computeIdsToDelete(local, fresh)).toEqual([])
  })
})

describe('syncOwnedCards', () => {
  it('does a full fetch and seeds IDB on first sync (no cursor yet)', async () => {
    sbState.ownedCardsView = [
      { id: 'c1', user_id: USER, name: 'Forest', updated_at: '2026-01-01T00:00:00Z' },
      { id: 'c2', user_id: USER, name: 'Sol Ring', updated_at: '2026-01-01T00:00:00Z' },
    ]
    sbState.cardsTable = [
      { id: 'c1', user_id: USER },
      { id: 'c2', user_id: USER },
    ]

    const result = await syncOwnedCards(USER)

    expect(result.map(c => c.id).sort()).toEqual(['c1', 'c2'])
    expect(idbState.cards.map(c => c.id).sort()).toEqual(['c1', 'c2'])
    // The cursor must be the newest *server* timestamp seen, not the device
    // clock — a fast client clock would otherwise skip other devices' writes.
    expect(idbState.meta.get(`cards_synced_at:${USER}`)).toBe('2026-01-01T00:00:00Z')
  })

  it('stores no cursor after a first sync of an empty collection', async () => {
    sbState.ownedCardsView = []
    sbState.cardsTable = []

    const result = await syncOwnedCards(USER)

    expect(result).toEqual([])
    expect(idbState.meta.get(`cards_synced_at:${USER}`)).toBeUndefined()
  })

  it('only fetches rows changed since the cursor on a later sync', async () => {
    idbState.meta.set(`cards_synced_at:${USER}`, '2026-01-01T00:00:00Z')
    idbState.cards = [
      { id: 'c1', user_id: USER, name: 'Forest', qty: 1 },
      { id: 'c2', user_id: USER, name: 'Sol Ring', qty: 1 },
    ]
    // Only c2's qty changed server-side; c1 is untouched (and deliberately
    // absent from ownedCardsView to prove it isn't re-fetched).
    sbState.ownedCardsView = [
      { id: 'c2', user_id: USER, name: 'Sol Ring', qty: 2, updated_at: '2026-02-01T00:00:00Z' },
    ]
    sbState.cardsTable = [
      { id: 'c1', user_id: USER },
      { id: 'c2', user_id: USER },
    ]

    const result = await syncOwnedCards(USER)

    const byId = Object.fromEntries(result.map(c => [c.id, c]))
    expect(byId.c1.qty).toBe(1) // untouched, preserved from IDB
    expect(byId.c2.qty).toBe(2) // merged in from the incremental fetch
    // Cursor advances to the newest updated_at that was actually fetched.
    expect(idbState.meta.get(`cards_synced_at:${USER}`)).toBe('2026-02-01T00:00:00Z')
  })

  it('picks up a row whose updated_at falls just before the cursor (overlap window)', async () => {
    // A write committed on another device after our last fetch can carry an
    // updated_at slightly *below* the stored cursor (in-flight transaction,
    // shared timestamps). The overlap re-queries that window so it still lands.
    idbState.meta.set(`cards_synced_at:${USER}`, '2026-01-01T00:10:00.000Z')
    idbState.cards = [{ id: 'c1', user_id: USER, name: 'Forest', qty: 1 }]
    sbState.ownedCardsView = [
      { id: 'c1', user_id: USER, name: 'Forest', qty: 3, updated_at: '2026-01-01T00:07:00.000Z' },
    ]
    sbState.cardsTable = [{ id: 'c1', user_id: USER }]

    const result = await syncOwnedCards(USER)

    expect(result[0].qty).toBe(3)
    // The cursor never regresses below its previous value, even though the
    // overlap fetch only saw an older timestamp.
    expect(idbState.meta.get(`cards_synced_at:${USER}`)).toBe('2026-01-01T00:10:00.000Z')
  })

  it('keeps the cursor unchanged when nothing changed server-side', async () => {
    idbState.meta.set(`cards_synced_at:${USER}`, '2026-01-01T00:00:00.000Z')
    idbState.cards = [{ id: 'c1', user_id: USER, name: 'Forest', qty: 1 }]
    sbState.ownedCardsView = []
    sbState.cardsTable = [{ id: 'c1', user_id: USER }]

    await syncOwnedCards(USER)

    expect(idbState.meta.get(`cards_synced_at:${USER}`)).toBe('2026-01-01T00:00:00.000Z')
  })

  it('removes cards that were deleted server-side (hard delete has no updated_at trace)', async () => {
    idbState.meta.set(`cards_synced_at:${USER}`, '2026-01-01T00:00:00Z')
    idbState.cards = [
      { id: 'c1', user_id: USER, name: 'Forest' },
      { id: 'c2', user_id: USER, name: 'Sol Ring' },
    ]
    sbState.ownedCardsView = [] // nothing changed
    sbState.cardsTable = [{ id: 'c1', user_id: USER }] // c2 no longer exists server-side

    const result = await syncOwnedCards(USER)

    expect(result.map(c => c.id)).toEqual(['c1'])
  })

  it('fetchCollectionCards delegates to the same incremental sync', async () => {
    sbState.ownedCardsView = [{ id: 'c1', user_id: USER, name: 'Forest', updated_at: '2026-01-01T00:00:00Z' }]
    sbState.cardsTable = [{ id: 'c1', user_id: USER }]

    const result = await fetchCollectionCards(USER)
    expect(result.map(c => c.id)).toEqual(['c1'])
  })
})

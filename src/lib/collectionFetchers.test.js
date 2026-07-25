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
  // Shard bounds — the full-fetch path splits the id space and walks the
  // buckets concurrently.
  for (const [col, val] of Object.entries(filters.gte)) out = out.filter(r => r[col] >= val)
  for (const [col, val] of Object.entries(filters.lt)) out = out.filter(r => r[col] < val)
  for (const [col, val] of Object.entries(filters.gt)) {
    // `id` is the keyset cursor and compares as text; updated_at compares as a
    // timestamp like Postgres would, since the client (JS toISOString) and
    // server format timestamps differently.
    out = col === 'id'
      ? out.filter(r => r[col] > val)
      : out.filter(r => Date.parse(r[col]) > Date.parse(val))
  }
  return out
}

// Counts every request the fake server sees, so tests can assert that the
// sync stopped paging the whole collection on every run.
const requestLog = []

function makeQuery(table) {
  const filters = { eq: {}, gt: {}, gte: {}, lt: {} }
  let orderCol = 'id'
  let rowLimit = Infinity
  let wantsCount = false
  const q = {
    select(_cols, opts) {
      if (opts?.count) wantsCount = true
      return q
    },
    eq(col, val) { filters.eq[col] = val; return q },
    gt(col, val) { filters.gt[col] = val; return q },
    gte(col, val) { filters.gte[col] = val; return q },
    lt(col, val) { filters.lt[col] = val; return q },
    order(col) { if (col) orderCol = col; return q },
    limit(n) { rowLimit = n; return q },
    then(resolve, reject) {
      const source = table === 'owned_cards_view' ? sbState.ownedCardsView : sbState.cardsTable
      const matched = applyFilters(source, filters)
      const rows = matched
        .slice().sort((a, b) => (a[orderCol] < b[orderCol] ? -1 : a[orderCol] > b[orderCol] ? 1 : 0))
        .slice(0, rowLimit)
      // A count request asks for the total via Content-Range with limit=0, so
      // it carries the full count but no rows.
      requestLog.push({ table, kind: wantsCount ? 'count' : 'rows' })
      if (wantsCount) {
        return Promise.resolve({ data: rows, count: matched.length, error: null }).then(resolve, reject)
      }
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
  requestLog.length = 0
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

  // Collections bigger than one page used to be fetched with OFFSET, which
  // re-scans (and re-joins card_prints for) every skipped row — deep pages hit
  // the statement timeout and the sync died with a 500. Paging must seek on the
  // last id read instead, and must still return every row.
  it('walks a multi-page collection by keyset without dropping rows', async () => {
    const total = 2500
    sbState.ownedCardsView = Array.from({ length: total }, (_, i) => ({
      id: `c${String(i).padStart(5, '0')}`,
      user_id: USER,
      name: `Card ${i}`,
      updated_at: '2026-01-01T00:00:00Z',
    }))
    sbState.cardsTable = sbState.ownedCardsView.map(c => ({ id: c.id, user_id: c.user_id }))

    const result = await syncOwnedCards(USER)

    expect(result).toHaveLength(total)
    expect(new Set(result.map(c => c.id)).size).toBe(total)
    expect(idbState.cards).toHaveLength(total)
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

  // The id scan pages the entire `cards` table — a round trip per 1000 cards on
  // every single sync, which dominated Home's load time. A count comparison
  // gates it: inserts arrive via the updated_at fetch, so post-merge local size
  // can only exceed the server's when something was deleted.
  it('skips the full id scan when the server count matches after merging', async () => {
    idbState.meta.set(`cards_synced_at:${USER}`, '2026-01-01T00:00:00Z')
    idbState.cards = [
      { id: 'c1', user_id: USER, name: 'Forest' },
      { id: 'c2', user_id: USER, name: 'Sol Ring' },
    ]
    sbState.ownedCardsView = [
      { id: 'c3', user_id: USER, name: 'Island', updated_at: '2026-02-01T00:00:00Z' },
    ]
    sbState.cardsTable = [
      { id: 'c1', user_id: USER }, { id: 'c2', user_id: USER }, { id: 'c3', user_id: USER },
    ]

    const result = await syncOwnedCards(USER)

    expect(result.map(c => c.id).sort()).toEqual(['c1', 'c2', 'c3'])
    expect(requestLog.filter(r => r.kind === 'count')).toHaveLength(1)
    // No row-fetch against `cards` — that's the id scan we're avoiding.
    expect(requestLog.filter(r => r.table === 'cards' && r.kind === 'rows')).toHaveLength(0)
  })

  it('still runs the id scan when the server count is short', async () => {
    idbState.meta.set(`cards_synced_at:${USER}`, '2026-01-01T00:00:00Z')
    idbState.cards = [
      { id: 'c1', user_id: USER, name: 'Forest' },
      { id: 'c2', user_id: USER, name: 'Sol Ring' },
    ]
    sbState.ownedCardsView = []
    sbState.cardsTable = [{ id: 'c1', user_id: USER }]

    const result = await syncOwnedCards(USER)

    expect(result.map(c => c.id)).toEqual(['c1'])
    expect(requestLog.filter(r => r.table === 'cards' && r.kind === 'rows').length).toBeGreaterThan(0)
  })

  it('detects a delete that happened alongside an insert', async () => {
    idbState.meta.set(`cards_synced_at:${USER}`, '2026-01-01T00:00:00Z')
    idbState.cards = [
      { id: 'c1', user_id: USER, name: 'Forest' },
      { id: 'c2', user_id: USER, name: 'Sol Ring' },
    ]
    // c2 deleted, c3 added — the server count is unchanged, but the local set
    // grows by the insert, so the sizes still disagree.
    sbState.ownedCardsView = [
      { id: 'c3', user_id: USER, name: 'Island', updated_at: '2026-02-01T00:00:00Z' },
    ]
    sbState.cardsTable = [{ id: 'c1', user_id: USER }, { id: 'c3', user_id: USER }]

    const result = await syncOwnedCards(USER)

    expect(result.map(c => c.id).sort()).toEqual(['c1', 'c3'])
  })

  it('fetchCollectionCards delegates to the same incremental sync', async () => {
    sbState.ownedCardsView = [{ id: 'c1', user_id: USER, name: 'Forest', updated_at: '2026-01-01T00:00:00Z' }]
    sbState.cardsTable = [{ id: 'c1', user_id: USER }]

    const result = await fetchCollectionCards(USER)
    expect(result.map(c => c.id)).toEqual(['c1'])
  })
})

// Seeding the React Query cache from IDB for the first paint.
//
// The case that motivated these: on a phone, Collection showed a full grid of
// tiles with names, set codes and purchase-price fallbacks for 10-15 s with no
// card images, then every visible image loaded at once. Card rows were being
// hydrated from IDB while the Scryfall map — holding the image URLs, in the
// same IndexedDB — was left to the network query.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const getLocalCards = vi.fn()
const getLocalFolders = vi.fn()
const getAllLocalFolderCards = vi.fn()
const getAllDeckAllocationsForUser = vi.fn()
const getAllLocalListItems = vi.fn()
const getInstantCache = vi.fn()

vi.mock('./db', () => ({
  getLocalCards: (...a) => getLocalCards(...a),
  getLocalFolders: (...a) => getLocalFolders(...a),
  getAllLocalFolderCards: (...a) => getAllLocalFolderCards(...a),
  getAllDeckAllocationsForUser: (...a) => getAllDeckAllocationsForUser(...a),
  getAllLocalListItems: (...a) => getAllLocalListItems(...a),
}))
vi.mock('./scryfall', () => ({ getInstantCache: (...a) => getInstantCache(...a) }))

const { hydrateCollectionQueriesFromIdb } = await import('./idbQueryBridge')

const USER = 'user-1'

function makeClient() {
  const data = new Map()
  return {
    data,
    setQueryData: vi.fn((key, value) => data.set(JSON.stringify(key), value)),
    getQueryData: vi.fn(key => data.get(JSON.stringify(key))),
    get: key => data.get(JSON.stringify(key)),
  }
}

/** Lets the fire-and-forget seed settle without exposing a promise from the module. */
const flush = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => {
  vi.clearAllMocks()
  getLocalCards.mockResolvedValue([{ id: 'c1' }])
  getLocalFolders.mockResolvedValue([])
  getAllLocalFolderCards.mockResolvedValue([])
  getAllDeckAllocationsForUser.mockResolvedValue([])
  getAllLocalListItems.mockResolvedValue([])
  getInstantCache.mockResolvedValue({ 'lea-1': { key: 'lea-1', image_uris: { normal: 'x' } } })
})

describe('hydrateCollectionQueriesFromIdb', () => {
  it('seeds the Scryfall map so images can paint before any network call', async () => {
    const qc = makeClient()

    await hydrateCollectionQueriesFromIdb(qc, USER)
    await flush()

    expect(qc.get(['sfMap', USER])).toEqual({
      'lea-1': { key: 'lea-1', image_uris: { normal: 'x' } },
    })
  })

  it('marks the seed stale so the real query still runs', async () => {
    const qc = makeClient()

    await hydrateCollectionQueriesFromIdb(qc, USER)
    await flush()

    // updatedAt: 0 is what makes React Query treat the seed as stale despite
    // the 24h staleTime — without it the network refresh would be skipped and
    // prices would never arrive.
    const call = qc.setQueryData.mock.calls.find(([key]) => key[0] === 'sfMap')
    expect(call?.[2]).toEqual({ updatedAt: 0 })
  })

  it('does not seed an empty cache', async () => {
    // An empty object still counts as data and would satisfy the query,
    // leaving the grid permanently imageless.
    getInstantCache.mockResolvedValue({})
    const qc = makeClient()

    await hydrateCollectionQueriesFromIdb(qc, USER)
    await flush()

    expect(qc.setQueryData.mock.calls.some(([key]) => key[0] === 'sfMap')).toBe(false)
  })

  it('does not seed when the cache is cold', async () => {
    getInstantCache.mockResolvedValue(null)
    const qc = makeClient()

    await hydrateCollectionQueriesFromIdb(qc, USER)
    await flush()

    expect(qc.setQueryData.mock.calls.some(([key]) => key[0] === 'sfMap')).toBe(false)
  })

  it('still hydrates cards when the Scryfall cache read fails', async () => {
    // The seed is an enhancement; losing it must not cost the card rows, which
    // are what actually put tiles on screen.
    getInstantCache.mockRejectedValue(new Error('idb unavailable'))
    const qc = makeClient()

    await expect(hydrateCollectionQueriesFromIdb(qc, USER)).resolves.toBeUndefined()
    await flush()

    expect(qc.get(['cards', USER])).toEqual([{ id: 'c1' }])
  })

  it('does not clobber a network result that resolved first', async () => {
    // The seed is fire-and-forget, so on a warm cache and a fast connection the
    // query can land while the local read is still in flight. Its map is this
    // one plus current prices — overwriting it would un-price the whole grid.
    const qc = makeClient()
    const fresh = { 'lea-1': { key: 'lea-1', image_uris: { normal: 'x' }, prices: { eur: '1.00' } } }

    let release
    getInstantCache.mockReturnValue(new Promise(r => { release = r }))

    await hydrateCollectionQueriesFromIdb(qc, USER)
    qc.setQueryData(['sfMap', USER], fresh)   // network wins the race
    release({ 'lea-1': { key: 'lea-1', image_uris: { normal: 'x' } } })
    await flush()

    expect(qc.get(['sfMap', USER])).toBe(fresh)
  })

  it('skips the Scryfall read entirely when there are no local cards', async () => {
    getLocalCards.mockResolvedValue([])
    const qc = makeClient()

    await hydrateCollectionQueriesFromIdb(qc, USER)
    await flush()

    expect(getInstantCache).not.toHaveBeenCalled()
  })
})

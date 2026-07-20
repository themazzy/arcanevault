import { describe, expect, it, vi } from 'vitest'
import {
  invalidateHomeSnapshot,
  invalidateOwnedCollectionQueries,
  invalidateWishlistQueries,
  removeDecksFromHomeSnapshot,
} from './queryInvalidation'

function makeClient() {
  return {
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
    setQueryData: vi.fn(),
  }
}

const keysFrom = client =>
  client.invalidateQueries.mock.calls.map(([arg]) => arg.queryKey)

describe('invalidateOwnedCollectionQueries', () => {
  it('invalidates only placements by default', async () => {
    const client = makeClient()
    await invalidateOwnedCollectionQueries(client, 'user-1')
    expect(keysFrom(client)).toEqual([['folderPlacements', 'user-1']])
  })

  it('invalidates cards and sfMap together, never one without the other', async () => {
    const client = makeClient()
    await invalidateOwnedCollectionQueries(client, 'user-1', { includeCards: true })
    const keys = keysFrom(client)
    expect(keys).toContainEqual(['cards', 'user-1'])
    expect(keys).toContainEqual(['sfMap', 'user-1'])
  })

  it('can invalidate cards without placements', async () => {
    const client = makeClient()
    await invalidateOwnedCollectionQueries(client, 'user-1', {
      includeCards: true,
      includePlacements: false,
    })
    expect(keysFrom(client)).not.toContainEqual(['folderPlacements', 'user-1'])
  })

  it('invalidates the full set when folders and cards are requested', async () => {
    const client = makeClient()
    await invalidateOwnedCollectionQueries(client, 'user-1', {
      includeFolders: true,
      includeCards: true,
    })
    expect(keysFrom(client)).toEqual([
      ['folderPlacements', 'user-1'],
      ['folders', 'user-1'],
      ['cards', 'user-1'],
      ['sfMap', 'user-1'],
    ])
  })

  it('scopes every key to the given user', async () => {
    const client = makeClient()
    await invalidateOwnedCollectionQueries(client, 'user-2', {
      includeFolders: true,
      includeCards: true,
    })
    for (const key of keysFrom(client)) expect(key[1]).toBe('user-2')
  })

  it('no-ops without a client or user id', async () => {
    const client = makeClient()
    await invalidateOwnedCollectionQueries(client, null)
    await invalidateOwnedCollectionQueries(null, 'user-1')
    expect(client.invalidateQueries).not.toHaveBeenCalled()
  })
})

describe('invalidateWishlistQueries', () => {
  it('invalidates list items by default', async () => {
    const client = makeClient()
    await invalidateWishlistQueries(client, 'user-1')
    expect(keysFrom(client)).toEqual([['listItems', 'user-1']])
  })

  it('includes folders when requested', async () => {
    const client = makeClient()
    await invalidateWishlistQueries(client, 'user-1', { includeFolders: true })
    expect(keysFrom(client)).toContainEqual(['folders', 'user-1'])
  })
})

describe('Home snapshot invalidation', () => {
  it('invalidates the user-scoped Home snapshot', async () => {
    const client = makeClient()
    await invalidateHomeSnapshot(client, 'user-1')
    expect(keysFrom(client)).toEqual([['home-snapshot', 'user-1']])
  })

  it('removes deleted decks from cached Home data before revalidation', async () => {
    const client = makeClient()
    await removeDecksFromHomeSnapshot(client, 'user-1', ['deck-1'])

    const [key, updater] = client.setQueryData.mock.calls[0]
    expect(key).toEqual(['home-snapshot', 'user-1'])
    expect(updater({
      cards: [{ id: 'card-1' }],
      builderDecks: [{ id: 'deck-1' }, { id: 'deck-2' }],
    })).toEqual({
      cards: [{ id: 'card-1' }],
      builderDecks: [{ id: 'deck-2' }],
    })
    expect(keysFrom(client)).toContainEqual(['home-snapshot', 'user-1'])
  })
})

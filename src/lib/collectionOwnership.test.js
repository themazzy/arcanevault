import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabase + the IDB layer before importing the module under test.
vi.mock('./supabase', () => ({
  sb: { from: vi.fn() },
}))
vi.mock('./db', () => ({
  deleteCard: vi.fn(async () => {}),
}))

const { sb } = await import('./supabase')
const { removeFolderCardPlacements, findUnplacedCardIds, pruneUnplacedCards } = await import('./collectionOwnership')

// Records every folder_cards delete as { folderId, cardIds }.
function mockDeleteChain(calls) {
  sb.from.mockImplementation(table => ({
    delete: () => ({
      eq: (col, folderId) => ({
        in: (col2, cardIds) => {
          calls.push({ table, col, folderId, col2, cardIds })
          return Promise.resolve({ error: null })
        },
      }),
    }),
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('removeFolderCardPlacements', () => {
  // Regression: binder bulk delete/move issued one delete request per card
  // row. The helper must group rows by source folder and delete each group
  // with a single .in() call.
  it('issues one delete per source folder, not per row', async () => {
    const calls = []
    mockDeleteChain(calls)

    await removeFolderCardPlacements([
      { id: 'card-1', folderId: 'binder-a' },
      { id: 'card-2', folderId: 'binder-a' },
      { id: 'card-3', folderId: 'binder-b' },
    ])

    expect(calls).toEqual([
      { table: 'folder_cards', col: 'folder_id', folderId: 'binder-a', col2: 'card_id', cardIds: ['card-1', 'card-2'] },
      { table: 'folder_cards', col: 'folder_id', folderId: 'binder-b', col2: 'card_id', cardIds: ['card-3'] },
    ])
  })

  it('chunks a folder with more than 100 rows into multiple deletes', async () => {
    const calls = []
    mockDeleteChain(calls)

    const rows = Array.from({ length: 150 }, (_, i) => ({ id: `card-${i}`, folderId: 'binder-big' }))
    await removeFolderCardPlacements(rows)

    expect(calls.map(c => c.cardIds.length)).toEqual([100, 50])
    expect(calls.flatMap(c => c.cardIds)).toEqual(rows.map(r => r.id))
  })

  it('skips rows without an id or folderId and no-ops on empty input', async () => {
    const calls = []
    mockDeleteChain(calls)

    await removeFolderCardPlacements([{ id: 'card-1' }, { folderId: 'binder-a' }, null])
    await removeFolderCardPlacements([])
    await removeFolderCardPlacements(undefined)

    expect(calls).toEqual([])
  })
})

describe('findUnplacedCardIds', () => {
  const cards = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('treats a card with a folder_cards row as placed even when the folder is not in the resolved map', () => {
    // The regression: a just-created binder's placement exists in the raw rows,
    // but buildCardFolderMap dropped it because the binder is not in `folders`
    // yet, leaving cardFolderMap empty for that card. It must NOT be pruned.
    const placementData = { folderCards: [{ card_id: 'a' }], deckAllocations: [] }
    expect(findUnplacedCardIds(cards, placementData, {})).toEqual(['b', 'c'])
  })

  it('treats a card with a deck_allocations row as placed', () => {
    const placementData = { folderCards: [], deckAllocations: [{ card_id: 'b' }] }
    expect(findUnplacedCardIds(cards, placementData, {})).toEqual(['a', 'c'])
  })

  it('flags cards with no placement row in either table', () => {
    const placementData = { folderCards: [{ card_id: 'a' }], deckAllocations: [{ card_id: 'b' }] }
    expect(findUnplacedCardIds(cards, placementData, {})).toEqual(['c'])
  })

  it('honors the cardFolderMap as an extra placed source (optimistic patch)', () => {
    const placementData = { folderCards: [], deckAllocations: [] }
    const cardFolderMap = { a: [{ id: 'f1' }] }
    expect(findUnplacedCardIds(cards, placementData, cardFolderMap)).toEqual(['b', 'c'])
  })

  it('returns everything unplaced when there are no placements at all', () => {
    expect(findUnplacedCardIds(cards, { folderCards: [], deckAllocations: [] }, {})).toEqual(['a', 'b', 'c'])
  })

  it('does not crash on missing or empty inputs', () => {
    expect(findUnplacedCardIds([], undefined)).toEqual([])
    expect(findUnplacedCardIds(undefined, undefined)).toEqual([])
    expect(findUnplacedCardIds(cards, null, undefined)).toEqual(['a', 'b', 'c'])
  })
})

describe('pruneUnplacedCards', () => {
  /**
   * Stands in for Supabase during a prune.
   *
   * `placedOnServer` is what the SERVER says is placed — deliberately allowed
   * to disagree with the candidate list, because that disagreement is the
   * whole point of the re-check.
   */
  function mockPrune({ placedOnServer = [], deletes = [] }) {
    sb.from.mockImplementation(table => {
      if (table === 'cards') {
        return { delete: () => ({ in: (_c, ids) => { deletes.push(...ids); return Promise.resolve({ error: null }) } }) }
      }
      return {
        select: () => ({
          in: (_col, ids) => Promise.resolve({
            data: ids.filter(id => placedOnServer.includes(id)).map(id => ({ card_id: id })),
            error: null,
          }),
        }),
      }
    })
  }

  it('does NOT delete a candidate that is placed on the server', async () => {
    // The multi-device case. A card placed on another device looks unplaced to
    // this one until its placements sync, so it gets nominated — and must
    // survive anyway. If this test fails, a user's cards are being deleted
    // because one device had not caught up.
    const deletes = []
    mockPrune({ placedOnServer: ['card-on-other-device'], deletes })

    const pruned = await pruneUnplacedCards(['card-on-other-device'])

    expect(deletes).toEqual([])
    expect(pruned).toEqual([])
  })

  it('deletes only the candidates the server also considers unplaced', async () => {
    const deletes = []
    mockPrune({ placedOnServer: ['keep-me'], deletes })

    const pruned = await pruneUnplacedCards(['keep-me', 'genuinely-orphaned'])

    expect(deletes).toEqual(['genuinely-orphaned'])
    expect(pruned).toEqual(['genuinely-orphaned'])
  })

  it('counts a deck allocation as placed, not just a binder row', async () => {
    // Both tables are checked; a card living only in a collection deck is placed.
    const deletes = []
    let call = 0
    sb.from.mockImplementation(table => {
      if (table === 'cards') {
        return { delete: () => ({ in: (_c, ids) => { deletes.push(...ids); return Promise.resolve({ error: null }) } }) }
      }
      return {
        select: () => ({
          in: (_col, ids) => {
            call += 1
            // folder_cards: nothing. deck_allocations: holds it.
            return Promise.resolve({ data: call === 1 ? [] : ids.map(id => ({ card_id: id })), error: null })
          },
        }),
      }
    })

    expect(await pruneUnplacedCards(['deck-only-card'])).toEqual([])
    expect(deletes).toEqual([])
  })

  it('throws rather than deleting when the placement check fails', async () => {
    // Fail closed. Treating an errored read as "no placements" would delete
    // the user's collection on a transient network blip.
    const deletes = []
    sb.from.mockImplementation(table => {
      if (table === 'cards') {
        return { delete: () => ({ in: (_c, ids) => { deletes.push(...ids); return Promise.resolve({ error: null }) } }) }
      }
      return { select: () => ({ in: () => Promise.resolve({ data: null, error: { message: 'network down' } }) }) }
    })

    await expect(pruneUnplacedCards(['some-card'])).rejects.toBeTruthy()
    expect(deletes).toEqual([])
  })

  it('no-ops on empty input without touching the database', async () => {
    sb.from.mockImplementation(() => { throw new Error('should not query') })
    expect(await pruneUnplacedCards([])).toEqual([])
    expect(await pruneUnplacedCards(null)).toEqual([])
  })
})

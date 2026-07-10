import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabase + the IDB layer before importing the module under test.
vi.mock('./supabase', () => ({
  sb: { from: vi.fn() },
}))
vi.mock('./db', () => ({
  deleteCard: vi.fn(async () => {}),
}))

const { sb } = await import('./supabase')
const { removeFolderCardPlacements } = await import('./collectionOwnership')

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

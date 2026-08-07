import { describe, it, expect, vi, beforeEach } from 'vitest'

const rpc = vi.fn()
const fetchOwnedCardCount = vi.fn()
const getLocalCards = vi.fn()
const getLocalFolders = vi.fn()

vi.mock('./supabase', () => ({ sb: { rpc: (...args) => rpc(...args) } }))
vi.mock('./collectionFetchers', () => ({
  fetchOwnedCardCount: (...args) => fetchOwnedCardCount(...args),
}))
vi.mock('./db', () => ({
  getLocalCards: (...args) => getLocalCards(...args),
  getLocalFolders: (...args) => getLocalFolders(...args),
}))

const { loadHomeMode, selectBuilderDecks } = await import('./homeMode')

beforeEach(() => {
  vi.clearAllMocks()
  rpc.mockResolvedValue({ data: [], error: null })
  fetchOwnedCardCount.mockResolvedValue(0)
  getLocalCards.mockResolvedValue([])
  getLocalFolders.mockResolvedValue([])
})

describe('loadHomeMode', () => {
  it('answers the layout question from a count, never a collection walk', async () => {
    fetchOwnedCardCount.mockResolvedValue(1284)

    const result = await loadHomeMode('user-1')

    expect(result.cardCount).toBe(1284)
    expect(fetchOwnedCardCount).toHaveBeenCalledWith('user-1')
    // The whole point of the split: nothing here reads the card rows themselves.
    expect(getLocalCards).not.toHaveBeenCalled()
  })

  it('falls back to the cached card count when the server count fails', async () => {
    // Offline with a warm cache must not demote a real collection to the
    // onboarding layout.
    fetchOwnedCardCount.mockRejectedValue(new Error('offline'))
    getLocalCards.mockResolvedValue([{ id: 'a' }, { id: 'b' }])

    expect((await loadHomeMode('user-1')).cardCount).toBe(2)
  })

  it('reports no cards when the count fails and nothing is cached', async () => {
    fetchOwnedCardCount.mockRejectedValue(new Error('offline'))

    expect((await loadHomeMode('user-1')).cardCount).toBe(0)
  })

  it('falls back to cached folders when get_my_decks errors', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'timeout' } })
    getLocalFolders.mockResolvedValue([
      { id: 'd1', type: 'builder_deck', name: 'Cached', description: null },
      { id: 'b1', type: 'binder', name: 'Binder', description: null },
    ])

    const result = await loadHomeMode('user-1')

    expect(result.builderDecks.map(deck => deck.id)).toEqual(['d1'])
  })
})

describe('selectBuilderDecks', () => {
  it('keeps standalone builder decks, newest edit first', () => {
    const rows = [
      { id: 'old', type: 'builder_deck', deck_modified_at: '2026-01-01T00:00:00Z' },
      { id: 'new', type: 'builder_deck', deck_modified_at: '2026-08-01T00:00:00Z' },
      { id: 'mid', type: 'builder_deck', updated_at: '2026-05-01T00:00:00Z' },
    ]

    expect(selectBuilderDecks(rows).map(deck => deck.id)).toEqual(['new', 'mid', 'old'])
  })

  it('drops collection decks, groups, hidden decks, and linked builder halves', () => {
    const rows = [
      { id: 'keep', type: 'builder_deck' },
      { id: 'collection', type: 'deck' },
      { id: 'group', type: 'builder_deck', description: JSON.stringify({ isGroup: true }) },
      { id: 'hidden', type: 'builder_deck', description: JSON.stringify({ hideFromBuilder: true }) },
      { id: 'linked', type: 'builder_deck', description: JSON.stringify({ linked_deck_id: 'x' }) },
    ]

    expect(selectBuilderDecks(rows).map(deck => deck.id)).toEqual(['keep'])
  })

  it('tolerates a missing list', () => {
    expect(selectBuilderDecks(undefined)).toEqual([])
  })
})

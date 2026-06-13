import { describe, it, expect, vi, beforeEach } from 'vitest'

const sbState = { listItems: [], ownedNames: [], deleted: null }

vi.mock('./supabase', () => {
  // Minimal chainable query builder covering the two queries the helper makes.
  function makeQuery(table) {
    const q = {
      _table: table,
      _filters: {},
      select() { return q },
      eq(col, val) { q._filters[col] = val; return q },
      in(col, vals) { q._filters[col] = vals; return q },
      delete() { q._isDelete = true; return q },
      then(resolve) { return Promise.resolve(q._run()).then(resolve) },
      _run() {
        if (q._table === 'list_items') {
          if (q._isDelete) {
            sbState.deleted = q._filters.id
            return { data: null, error: null }
          }
          const folderIds = q._filters.folder_id || []
          const printIds = q._filters.card_print_id || []
          const data = sbState.listItems.filter(r =>
            folderIds.includes(r.folder_id) && printIds.includes(r.card_print_id))
          return { data, error: null }
        }
        if (q._table === 'owned_cards_view') {
          const names = q._filters.name || []
          const data = sbState.ownedNames
            .filter(n => names.includes(n))
            .map(name => ({ name }))
          return { data, error: null }
        }
        return { data: [], error: null }
      },
    }
    return q
  }
  return { sb: { from: (t) => makeQuery(t) } }
})

vi.mock('./db', () => ({
  getLocalFolders: vi.fn(async () => [
    { id: 'list1', type: 'list' },
    { id: 'binder1', type: 'binder' },
  ]),
  deleteListItemsByIds: vi.fn(async () => {}),
  putListItems: vi.fn(async () => {}),
}))

import { removeAcquiredFromWishlists, findOwnedCardNames } from './wishlistSync'

beforeEach(() => {
  sbState.listItems = []
  sbState.ownedNames = []
  sbState.deleted = null
})

describe('removeAcquiredFromWishlists', () => {
  it('removes only the exact print + foil that was acquired', async () => {
    sbState.listItems = [
      { id: 'i1', folder_id: 'list1', card_print_id: 'p1', foil: false },
      { id: 'i2', folder_id: 'list1', card_print_id: 'p1', foil: true },  // foil want stays
      { id: 'i3', folder_id: 'list1', card_print_id: 'p2', foil: false }, // different print stays
    ]
    const { removedIds } = await removeAcquiredFromWishlists('u1', [{ card_print_id: 'p1', foil: false }])
    expect(removedIds).toEqual(['i1'])
    expect(sbState.deleted).toEqual(['i1'])
  })

  it('returns empty when nothing matches and makes no delete', async () => {
    sbState.listItems = [{ id: 'i1', folder_id: 'list1', card_print_id: 'p9', foil: false }]
    const { removedIds } = await removeAcquiredFromWishlists('u1', [{ card_print_id: 'p1', foil: false }])
    expect(removedIds).toEqual([])
    expect(sbState.deleted).toBeNull()
  })

  it('no-ops on empty acquired input', async () => {
    const res = await removeAcquiredFromWishlists('u1', [])
    expect(res.removedIds).toEqual([])
  })
})

describe('findOwnedCardNames', () => {
  it('returns lowercased owned names limited to candidates', async () => {
    sbState.ownedNames = ['Sol Ring', 'Lightning Bolt']
    const owned = await findOwnedCardNames('u1', ['Sol Ring', 'Counterspell'])
    expect(owned.has('sol ring')).toBe(true)
    expect(owned.has('counterspell')).toBe(false)
  })

  it('no-ops on empty input', async () => {
    const owned = await findOwnedCardNames('u1', [])
    expect(owned.size).toBe(0)
  })
})

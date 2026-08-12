import { describe, it, expect } from 'vitest'
import {
  ownedCardKey,
  totalPendingQty,
  aggregateOwnedRows,
  aggregateListItems,
  planOwnedCardWrites,
  newlyInsertedIds,
  planPlacementLinks,
} from './saveBatch'

const pending = (over = {}) => ({
  id: 'sf-1', name: 'Sol Ring', setCode: 'c21', collNum: '263',
  foil: false, qty: 1, condition: 'NM', language: 'en', ...over,
})

describe('totalPendingQty', () => {
  it('counts copies, not basket entries', () => {
    // 3 entries, 6 copies — the header used to show 3.
    const cards = [pending({ qty: 4 }), pending({ id: 'sf-2', qty: 1 }), pending({ id: 'sf-3' })]
    expect(totalPendingQty(cards)).toBe(6)
  })

  it('treats a missing qty as one copy', () => {
    expect(totalPendingQty([{ name: 'a' }, { name: 'b', qty: 2 }])).toBe(3)
  })

  it('is zero for an empty or absent basket', () => {
    expect(totalPendingQty([])).toBe(0)
    expect(totalPendingQty(null)).toBe(0)
  })
})

describe('ownedCardKey', () => {
  it('keys off card_print_id when present', () => {
    expect(ownedCardKey({ card_print_id: 'p1', foil: false, language: 'en', condition: 'near_mint' }))
      .toBe('print:p1|0|en|near_mint')
  })

  it('separates finish, language and condition', () => {
    const base = { card_print_id: 'p1', foil: false, language: 'en', condition: 'near_mint' }
    const keys = new Set([
      ownedCardKey(base),
      ownedCardKey({ ...base, foil: true }),
      ownedCardKey({ ...base, language: 'de' }),
      ownedCardKey({ ...base, condition: 'lightly_played' }),
    ])
    expect(keys.size).toBe(4)
  })

  it('applies defaults so a sparse row matches a stored one', () => {
    expect(ownedCardKey({ card_print_id: 'p1' })).toBe(ownedCardKey({
      card_print_id: 'p1', foil: false, language: 'en', condition: 'near_mint',
    }))
  })
})

describe('aggregateOwnedRows', () => {
  it('merges repeat scans of the same print+finish+condition', () => {
    const rows = aggregateOwnedRows([pending(), pending(), pending({ qty: 2 })], 'u1')
    expect(rows).toHaveLength(1)
    expect(rows[0].qty).toBe(4)
    expect(rows[0].user_id).toBe('u1')
  })

  it('keeps foil and non-foil copies apart', () => {
    const rows = aggregateOwnedRows([pending(), pending({ foil: true })], 'u1')
    expect(rows).toHaveLength(2)
  })

  it('maps the UI condition code to the stored value', () => {
    const [row] = aggregateOwnedRows([pending({ condition: 'MP' })], 'u1')
    expect(row.condition).toBe('moderately_played')
  })

  it('falls back to near_mint for an unknown condition', () => {
    const [row] = aggregateOwnedRows([pending({ condition: 'ZZ' })], 'u1')
    expect(row.condition).toBe('near_mint')
  })
})

describe('aggregateListItems', () => {
  it('merges by print and finish, ignoring condition', () => {
    const items = aggregateListItems(
      [pending({ condition: 'NM' }), pending({ condition: 'HP' })],
      { folderId: 'f1', userId: 'u1' }
    )
    expect(items).toHaveLength(1)
    expect(items[0].qty).toBe(2)
    expect(items[0].folder_id).toBe('f1')
  })
})

describe('planOwnedCardWrites', () => {
  const owned = [
    { user_id: 'u1', card_print_id: 'p1', foil: false, language: 'en', condition: 'near_mint', qty: 2 },
    { user_id: 'u1', card_print_id: 'p2', foil: false, language: 'en', condition: 'near_mint', qty: 1 },
  ]

  it('adds the scanned copies to an already-owned row', () => {
    const existing = [{ id: 'c1', card_print_id: 'p1', foil: false, language: 'en', condition: 'near_mint', qty: 3 }]
    const { upsertRows } = planOwnedCardWrites({ owned, existing })
    expect(upsertRows.find(r => r.card_print_id === 'p1').qty).toBe(5)
    expect(upsertRows.find(r => r.card_print_id === 'p2').qty).toBe(1)
  })

  it('never emits an id — an upsert carrying one rewrites the wrong row', () => {
    const existing = [{ id: 'c1', card_print_id: 'p1', foil: false, language: 'en', condition: 'near_mint', qty: 3 }]
    const { upsertRows } = planOwnedCardWrites({ owned, existing })
    for (const row of upsertRows) expect('id' in row).toBe(false)
  })

  it('emits one row per input row so the placement pass can match them all', () => {
    const { upsertRows } = planOwnedCardWrites({ owned, existing: [] })
    expect(upsertRows).toHaveLength(2)
  })

  it('does not merge a foil scan into the non-foil row', () => {
    const existing = [{ id: 'c1', card_print_id: 'p1', foil: true, language: 'en', condition: 'near_mint', qty: 3 }]
    const { upsertRows } = planOwnedCardWrites({ owned, existing })
    expect(upsertRows.find(r => r.card_print_id === 'p1').qty).toBe(2)
  })
})

describe('newlyInsertedIds', () => {
  it('reports only the rows that did not exist before', () => {
    const { existingIds } = planOwnedCardWrites({
      owned: [],
      existing: [{ id: 'c1', card_print_id: 'p1' }],
    })
    expect(newlyInsertedIds([{ id: 'c1' }, { id: 'c2' }], existingIds)).toEqual(['c2'])
  })

  it('never proposes pruning a pre-existing row', () => {
    const existingIds = new Set(['c1', 'c2'])
    expect(newlyInsertedIds([{ id: 'c1' }, { id: 'c2' }], existingIds)).toEqual([])
  })
})

describe('planPlacementLinks', () => {
  const owned = [
    { card_print_id: 'p1', foil: false, language: 'en', condition: 'near_mint', qty: 2 },
    { card_print_id: 'p2', foil: false, language: 'en', condition: 'near_mint', qty: 1 },
  ]
  const savedRows = [
    { id: 'c1', card_print_id: 'p1', foil: false, language: 'en', condition: 'near_mint' },
    { id: 'c2', card_print_id: 'p2', foil: false, language: 'en', condition: 'near_mint' },
  ]

  it('adds to the qty the folder already holds', () => {
    const { links, complete } = planPlacementLinks({
      owned, savedRows,
      existingLinkQty: new Map([['c1', 4]]),
      destinationType: 'binder', folderId: 'f1', userId: 'u1',
    })
    expect(complete).toBe(true)
    expect(links).toEqual([
      { card_id: 'c1', qty: 6, folder_id: 'f1' },
      { card_id: 'c2', qty: 1, folder_id: 'f1' },
    ])
  })

  it('writes deck placements to deck_id and carries user_id', () => {
    const { links } = planPlacementLinks({
      owned: [owned[0]], savedRows: [savedRows[0]],
      existingLinkQty: new Map(),
      destinationType: 'deck', folderId: 'd1', userId: 'u1',
    })
    expect(links).toEqual([{ card_id: 'c1', qty: 2, deck_id: 'd1', user_id: 'u1' }])
  })

  it('flags an incomplete plan when a saved row is missing', () => {
    const { links, complete } = planPlacementLinks({
      owned, savedRows: [savedRows[0]],
      existingLinkQty: new Map(),
      destinationType: 'binder', folderId: 'f1', userId: 'u1',
    })
    expect(links).toHaveLength(1)
    expect(complete).toBe(false)
  })
})

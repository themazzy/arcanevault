import { describe, it, expect, vi, beforeEach } from 'vitest'

// In-memory stand-in for deck_allocations_view, large enough to require
// pagination (PostgREST caps an unbounded query at 1000 rows by default).
const sbState = { rows: [] }

function makeQuery() {
  const filters = {}
  let rangeFrom = 0
  let rangeTo = Infinity
  const q = {
    select() { return q },
    eq(col, val) { filters[col] = val; return q },
    order() { return q },
    range(from, to) { rangeFrom = from; rangeTo = to; return q },
    then(resolve, reject) {
      let rows = sbState.rows
      for (const [col, val] of Object.entries(filters)) rows = rows.filter(r => r[col] === val)
      rows = rows.slice().sort((a, b) => a.id - b.id).slice(rangeFrom, rangeTo + 1)
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject)
    },
  }
  return q
}

vi.mock('./supabase', () => ({ sb: { from: () => makeQuery() } }))

import { fetchDeckAllocationsForUser } from './deckData'

const USER = 'user-1'

beforeEach(() => {
  sbState.rows = []
})

describe('fetchDeckAllocationsForUser', () => {
  it('returns all rows even when the user has more than one page (1000) of allocations', async () => {
    // 1500 rows for this user, spanning many decks — plus one row that would
    // land in the second page if pagination were missing.
    for (let i = 0; i < 1500; i++) {
      sbState.rows.push({
        id: i,
        user_id: USER,
        deck_id: `deck-${i % 20}`,
        card_print_id: `print-${i}`,
        scryfall_id: `sf-${i}`,
        name: `Card ${i}`,
        foil: false,
      })
    }
    // The specific allocation a badge check needs to find, deliberately past
    // row 1000 so a missing .range() loop would silently drop it.
    sbState.rows.push({
      id: 1499.5,
      user_id: USER,
      deck_id: 'temmet-zombies',
      card_print_id: 'raise-the-palisade-print',
      scryfall_id: 'raise-the-palisade-sf',
      name: 'Raise the Palisade',
      foil: false,
    })

    const result = await fetchDeckAllocationsForUser(USER)

    expect(result.length).toBe(1501)
    expect(result.some(r => r.name === 'Raise the Palisade')).toBe(true)
  })

  it('only returns rows for the requested user', async () => {
    sbState.rows = [
      { id: 1, user_id: USER, deck_id: 'd1', card_print_id: 'p1', scryfall_id: 's1', name: 'Sol Ring', foil: false },
      { id: 2, user_id: 'other-user', deck_id: 'd2', card_print_id: 'p2', scryfall_id: 's2', name: 'Mana Crypt', foil: false },
    ]
    const result = await fetchDeckAllocationsForUser(USER)
    expect(result).toEqual([sbState.rows[0]])
  })
})

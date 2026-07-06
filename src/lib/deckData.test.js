import { describe, it, expect, vi, beforeEach } from 'vitest'

// In-memory stand-in for deck_allocations_view supporting the .in()-based
// filtering fetchDeckAllocationsForCardIdentities issues per identity tier.
const sbState = { rows: [] }

function makeQuery() {
  const eqFilters = {}
  const inFilters = {}
  const q = {
    select() { return q },
    eq(col, val) { eqFilters[col] = val; return q },
    in(col, vals) { inFilters[col] = vals; return q },
    then(resolve, reject) {
      let rows = sbState.rows
      for (const [col, val] of Object.entries(eqFilters)) rows = rows.filter(r => r[col] === val)
      for (const [col, vals] of Object.entries(inFilters)) rows = rows.filter(r => vals.includes(r[col]))
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject)
    },
  }
  return q
}

vi.mock('./supabase', () => ({ sb: { from: () => makeQuery() } }))

import { fetchDeckAllocationsForCardIdentities } from './deckData'

const USER = 'user-1'

beforeEach(() => {
  sbState.rows = []
})

describe('fetchDeckAllocationsForCardIdentities', () => {
  it('matches an allocation via card_print_id', async () => {
    sbState.rows = [
      { deck_id: 'temmet-zombies', card_print_id: 'ltc-23', scryfall_id: 'sf-1', name: 'Raise the Palisade', foil: false, user_id: USER },
    ]
    const result = await fetchDeckAllocationsForCardIdentities(USER, { cardPrintIds: ['ltc-23'] })
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Raise the Palisade')
  })

  it('matches a different printing of the same card via the name fallback tier', async () => {
    // Deck's card is print A; the owned+allocated copy is print B of the same
    // name — no card_print_id/scryfall_id overlap, only name matches.
    sbState.rows = [
      { deck_id: 'other-deck', card_print_id: 'print-B', scryfall_id: 'sf-B', name: 'Sol Ring', foil: false, user_id: USER },
    ]
    const result = await fetchDeckAllocationsForCardIdentities(USER, {
      cardPrintIds: ['print-A'],
      scryfallIds: ['sf-A'],
      names: ['Sol Ring'],
    })
    expect(result).toHaveLength(1)
    expect(result[0].card_print_id).toBe('print-B')
  })

  it('deduplicates a row that matches on more than one tier', async () => {
    sbState.rows = [
      { deck_id: 'other-deck', card_print_id: 'print-A', scryfall_id: 'sf-A', name: 'Sol Ring', foil: false, user_id: USER },
    ]
    const result = await fetchDeckAllocationsForCardIdentities(USER, {
      cardPrintIds: ['print-A'],
      scryfallIds: ['sf-A'],
      names: ['Sol Ring'],
    })
    expect(result).toHaveLength(1)
  })

  it('only matches rows for the requested user', async () => {
    sbState.rows = [
      { deck_id: 'd1', card_print_id: 'print-A', scryfall_id: 'sf-A', name: 'Sol Ring', foil: false, user_id: USER },
      { deck_id: 'd2', card_print_id: 'print-A', scryfall_id: 'sf-A', name: 'Sol Ring', foil: false, user_id: 'other-user' },
    ]
    const result = await fetchDeckAllocationsForCardIdentities(USER, { cardPrintIds: ['print-A'] })
    expect(result).toEqual([sbState.rows[0]])
  })

  it('returns an empty array and issues no query when given no identities', async () => {
    sbState.rows = [
      { deck_id: 'd1', card_print_id: 'print-A', scryfall_id: 'sf-A', name: 'Sol Ring', foil: false, user_id: USER },
    ]
    const result = await fetchDeckAllocationsForCardIdentities(USER, {})
    expect(result).toEqual([])
  })
})

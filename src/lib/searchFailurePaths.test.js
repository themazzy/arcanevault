// Failure paths for deck-builder card search.
//
// These are not hypothetical. `search_deck_builder_cards` was measured on
// 2026-08-16 returning "canceling statement due to statement timeout" on 3 of
// 7 consecutive anon calls for the term "bolt" (4.2 s cold, 3.1 s worst warm,
// against a 3 s anon / 8 s authenticated ceiling). The RPC does a Seq Scan
// over all ~44k rows of the 94 MB oracle_cards heap because its three-way OR
// — name ILIKE / name % / EXISTS(unnest(face_names)) — cannot use the trigram
// indexes that exist for it. See scripts/dbPerf.harness.js.
//
// So "the search RPC errors" is a live production state, not an edge case,
// and what the app does in that state is worth pinning down. The distinction
// that matters to a user is between "no cards match your search" and "the
// search broke" — those must not render the same way, or a timeout looks like
// a card that does not exist.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const rpc = vi.fn()
vi.mock('./supabase', () => ({ sb: { rpc: (...a) => rpc(...a) } }))
vi.mock('./scryfall', () => ({
  getInstantCache: () => ({}),
  sfGet: vi.fn(),
  SCRYFALL_CACHE_TTL_MS: 0,
}))

const { searchCards } = await import('./deckBuilderApi')

const TIMEOUT = {
  message: 'canceling statement due to statement timeout',
  code: '57014',
}

describe('searchCards failure paths', () => {
  beforeEach(() => { rpc.mockReset() })

  it('reports a statement timeout as an error, not as zero results', async () => {
    rpc.mockResolvedValue({ data: null, error: TIMEOUT })

    const res = await searchCards({ query: 'bolt' })

    // Both facts matter. Empty cards alone would be indistinguishable from a
    // genuine no-match, which is exactly the confusion to avoid.
    expect(res.cards).toEqual([])
    expect(res.error).toBe(true)
  })

  it('does not flag an error when the catalogue genuinely has no match', async () => {
    rpc.mockResolvedValue({ data: [], error: null })

    const res = await searchCards({ query: 'zzzznotacard' })

    expect(res.cards).toEqual([])
    // The absence of the flag is the whole signal the UI keys off.
    expect(res.error).toBeUndefined()
    expect(res.hasMore).toBe(false)
  })

  it('short-circuits below the 2-character floor without calling the RPC', async () => {
    // The RPC itself returns nothing under 2 chars, but letting the call
    // through would still pay full network + planning cost on every
    // keystroke of a user typing the first letter of a name.
    const res = await searchCards({ query: 'b' })

    expect(rpc).not.toHaveBeenCalled()
    expect(res.cards).toEqual([])
  })

  it('still returns cards when only the price/image enrichment fails', async () => {
    // Enrichment is a second RPC (get_deck_builder_display_printings, itself
    // measured at 1.35 s cold). It is best-effort by design — losing prices
    // must not lose the search results themselves.
    rpc.mockImplementation((fn) => {
      if (fn === 'search_deck_builder_cards') {
        return Promise.resolve({
          data: [{ oracle_id: 'x', name: 'Lightning Bolt', type_line: 'Instant' }],
          error: null,
        })
      }
      return Promise.resolve({ data: null, error: TIMEOUT })
    })

    const res = await searchCards({ query: 'bolt' })

    expect(res.error).toBeUndefined()
    expect(res.cards.map(c => c.name)).toEqual(['Lightning Bolt'])
  })
})

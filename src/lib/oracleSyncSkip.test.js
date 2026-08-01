import { describe, it, expect } from 'vitest'
import { needsWrite } from '../../scripts/sync-oracle-cards.mjs'

// Guards the change-detection that keeps oracle_cards from bloating. The weekly
// sync used to blind-upsert all ~38k rows, which produced 38k dead tuples a run
// and left the table 52.9% empty space (103MB allocated for 48MB of live rows).
describe('needsWrite', () => {
  const row = { oracle_id: 'a', source_updated_at: '2026-08-01T00:00:00Z' }

  it('skips a row Scryfall has not touched', () => {
    const existing = new Map([['a', '2026-08-01T00:00:00Z']])
    expect(needsWrite(row, existing)).toBe(false)
  })

  it('writes when Scryfall bumped the timestamp', () => {
    const existing = new Map([['a', '2026-07-01T00:00:00Z']])
    expect(needsWrite(row, existing)).toBe(true)
  })

  it('writes a row we have never stored', () => {
    expect(needsWrite(row, new Map())).toBe(true)
  })

  it('writes when either side has no timestamp to compare', () => {
    // Cannot prove it is unchanged, so never assume it is.
    expect(needsWrite(row, new Map([['a', null]]))).toBe(true)
    expect(needsWrite({ oracle_id: 'a', source_updated_at: null }, new Map([['a', '2026-08-01T00:00:00Z']]))).toBe(true)
  })

  it('writes everything under --force', () => {
    const existing = new Map([['a', '2026-08-01T00:00:00Z']])
    // The escape hatch for when oracleCardRow's own shape changes — the
    // timestamp only tells us about Scryfall's data, not our storage format.
    expect(needsWrite(row, existing, true)).toBe(true)
  })
})

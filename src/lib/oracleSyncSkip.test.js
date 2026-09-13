import { describe, it, expect } from 'vitest'
import { contentHash, needsWrite, oracleCardRow } from '../../scripts/sync-oracle-cards.mjs'

// Guards the change-detection that keeps oracle_cards from bloating. The weekly
// sync blind-upserts all ~38k rows when this fails, producing 38k dead tuples a
// run and leaving the table ~50% empty space on a 500MB database.
//
// It HAS failed, silently, for the entire life of the table. The original
// version compared Scryfall's per-card `updated_at` — a field the oracle bulk
// export does not have. Every row therefore carried a null timestamp, the
// null-guard treated that as "cannot prove unchanged", and nothing was ever
// skipped. Two runs 20 minutes apart on 2026-09-13, with nothing changed
// upstream, both reported "skipped 0 unchanged".
//
// The lesson those tests missed: they only ever fed `needsWrite` rows that
// already had a timestamp, so they proved the comparison worked and never that
// the field was populated. The digest tests below start from a real Scryfall
// card shape for that reason.

describe('needsWrite', () => {
  const row = { oracle_id: 'a', content_hash: 'hash-1' }

  it('skips a row whose digest is unchanged', () => {
    expect(needsWrite(row, new Map([['a', 'hash-1']]))).toBe(false)
  })

  it('writes when the digest differs', () => {
    expect(needsWrite(row, new Map([['a', 'hash-0']]))).toBe(true)
  })

  it('writes a row we have never stored', () => {
    expect(needsWrite(row, new Map())).toBe(true)
  })

  it('writes a row stored before the digest column existed', () => {
    // Populates the hash on the first run after the migration.
    expect(needsWrite(row, new Map([['a', null]]))).toBe(true)
  })

  it('writes everything under --force', () => {
    expect(needsWrite(row, new Map([['a', 'hash-1']]), true)).toBe(true)
  })
})

describe('contentHash', () => {
  // Shaped like a real Scryfall oracle bulk record — notably WITHOUT an
  // `updated_at`, which is the whole reason the digest exists.
  const card = {
    oracle_id: 'aaaa-bbbb',
    id: 'print-1',
    name: 'Sol Ring',
    set: 'lea',
    collector_number: '270',
    type_line: 'Artifact',
    mana_cost: '{1}',
    cmc: 1,
    colors: [],
    color_identity: [],
    keywords: [],
    legalities: { commander: 'legal' },
    oracle_text: '{T}: Add {C}{C}.',
    rarity: 'uncommon',
  }

  it('is stable across runs for an unchanged card', () => {
    // The two runs that exposed the bug were 20 minutes apart. Only synced_at
    // differed between them, and that must not count as a change.
    const first = oracleCardRow(card)
    const second = { ...oracleCardRow(card), synced_at: '2999-01-01T00:00:00Z' }
    expect(contentHash(first)).toBe(contentHash(second))
  })

  it('ignores a previously stored digest on the row', () => {
    const base = oracleCardRow(card)
    expect(contentHash({ ...base, content_hash: 'stale' })).toBe(contentHash(base))
  })

  it('changes when the card actually changes', () => {
    const before = oracleCardRow(card)
    const after = oracleCardRow({ ...card, oracle_text: '{T}: Add {C}{C}{C}.' })
    expect(contentHash(after)).not.toBe(contentHash(before))
  })

  it('changes when a legality changes, which is what the table exists for', () => {
    const before = oracleCardRow(card)
    const after = oracleCardRow({ ...card, legalities: { commander: 'banned' } })
    expect(contentHash(after)).not.toBe(contentHash(before))
  })

  it('produces a digest for a card with no updated_at, unlike the field it replaced', () => {
    const built = oracleCardRow(card)
    expect(built.source_updated_at).toBe(null)   // the old change key, always null
    expect(contentHash(built)).toMatch(/^[0-9a-f]{40}$/)
  })
})

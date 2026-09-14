import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildWatchlist, watchKey } from './backgroundAlerts'

// The background runner executes in its own JS context with no DOM, no IndexedDB
// and no access to app code. Everything it knows is mirrored into a key-value
// store by this module, so the two sides agreeing on the key format is
// load-bearing — and cannot be enforced by an import.

describe('watchKey', () => {
  it('truncates to 64 bits and tags the finish', () => {
    expect(watchKey('5dd7dd1a-6dd1-43c3-8298-7db703d384a1', 'normal')).toBe('5dd7dd1a-6dd1-43n')
    expect(watchKey('5dd7dd1a-6dd1-43c3-8298-7db703d384a1', 'foil')).toBe('5dd7dd1a-6dd1-43f')
  })

  it('separates the two finishes of one printing', () => {
    const id = '5dd7dd1a-6dd1-43c3-8298-7db703d384a1'
    expect(watchKey(id, 'foil')).not.toBe(watchKey(id, 'normal'))
  })

  it('is implemented identically in the runner, which cannot import it', () => {
    // A silent divergence here would mean the watchlist never matches and the
    // background check reports nothing, forever, with no error anywhere.
    const runner = readFileSync(resolve(process.cwd(), 'public/runners/price-alerts.js'), 'utf8')
    const body = runner.match(/function watchKey\([^)]*\)\s*\{([\s\S]*?)\n\}/)[1]
    expect(body).toContain("slice(0, 16)")
    expect(body).toContain("=== 'foil' ? 'f' : 'n'")
  })
})

describe('buildWatchlist', () => {
  const cards = [
    { scryfall_id: 'aaaaaaaaaaaaaaaaaaa', foil: false, price: 5 },
    { scryfall_id: 'bbbbbbbbbbbbbbbbbbb', foil: false, price: 0.1 },
    { scryfall_id: 'ccccccccccccccccccc', foil: true, price: 2 },
  ]
  const priceOf = c => c.price

  it('keeps only printings that could plausibly clear the money threshold', () => {
    // A 0.10 card cannot move by 1 without going up tenfold; carrying it would
    // be 70% of this collection for nothing.
    const list = buildWatchlist(cards, 1, priceOf)
    expect(list).toHaveLength(2)
    expect(list).toContain(watchKey('aaaaaaaaaaaaaaaaaaa', 'normal'))
    expect(list).not.toContain(watchKey('bbbbbbbbbbbbbbbbbbb', 'normal'))
  })

  it('uses half the threshold as the floor, for headroom', () => {
    // A 0.60 card reaching 1.70 is a real +1.10 move, so the floor is
    // deliberately below the threshold rather than equal to it.
    const list = buildWatchlist([{ scryfall_id: 'ddddddddddddddddddd', foil: false, price: 0.6 }], 1, priceOf)
    expect(list).toHaveLength(1)
  })

  it('tracks the foil and non-foil of one printing separately', () => {
    const both = [
      { scryfall_id: 'eeeeeeeeeeeeeeeeeee', foil: false, price: 5 },
      { scryfall_id: 'eeeeeeeeeeeeeeeeeee', foil: true, price: 9 },
    ]
    expect(buildWatchlist(both, 1, priceOf)).toHaveLength(2)
  })

  it('deduplicates copies of the same printing held in several folders', () => {
    const dupes = [
      { scryfall_id: 'fffffffffffffffffff', foil: false, price: 5 },
      { scryfall_id: 'fffffffffffffffffff', foil: false, price: 5 },
    ]
    expect(buildWatchlist(dupes, 1, priceOf)).toHaveLength(1)
  })

  it('skips rows with no printing id, and survives no input', () => {
    expect(buildWatchlist([{ foil: false, price: 10 }], 1, priceOf)).toEqual([])
    expect(buildWatchlist(null, 1, priceOf)).toEqual([])
  })

  it('falls back to the default threshold when none is given', () => {
    expect(buildWatchlist(cards, undefined, priceOf).length).toBeGreaterThan(0)
  })
})

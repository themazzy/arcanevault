import { describe, it, expect } from 'vitest'
import { encodeHashPack, HashPackStore } from './hashPack.js'
import { createMatcher } from './matchCore.js'
import { hexToHash, hammingDistance } from './hashCore.js'
import { makeCards } from './hashPack.test.js'

// 3000 cards puts the store above the band-index threshold (2000), so these
// tests exercise the LSH candidate path, not just the full scan.
const CARDS = makeCards(3000, { seed: 7, sets: ['aaa', 'bbb', 'ccc', 'ddd'] })

function buildMatcher(cards = CARDS, chunkSize = 1300) {
  const store = new HashPackStore()
  for (let i = 0; i < cards.length; i += chunkSize) {
    store.appendChunkBuffer(encodeHashPack(cards.slice(i, i + chunkSize), 6))
  }
  return { store, matcher: createMatcher(store) }
}

function flipBits(hash, count, seed = 1) {
  const out = new Uint32Array(hash)
  for (let i = 0; i < count; i++) {
    const bit = (seed * 2654435761 + i * 40503) % 256
    out[bit >>> 5] ^= 1 << (bit & 31)
  }
  return out
}

/** Naive reference ranking straight from the source rows. */
function naiveBest(cards, query, colorQuery = null, allowedSets = null) {
  let best = null, bestDist = Infinity, second = null, secondDist = Infinity
  for (const card of cards) {
    if (allowedSets && !allowedSets.has(card.set_code)) continue
    const luma = hammingDistance(query, hexToHash(card.phash_hex))
    const d = colorQuery
      ? Math.round(0.65 * luma + 0.35 * hammingDistance(colorQuery, hexToHash(card.phash_hex2)))
      : luma
    if (d < bestDist) {
      second = best; secondDist = bestDist
      best = card; bestDist = d
    } else if (d < secondDist) {
      second = card; secondDist = d
    }
  }
  return { best, bestDist, second, secondDist }
}

describe('createMatcher', () => {
  it('finds the exact card for an unmodified stored hash', () => {
    const { matcher } = buildMatcher()
    const query = hexToHash(CARDS[1234].phash_hex)
    const result = matcher.match(query)
    expect(result.best.id).toBe(CARDS[1234].scryfall_id)
    expect(result.best.distance).toBe(0)
    expect(result.totalCount).toBe(3000)
  })

  it('finds the right card through the band index despite flipped bits', () => {
    const { matcher } = buildMatcher()
    for (const idx of [3, 500, 1500, 2999]) {
      const query = flipBits(hexToHash(CARDS[idx].phash_hex), 12, idx)
      const result = matcher.match(query)
      expect(result.best.id).toBe(CARDS[idx].scryfall_id)
      expect(result.best.distance).toBe(12)
    }
  })

  it('matches the naive reference when combining color distance', () => {
    const { matcher } = buildMatcher()
    const query = flipBits(hexToHash(CARDS[42].phash_hex), 8, 42)
    const colorQuery = flipBits(hexToHash(CARDS[42].phash_hex2), 6, 43)
    const result = matcher.match(query, colorQuery, null, { broadFallbackOnWeak: true })
    const ref = naiveBest(CARDS, query, colorQuery)
    expect(result.best.id).toBe(ref.best.scryfall_id)
    expect(result.best.distance).toBe(ref.bestDist)
  })

  it('recovers via the full-card hash when the art hash is destroyed (glare)', () => {
    const { matcher } = buildMatcher()
    // Art hash ~random (120 flipped bits), full-card hash nearly intact.
    const artQuery = flipBits(hexToHash(CARDS[321].phash_hex), 120, 999)
    const fullQuery = flipBits(hexToHash(CARDS[321].phash_full_hex), 6, 321)
    const withoutFull = matcher.match(artQuery, null, null, {})
    const withFull = matcher.match(artQuery, null, fullQuery, {})
    // The full-hash band index must surface the true card even though the
    // art bands can't, and the combined distance must rank it first.
    expect(withFull.best.id).toBe(CARDS[321].scryfall_id)
    expect(withFull.best.distance).toBeLessThan(withoutFull.best.distance)
  })

  it('respects locked sets and reports the locked-set source', () => {
    const { matcher } = buildMatcher()
    const target = CARDS[100] // set 'aaa'
    const query = flipBits(hexToHash(target.phash_hex), 10, 100)
    const otherSets = new Set(['bbb', 'ccc'])
    // weakDistance 0 forces the broad re-rank of the full allowed pool, making
    // the result exactly comparable to the naive full scan.
    const result = matcher.match(query, null, null, {
      allowedSets: otherSets,
      broadFallbackOnWeak: true,
      weakDistance: 0,
    })
    const ref = naiveBest(CARDS, query, null, otherSets)
    expect(result.best.id).toBe(ref.best.scryfall_id)
    expect(result.best.setCode).not.toBe('aaa')
    expect(result.fallback).toMatch(/locked-set/)
  })

  it('falls back to all sets when the locked-set result is weak', () => {
    const { matcher } = buildMatcher()
    const target = CARDS[100] // set 'aaa'
    const query = flipBits(hexToHash(target.phash_hex), 10, 100)
    const result = matcher.match(query, null, null, {
      allowedSets: new Set(['bbb', 'ccc']),
      allowSetFallback: true,
      broadFallbackOnWeak: true,
      weakDistance: 40, // random-hash distances (~128) are far above this
      weakGap: 8,
    })
    expect(result.best.id).toBe(target.scryfall_id)
    expect(result.fallback).toMatch(/all-sets-fallback/)
  })

  it('matchAll returns the best variant with its label', () => {
    const { matcher } = buildMatcher()
    const good = flipBits(hexToHash(CARDS[777].phash_hex), 6, 777)
    const noise = flipBits(hexToHash(CARDS[777].phash_hex), 120, 999)
    const result = matcher.matchAll([
      { hash: noise, label: 'standard' },
      { hash: good, label: 'foil' },
      { hash: null, label: 'dark' },
    ])
    expect(result.best.id).toBe(CARDS[777].scryfall_id)
    expect(result.bestLabel).toBe('foil')
  })

  it('handles an empty store', () => {
    const { matcher } = buildMatcher([])
    expect(matcher.match(new Uint32Array(8))).toEqual(
      { best: null, second: null, candidateCount: 0, totalCount: 0 },
    )
  })

  it('measures diffGap against the first different-name candidate', () => {
    // Two same-art reprints of one card: hashes 2 bits apart. The raw runner-
    // up gap collapses to ~2, but diffGap must reach past the reprint to the
    // nearest OTHER card (~random distance) — this is what lets the scanner
    // exit early on reprinted cards instead of burning the full ladder.
    const cards = makeCards(2400, { seed: 11, sets: ['aaa', 'bbb'] })
    const reprintA = { ...cards[100], name: 'Reprint Bolt' }
    const reprintB = {
      ...cards[101],
      name: 'Reprint Bolt',
      phash_hex: cards[100].phash_hex,      // same art → near-identical hashes
      phash_hex2: cards[100].phash_hex2,
      phash_full_hex: cards[100].phash_full_hex,
    }
    const all = [...cards]
    all[100] = reprintA
    all[101] = reprintB
    const { matcher } = buildMatcher(all)

    const query = flipBits(hexToHash(reprintA.phash_hex), 10, 5)
    const result = matcher.match(query)
    expect(result.best.name).toBe('Reprint Bolt')
    expect(result.second.name).toBe('Reprint Bolt')                       // raw #2 = the reprint
    expect(result.second.distance - result.best.distance).toBeLessThan(4) // raw gap collapsed
    expect(result.diffGap).toBeGreaterThan(40)                            // confidence gap intact
  })

  it('matchAll stops after a non-weak query instead of ranking fallbacks', () => {
    const { matcher } = buildMatcher()
    const strong = flipBits(hexToHash(CARDS[777].phash_hex), 6, 777)
    const alsoStrong = flipBits(hexToHash(CARDS[888].phash_hex), 6, 888)
    const result = matcher.matchAll([
      { hash: strong, label: 'standard' },
      { hash: alsoStrong, label: 'foil' },   // would win on distance ties — must not run
    ])
    expect(result.best.id).toBe(CARDS[777].scryfall_id)
    expect(result.bestLabel).toBe('standard')
  })

  it('stays correct after appending a chunk post-index-build', () => {
    const store = new HashPackStore()
    store.appendChunkBuffer(encodeHashPack(CARDS.slice(0, 2500), 6))
    const matcher = createMatcher(store)
    // Build the index, then append more cards.
    matcher.match(hexToHash(CARDS[0].phash_hex))
    store.appendChunkBuffer(encodeHashPack(CARDS.slice(2500), 6))
    matcher.invalidate()
    const query = flipBits(hexToHash(CARDS[2900].phash_hex), 10, 2900)
    expect(matcher.match(query).best.id).toBe(CARDS[2900].scryfall_id)
  })
})

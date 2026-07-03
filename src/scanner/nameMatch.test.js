import { describe, it, expect } from 'vitest'
import { normalizeTitle, buildNameIndex, prefixEditDistance, matchTitle, maxEditsFor } from './nameMatch.js'

describe('normalizeTitle', () => {
  it('lowercases, folds ligatures/diacritics, strips punctuation', () => {
    expect(normalizeTitle('Æther Vial')).toBe('aether vial')
    expect(normalizeTitle("Lim-Dûl's Vault")).toBe('lim dul s vault')
    expect(normalizeTitle('  Fury // Failure  ')).toBe('fury failure')
    expect(normalizeTitle('Borrowing 100,000 Arrows')).toBe('borrowing 100 000 arrows')
  })
})

describe('prefixEditDistance', () => {
  it('is 0 for a name that prefixes the text (trailing junk is free)', () => {
    expect(prefixEditDistance('lightning bolt', 'lightning bolt 2 r 0123')).toBe(0)
    expect(prefixEditDistance('lightning bolt', 'lightning bolt')).toBe(0)
  })

  it('counts edits inside the name', () => {
    expect(prefixEditDistance('lightning bolt', 'lighming bolt xx')).toBe(2)  // t→m, drop n
    expect(prefixEditDistance('shock', 'shpck')).toBe(1)
  })

  it('returns Infinity beyond the cutoff', () => {
    expect(prefixEditDistance('lightning bolt', 'zzzzzzzz')).toBe(Infinity)
    expect(prefixEditDistance('abcdefgh', 'a')).toBe(Infinity)
  })
})

describe('matchTitle', () => {
  const index = buildNameIndex([
    { name: 'Lightning Bolt', idx: 0 },
    { name: 'Lightning Bolt', idx: 7 },     // older printing
    { name: 'Lightning Strike', idx: 1 },
    { name: 'Fire // Ice', idx: 2 },
    { name: 'Firebolt', idx: 3 },
    { name: 'Giant Growth', idx: 4 },
    { name: 'Shock', idx: 5 },
    { name: 'Mind Rot', idx: 6 },
  ])

  it('collects printings per name, newest first, and indexes DFC fronts', () => {
    expect(matchTitle('Lightning Bolt', index).idxs).toEqual([0, 7])
    expect(matchTitle('fire', index).name).toBe('Fire // Ice')
  })

  it('matches corrupted OCR text within the edit budget', () => {
    const hit = matchTitle('Lighming Bolt', index)
    expect(hit?.name).toBe('Lightning Bolt')
    expect(hit.distance).toBeGreaterThan(0)
  })

  it('ignores trailing junk after the name', () => {
    expect(matchTitle('Giant Growth 4 G 0188', index)?.name).toBe('Giant Growth')
  })

  it('prefers the longer full-word match over an embedded prefix name', () => {
    expect(matchTitle('firebolt', index)?.name).toBe('Firebolt')
  })

  it('rejects ambiguous reads (runner-up within the margin)', () => {
    // "lightning bol" sits close to both Bolt and Strike-adjacent forms? It
    // still resolves to Bolt (distance 1) because Strike is ≥2 edits worse —
    // but a read equidistant to two names must return null.
    const ambiguous = buildNameIndex([
      { name: 'Mind Rot', idx: 0 },
      { name: 'Mind Rat', idx: 1 },
    ])
    expect(matchTitle('mind rt', ambiguous)).toBe(null)
  })

  it('rejects short names with too many edits', () => {
    expect(maxEditsFor('shock'.length)).toBe(1)
    expect(matchTitle('shpvk', index)).toBe(null)   // 2 edits on a 5-char name
  })

  it('rejects too-short or empty text', () => {
    expect(matchTitle('ab', index)).toBe(null)
    expect(matchTitle('', index)).toBe(null)
  })
})

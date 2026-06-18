import { describe, it, expect } from 'vitest'
import {
  ADJECTIVES,
  NOUNS,
  generateNickname,
  generateAvailableNickname,
} from './nicknameGenerator'

// Deterministic RNG: replays a fixed sequence of [0,1) values, cycling.
function seqRng(values) {
  let i = 0
  return () => values[i++ % values.length]
}
// Mid-bucket value that floors to `idx` for an array/range of `len`.
const v = (idx, len) => (idx + 0.5) / len
// Build the 4 rng draws generateNickname consumes for a specific result.
const draws = (adjIdx, nounIdx, d1, d2) => [
  v(adjIdx, ADJECTIVES.length),
  v(nounIdx, NOUNS.length),
  v(d1, 10),
  v(d2, 10),
]

describe('generateNickname', () => {
  it('builds <Adjective><Noun><two digits> deterministically', () => {
    const rng = seqRng(draws(0, 0, 0, 0))
    expect(generateNickname(rng)).toBe(`${ADJECTIVES[0]}${NOUNS[0]}00`)
  })

  it('uses the selected words and digits', () => {
    const rng = seqRng(draws(3, 5, 4, 7))
    expect(generateNickname(rng)).toBe(`${ADJECTIVES[3]}${NOUNS[5]}47`)
  })

  it('always ends in two digits and fits the 24-char nickname cap', () => {
    for (let i = 0; i < 500; i++) {
      const name = generateNickname()
      expect(name).toMatch(/^[A-Za-z]+\d{2}$/)
      expect(name.length).toBeLessThanOrEqual(24)
      // alpha part is exactly one adjective followed by one noun
      const alpha = name.slice(0, -2)
      const adj = ADJECTIVES.find(a => alpha.startsWith(a))
      expect(adj).toBeTruthy()
      expect(NOUNS).toContain(alpha.slice(adj.length))
    }
  })

  it('keeps word lists URL-safe (letters only, within length budget)', () => {
    for (const w of [...ADJECTIVES, ...NOUNS]) {
      expect(w).toMatch(/^[A-Z][a-z]+$/)
      expect(w.length).toBeLessThanOrEqual(10)
    }
  })
})

describe('generateAvailableNickname', () => {
  it('returns the first candidate the predicate accepts', async () => {
    const rng = seqRng([...draws(0, 0, 0, 0), ...draws(1, 1, 1, 2)])
    const taken = `${ADJECTIVES[0]}${NOUNS[0]}00`
    const result = await generateAvailableNickname(name => name !== taken, { rng })
    expect(result).toBe(`${ADJECTIVES[1]}${NOUNS[1]}12`)
  })

  it('falls back to extra entropy when every attempt is taken', async () => {
    const result = await generateAvailableNickname(() => false, { attempts: 5 })
    // base name ends in 2 digits + 2 fallback digits = 4 trailing digits
    expect(result).toMatch(/\d{4}$/)
    expect(result.length).toBeLessThanOrEqual(24)
  })

  it('uses a candidate as-is when availability cannot be verified (offline)', async () => {
    const result = await generateAvailableNickname(() => { throw new Error('offline') })
    expect(result).toMatch(/^[A-Za-z]+\d{2}$/)
  })

  it('returns a candidate when no predicate is supplied', async () => {
    const result = await generateAvailableNickname()
    expect(result).toMatch(/^[A-Za-z]+\d{2}$/)
  })
})

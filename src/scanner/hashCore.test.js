import { describe, it, expect } from 'vitest'
import { hexToHash, hashToHex, hammingDistance } from './hashCore'

const ALL_ONES_HEX = 'f'.repeat(64)
const ALL_ZEROS_HEX = '0'.repeat(64)

describe('hexToHash — input validation', () => {
  it('rejects null / undefined / empty', () => {
    expect(hexToHash(null)).toBeNull()
    expect(hexToHash(undefined)).toBeNull()
    expect(hexToHash('')).toBeNull()
  })

  it('rejects wrong-length input', () => {
    expect(hexToHash('abc')).toBeNull()
    expect(hexToHash('a'.repeat(63))).toBeNull()
    expect(hexToHash('a'.repeat(65))).toBeNull()
    expect(hexToHash('a'.repeat(128))).toBeNull()
  })

  it('rejects 64-char strings containing non-hex characters (the bug this guard fixes)', () => {
    // Previously parseInt of a non-hex slice silently became NaN, then NaN >>> 0 = 0,
    // corrupting the hash without any error.
    expect(hexToHash('z'.repeat(64))).toBeNull()
    expect(hexToHash('a'.repeat(63) + 'g')).toBeNull()
    expect(hexToHash('a'.repeat(32) + ' '.repeat(32))).toBeNull()
    expect(hexToHash(ALL_ZEROS_HEX.slice(0, 63) + '!')).toBeNull()
  })

  it('accepts both lowercase and uppercase hex', () => {
    expect(hexToHash('abcdef0123456789'.repeat(4))).not.toBeNull()
    expect(hexToHash('ABCDEF0123456789'.repeat(4))).not.toBeNull()
  })

  it('round-trips through hashToHex', () => {
    const hex = 'abcdef0123456789'.repeat(4)
    const back = hashToHex(hexToHash(hex))
    expect(back).toBe(hex)
  })
})

describe('hammingDistance', () => {
  it('returns 0 for identical hashes', () => {
    const h = hexToHash(ALL_ONES_HEX)
    expect(hammingDistance(h, h)).toBe(0)
  })

  it('returns 256 (all bits flipped) for inverse hashes', () => {
    const a = hexToHash(ALL_ZEROS_HEX)
    const b = hexToHash(ALL_ONES_HEX)
    expect(hammingDistance(a, b)).toBe(256)
  })

  it('counts a single flipped bit as 1', () => {
    const a = hexToHash(ALL_ZEROS_HEX)
    const b = hexToHash('0'.repeat(63) + '1')
    expect(hammingDistance(a, b)).toBe(1)
  })
})

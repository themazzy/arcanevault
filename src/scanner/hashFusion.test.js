import { describe, it, expect } from 'vitest'
import { fuseWordArrays, fuseFrameHashes } from './hashFusion.js'

describe('fuseWordArrays', () => {
  it('takes the per-bit majority across frames', () => {
    // bit 0: set in 2/3 → set; bit 1: set in 1/3 → clear; bit 2: 3/3 → set
    const fused = fuseWordArrays([[0b101], [0b111], [0b100]])
    expect(fused).toEqual([0b101])
  })

  it('breaks even-count ties with the first frame', () => {
    expect(fuseWordArrays([[0b1], [0b0]])).toEqual([0b1])
    expect(fuseWordArrays([[0b0], [0b1]])).toEqual([0b0])
  })

  it('recovers a clean hash from frames with disjoint corruption', () => {
    const truth = [0xDEADBEEF, 0x12345678, 0xCAFEBABE]
    const corrupt = (words, bit) => {
      const out = [...words]
      out[bit >> 5] = (out[bit >> 5] ^ (1 << (bit & 31))) >>> 0
      return out
    }
    // Each frame has a different single-bit error — majority removes all three.
    const fused = fuseWordArrays([corrupt(truth, 3), corrupt(truth, 40), corrupt(truth, 70)])
    expect(fused).toEqual(truth)
  })

  it('handles unsigned 32-bit values without sign corruption', () => {
    const fused = fuseWordArrays([[0xFFFFFFFF], [0xFFFFFFFF], [0]])
    expect(fused).toEqual([0xFFFFFFFF])
  })
})

describe('fuseFrameHashes', () => {
  const frame = (hash, extras = {}) => ({
    hash, colorHash: null, fullHash: null, tileHashes: null, ...extras,
  })

  it('returns null for fewer than 2 frames', () => {
    expect(fuseFrameHashes([frame([1, 2])])).toBe(null)
  })

  it('fuses only the signals every frame carries at the same length', () => {
    const fused = fuseFrameHashes([
      frame([0b11], { colorHash: [0b1], tileHashes: [1, 2, 3] }),
      frame([0b11], { colorHash: [0b1] }),                        // no tiles
      frame([0b11], { colorHash: [0b1], tileHashes: [1, 2, 3] }),
    ])
    expect(fused.hash).toEqual([0b11])
    expect(fused.colorHash).toEqual([0b1])
    expect(fused.tileHashes).toBe(null)   // one frame missing → signal dropped
    expect(fused.fullHash).toBe(null)
  })

  it('requires the art hash', () => {
    expect(fuseFrameHashes([frame(null), frame([1])])).toBe(null)
  })
})

import { describe, it, expect } from 'vitest'
import { ART_W, ART_H } from './constants.js'
import { computeTileHashes, flattenTileHashes, tileEdges } from './tileHash.js'
import { hammingDistance } from './hashCore.js'

function makeArt(fill = (x, y) => (x * 7 + y * 13) % 256) {
  const data = new Uint8ClampedArray(ART_W * ART_H * 4)
  for (let y = 0; y < ART_H; y++) {
    for (let x = 0; x < ART_W; x++) {
      const v = fill(x, y)
      const p = (y * ART_W + x) * 4
      data[p] = v; data[p + 1] = (v * 3) % 256; data[p + 2] = (v * 5) % 256; data[p + 3] = 255
    }
  }
  return { data, width: ART_W, height: ART_H }
}

describe('tileEdges', () => {
  it('covers the full span with contiguous near-equal tiles', () => {
    for (const grid of [2, 3, 4]) {
      const edges = tileEdges(ART_W, grid)
      expect(edges[0]).toBe(0)
      expect(edges[grid]).toBe(ART_W)
      for (let i = 0; i < grid; i++) {
        const w = edges[i + 1] - edges[i]
        expect(Math.abs(w - ART_W / grid)).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('computeTileHashes', () => {
  it('is deterministic and returns G² 256-bit hashes', () => {
    const art = makeArt()
    for (const grid of [2, 3, 4]) {
      const a = computeTileHashes(art, grid)
      const b = computeTileHashes(art, grid)
      expect(a.length).toBe(grid * grid)
      a.forEach((hash, i) => {
        expect(hash.length).toBe(8)
        expect(hammingDistance(hash, b[i])).toBe(0)
      })
    }
  })

  it('a local change only moves the hashes of the tiles it touches', () => {
    const base = makeArt()
    // Paint a blob confined to the top-left 3×3 tile (tile w=142, h=83).
    const changed = makeArt((x, y) =>
      (x < 100 && y < 60) ? (x + y) % 2 ? 255 : 0 : (x * 7 + y * 13) % 256,
    )
    const a = computeTileHashes(base, 3)
    const b = computeTileHashes(changed, 3)
    expect(hammingDistance(a[0], b[0])).toBeGreaterThan(20)   // touched tile moves a lot
    for (const t of [2, 4, 5, 6, 7, 8]) {                      // far tiles don't move
      expect(hammingDistance(a[t], b[t])).toBe(0)
    }
  })

  it('flattenTileHashes lays tiles out row-major at 8 words each', () => {
    const art = makeArt()
    const hashes = computeTileHashes(art, 2)
    const flat = flattenTileHashes(hashes)
    expect(flat.length).toBe(4 * 8)
    hashes.forEach((hash, t) => {
      expect(Array.from(flat.subarray(t * 8, t * 8 + 8))).toEqual(Array.from(hash))
    })
  })
})

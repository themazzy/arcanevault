/**
 * tileHash.js — per-tile perceptual hashes over the art crop (pipeline v8)
 *
 * The single 32×32 art hash smears away the local structure that separates
 * similar-but-different arts (dense-tree Forests, guildgate cycles, …). Tile
 * hashing re-injects spatial locality: the art crop is split into a G×G grid
 * and every tile is hashed independently through the exact same
 * resize→gray→cap→CLAHE→DCT pipeline as the whole-art hash. Matching drops
 * the worst ~¼ of tiles (matchCore), which is also the glare tolerance — a
 * specular highlight ruins the tiles it touches, not the whole descriptor.
 *
 * Pure JS, shared by the browser scanner (ScannerEngine/visionWorker), the
 * Node seed script (via hashCard.js), and the grid harness.
 */

import { computeHashFromGray, rgbToGray32x32 } from './hashCore.js'
import { areaResizeRGBA, bilinearCropResize } from './visionCore.js'

/**
 * Split [0, size) into `grid` near-equal integer spans.
 * Returns grid+1 edge coordinates.
 */
export function tileEdges(size, grid) {
  const edges = new Array(grid + 1)
  for (let i = 0; i <= grid; i++) edges[i] = Math.round((i * size) / grid)
  return edges
}

/**
 * Compute G×G tile hashes (row-major) from an art crop.
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} artImageData
 * @param {number} grid — tiles per side (2, 3, or 4)
 * @returns {Uint32Array[]} G² hashes of Uint32Array(8) each
 */
export function computeTileHashes(artImageData, grid) {
  const { data, width, height } = artImageData
  const xs = tileEdges(width, grid)
  const ys = tileEdges(height, grid)
  const hashes = []
  for (let r = 0; r < grid; r++) {
    const y = ys[r]
    const h = ys[r + 1] - y
    for (let c = 0; c < grid; c++) {
      const x = xs[c]
      const w = xs[c + 1] - x
      // Integer-aligned 1:1 crop (fast-copy path), then INTER_AREA to 32×32 —
      // the same resize the whole-art hash uses, so tile hashes stay within
      // the seed↔client kernel tolerance.
      const tile = bilinearCropResize(data, width, height, x, y, w, h, w, h)
      const tile32 = areaResizeRGBA(tile, w, h, 32, 32)
      hashes.push(computeHashFromGray(rgbToGray32x32(tile32, 4)))
    }
  }
  return hashes
}

/**
 * Flatten tile hashes into one Uint32Array(G² × 8) — the layout stored in
 * format-v3 pack chunks and posted to the match worker.
 */
export function flattenTileHashes(hashes) {
  const flat = new Uint32Array(hashes.length * 8)
  for (let i = 0; i < hashes.length; i++) flat.set(hashes[i], i * 8)
  return flat
}

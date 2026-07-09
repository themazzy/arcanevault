/**
 * hashFusion.js — multi-frame per-bit hash fusion (pipeline v8)
 *
 * Glare and sensor noise flip DIFFERENT bits in different frames (the hand
 * moves, highlights shift). A per-bit majority vote across the sampled
 * frames reconstructs bits no single frame got right — a cleaner query than
 * any individual capture. Ties on an even frame count keep the first
 * frame's bit. Pure JS, shared by CardScanner and the grid harness.
 */

/** Per-bit majority vote over same-length u32 word arrays (number[] or Uint32Array). */
export function fuseWordArrays(arrays) {
  const n = arrays.length
  const len = arrays[0].length
  const out = new Array(len)
  for (let w = 0; w < len; w++) {
    let word = 0
    for (let b = 0; b < 32; b++) {
      const mask = (1 << b) >>> 0
      let votes = 0
      for (let f = 0; f < n; f++) if (arrays[f][w] & mask) votes++
      if (votes * 2 > n || (votes * 2 === n && (arrays[0][w] & mask))) word |= mask
    }
    out[w] = word >>> 0
  }
  return out
}

/**
 * Fuse per-frame primary hash sets ({ hash, colorHash, fullHash, tileHashes },
 * each a flat word array or null). A signal fuses only when every frame
 * carries it at the same length; the art hash is required. Returns the fused
 * set or null.
 */
export function fuseFrameHashes(frames) {
  if (frames.length < 2) return null
  const fuseKey = (key) => {
    const first = frames[0][key]
    if (!first?.length) return null
    return frames.every(f => f[key]?.length === first.length)
      ? fuseWordArrays(frames.map(f => f[key]))
      : null
  }
  const hash = fuseKey('hash')
  if (!hash) return null
  return {
    hash,
    colorHash: fuseKey('colorHash'),
    fullHash: fuseKey('fullHash'),
    tileHashes: fuseKey('tileHashes'),
  }
}

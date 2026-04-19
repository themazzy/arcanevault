/**
 * hashCore.js - shared perceptual hash computation
 *
 * Used by both the browser scanner (ScannerEngine.js) and the Node.js
 * seed script (generate-card-hashes.js). Pure JS - no DOM, OpenCV, or
 * native dependencies.
 *
 * IMPORTANT: If you change ANY step in computeHashFromGray or the preprocess
 * helpers below, the existing card_hashes table must be truncated and re-seeded.
 */

export const HASH_WORDS = 12
export const HASH_BITS = HASH_WORDS * 32
export const HASH_HEX_LENGTH = HASH_WORDS * 8

// Popcount lookup table (16-bit)
const POP16 = new Uint8Array(65536)
for (let i = 1; i < 65536; i++) POP16[i] = POP16[i >> 1] + (i & 1)

function popcount32(n) {
  return POP16[n & 0xFFFF] + POP16[(n >>> 16) & 0xFFFF]
}

/** Hamming distance between two same-width hashes (0-HASH_BITS). */
export function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Number.POSITIVE_INFINITY
  let d = 0
  for (let i = 0; i < a.length; i++) d += popcount32((a[i] ^ b[i]) >>> 0)
  return d
}

// Hex <-> Uint32Array(HASH_WORDS) conversion
//
// Hex format: 96 chars, 6 big-endian 64-bit blocks.
// Each 64-bit block maps to two Uint32 words in [lo, hi] order.

function u32Hex(n) {
  return (n >>> 0).toString(16).padStart(8, '0')
}

/** Convert a hash to its packed hex representation. */
export function hashToHex(hash) {
  let hex = ''
  for (let i = 0; i < hash.length; i += 2) hex += u32Hex(hash[i + 1]) + u32Hex(hash[i])
  return hex
}

/** Convert packed hex string -> Uint32Array(HASH_WORDS). */
export function hexToHash(hex) {
  if (!hex || hex.length !== HASH_HEX_LENGTH) return null
  try {
    const hash = new Uint32Array(HASH_WORDS)
    for (let i = 0; i < HASH_WORDS / 2; i++) {
      hash[i * 2 + 1] = parseInt(hex.slice(i * 16, i * 16 + 8), 16) >>> 0
      hash[i * 2] = parseInt(hex.slice(i * 16 + 8, i * 16 + 16), 16) >>> 0
    }
    return hash
  } catch {
    return null
  }
}

function percentileCap(u8, percentile) {
  const hist = new Int32Array(256)
  for (let i = 0; i < u8.length; i++) hist[u8[i]]++
  const target = Math.max(1, Math.floor(u8.length * percentile))
  let seen = 0
  let cap = 255
  for (let v = 0; v < 256; v++) {
    seen += hist[v]
    if (seen >= target) {
      cap = v
      break
    }
  }
  if (cap >= 250) return u8
  const out = new Uint8Array(u8.length)
  for (let i = 0; i < u8.length; i++) out[i] = u8[i] > cap ? cap : u8[i]
  return out
}

function applyCLAHE(u8, width, height, tileGridX = 4, tileGridY = 4, clipLimit = 40.0) {
  const tileW = Math.floor(width / tileGridX)
  const tileH = Math.floor(height / tileGridY)
  const tileArea = tileW * tileH
  const clip = Math.max(1, Math.floor((clipLimit * tileArea) / 256))

  const luts = []
  for (let ty = 0; ty < tileGridY; ty++) {
    for (let tx = 0; tx < tileGridX; tx++) {
      const hist = new Int32Array(256)
      for (let y = ty * tileH; y < (ty + 1) * tileH; y++) {
        for (let x = tx * tileW; x < (tx + 1) * tileW; x++) {
          hist[u8[y * width + x]]++
        }
      }

      let excess = 0
      for (let i = 0; i < 256; i++) {
        if (hist[i] > clip) {
          excess += hist[i] - clip
          hist[i] = clip
        }
      }

      const add = Math.floor(excess / 256)
      let rem = excess % 256
      const step = rem > 0 ? Math.floor(256 / rem) : 256
      for (let i = 0; i < 256; i++) {
        hist[i] += add
        if (rem > 0 && i % step === 0) {
          hist[i]++
          rem--
        }
      }

      const lut = new Uint8Array(256)
      let cdf = 0
      for (let i = 0; i < 256; i++) {
        cdf += hist[i]
        lut[i] = Math.min(255, Math.round((cdf * 255.0) / tileArea))
      }
      luts.push(lut)
    }
  }

  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = u8[y * width + x]
      const gx = (x + 0.5) / tileW - 0.5
      const gy = (y + 0.5) / tileH - 0.5
      const tx0 = Math.max(0, Math.min(tileGridX - 2, Math.floor(gx)))
      const ty0 = Math.max(0, Math.min(tileGridY - 2, Math.floor(gy)))
      const ax = Math.max(0, Math.min(1, gx - tx0))
      const ay = Math.max(0, Math.min(1, gy - ty0))
      out[y * width + x] = Math.round(
        luts[ty0 * tileGridX + tx0][v] * (1 - ax) * (1 - ay) +
        luts[ty0 * tileGridX + tx0 + 1][v] * ax * (1 - ay) +
        luts[(ty0 + 1) * tileGridX + tx0][v] * (1 - ax) * ay +
        luts[(ty0 + 1) * tileGridX + tx0 + 1][v] * ax * ay
      )
    }
  }
  return out
}

function mirrorIndex(index, length) {
  const absIndex = Math.abs(index)
  return absIndex >= length ? 2 * length - absIndex - 2 : absIndex
}

/**
 * 5x5 Gaussian blur (sigma ~= 1.0) on a planar grayscale buffer.
 * Shared by the seed script and client so both produce identical pixels.
 */
export function gaussianBlur5(gray, width, height) {
  const kernel = [0.061, 0.242, 0.383, 0.242, 0.061]
  const tmp = new Float32Array(width * height)
  const out = new Uint8Array(width * height)

  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let acc = 0
      for (let k = -2; k <= 2; k++) {
        const xi = mirrorIndex(x + k, width)
        acc += gray[row + xi] * kernel[k + 2]
      }
      tmp[row + x] = acc
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0
      for (let k = -2; k <= 2; k++) {
        const yi = mirrorIndex(y + k, height)
        acc += tmp[yi * width + x] * kernel[k + 2]
      }
      out[y * width + x] = Math.min(255, Math.max(0, Math.round(acc)))
    }
  }

  return out
}

/** Bilinear downsample to 32x32 from a planar grayscale buffer. */
export function resizeTo32x32(gray, width, height) {
  const out = new Uint8Array(1024)
  const scaleX = width / 32
  const scaleY = height / 32

  for (let y = 0; y < 32; y++) {
    const fy = (y + 0.5) * scaleY - 0.5
    const y0 = Math.max(0, Math.floor(fy))
    const y1 = Math.min(height - 1, y0 + 1)
    const ay = fy - y0

    for (let x = 0; x < 32; x++) {
      const fx = (x + 0.5) * scaleX - 0.5
      const x0 = Math.max(0, Math.floor(fx))
      const x1 = Math.min(width - 1, x0 + 1)
      const ax = fx - x0

      const p00 = gray[y0 * width + x0]
      const p10 = gray[y0 * width + x1]
      const p01 = gray[y1 * width + x0]
      const p11 = gray[y1 * width + x1]
      const top = p00 * (1 - ax) + p10 * ax
      const bottom = p01 * (1 - ax) + p11 * ax
      out[y * 32 + x] = Math.round(top * (1 - ay) + bottom * ay)
    }
  }

  return out
}

/**
 * Shared preprocess pipeline from raw RGB(A) art pixels to 32x32 grayscale.
 * This is the single source of truth for both the seed script and the live scanner.
 */
export function preprocessArtTo32x32Gray(rgba, width, height, channels = 4) {
  const gray = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const off = i * channels
    gray[i] = Math.round(0.299 * rgba[off] + 0.587 * rgba[off + 1] + 0.114 * rgba[off + 2])
  }
  const blurred = gaussianBlur5(gray, width, height)
  return resizeTo32x32(blurred, width, height)
}

/** Saturation-channel counterpart of preprocessArtTo32x32Gray. */
export function preprocessArtTo32x32Sat(rgba, width, height, channels = 4) {
  const sat = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const off = i * channels
    const r = rgba[off] / 255
    const g = rgba[off + 1] / 255
    const b = rgba[off + 2] / 255
    const max = Math.max(r, g, b)
    sat[i] = max === 0 ? 0 : Math.round((max - Math.min(r, g, b)) / max * 255)
  }
  const blurred = gaussianBlur5(sat, width, height)
  return resizeTo32x32(blurred, width, height)
}

// 2D DCT (Discrete Cosine Transform)
//
// Precomputed tables for N=32 so Math.cos is never called at runtime.
// COS_TABLE[x * 32 + u] = cos((2x+1)*u*PI/64)
// NORM[u] = (2/32) * (u===0 ? 1/sqrt(2) : 1) / 2

const DCT_SIZE = 32
const COS_TABLE = new Float64Array(DCT_SIZE * DCT_SIZE)
const NORM = new Float64Array(DCT_SIZE)
;(function buildTables() {
  for (let x = 0; x < DCT_SIZE; x++) {
    for (let u = 0; u < DCT_SIZE; u++) {
      COS_TABLE[x * DCT_SIZE + u] = Math.cos((2 * x + 1) * u * Math.PI / (2 * DCT_SIZE))
    }
  }
  for (let u = 0; u < DCT_SIZE; u++) {
    NORM[u] = (2 / DCT_SIZE) * (u === 0 ? 1 / Math.sqrt(2) : 1) / 2
  }
})()

function buildZigzag(rows, cols, count) {
  const max = rows * cols
  if (count > max) throw new Error(`Zigzag count ${count} exceeds matrix size ${max}`)
  const out = new Uint16Array(count)
  let i = 0
  let row = 0
  let col = 0
  let dir = 1
  while (i < count) {
    out[i++] = row * cols + col
    if (dir === 1) {
      if (col === cols - 1) {
        row++
        dir = -1
      } else if (row === 0) {
        col++
        dir = -1
      } else {
        row--
        col++
      }
    } else if (row === rows - 1) {
      col++
      dir = 1
    } else if (col === 0) {
      row++
      dir = 1
    } else {
      row++
      col--
    }
  }
  return out
}

const ZIGZAG_384 = buildZigzag(DCT_SIZE, DCT_SIZE, HASH_BITS)

function dct2d(matrix, size) {
  const out = new Float64Array(size * size)
  for (let y = 0; y < size; y++) {
    const rowOffset = y * size
    for (let u = 0; u < size; u++) {
      let sum = 0
      for (let x = 0; x < size; x++) {
        sum += matrix[rowOffset + x] * COS_TABLE[x * size + u]
      }
      out[rowOffset + u] = NORM[u] * sum
    }
  }

  const tmp = out.slice()
  for (let x = 0; x < size; x++) {
    for (let v = 0; v < size; v++) {
      let sum = 0
      for (let y = 0; y < size; y++) {
        sum += tmp[y * size + x] * COS_TABLE[y * size + v]
      }
      out[v * size + x] = NORM[v] * sum
    }
  }

  return out
}

function hashFromEqualized(equalized) {
  const pixels = new Float64Array(1024)
  for (let i = 0; i < 1024; i++) pixels[i] = equalized[i]

  const dct = dct2d(pixels, DCT_SIZE)
  const coeffs = new Float64Array(HASH_BITS)
  for (let i = 0; i < HASH_BITS; i++) coeffs[i] = dct[ZIGZAG_384[i]]

  let sum = 0
  for (let i = 1; i < HASH_BITS; i++) sum += coeffs[i]
  const mean = sum / (HASH_BITS - 1)

  const hash = new Uint32Array(HASH_WORDS)
  for (let i = 0; i < HASH_BITS; i++) {
    if (coeffs[i] > mean) hash[i >>> 5] |= 1 << (i & 31)
  }
  return hash
}

/**
 * Compute a 384-bit perceptual hash from 32x32 grayscale pixels.
 *
 * Pipeline: percentileCap(0.98) -> CLAHE(4x4, clip=40) -> 2D-DCT ->
 * first 384 JPEG-zigzag coefficients -> mean threshold -> 384 bits
 */
export function computeHashFromGray(grayU8) {
  if (grayU8.length !== 1024) throw new Error(`Expected 1024 gray pixels, got ${grayU8.length}`)
  const capped = percentileCap(grayU8, 0.98)
  const equalized = applyCLAHE(capped, 32, 32, 4, 4, 40)
  return hashFromEqualized(equalized)
}

/**
 * Variant of computeHashFromGray with aggressive glare suppression (percentileCap 0.92).
 * Used as a fallback when the standard hash scores poorly.
 */
export function computeHashFromGrayGlare(grayU8) {
  if (grayU8.length !== 1024) throw new Error(`Expected 1024 gray pixels, got ${grayU8.length}`)
  const capped = percentileCap(grayU8, 0.92)
  const equalized = applyCLAHE(capped, 32, 32, 4, 4, 40)
  return hashFromEqualized(equalized)
}

/**
 * Variant of computeHashFromGray for dark-art cards.
 * Does NOT change stored DB hashes - only used client-side for re-hashing on miss.
 */
export function computeHashFromGrayDark(grayU8) {
  if (grayU8.length !== 1024) throw new Error(`Expected 1024 gray pixels, got ${grayU8.length}`)
  const sorted = grayU8.slice().sort((a, b) => a - b)
  const p95 = sorted[Math.floor(grayU8.length * 0.95)]
  const scale = p95 > 10 ? Math.min(3.0, 200 / p95) : 1.0
  const stretched = new Uint8Array(1024)
  for (let i = 0; i < 1024; i++) stretched[i] = Math.min(255, Math.round(grayU8[i] * scale))
  const equalized = applyCLAHE(stretched, 32, 32, 4, 4, 40)
  return hashFromEqualized(equalized)
}

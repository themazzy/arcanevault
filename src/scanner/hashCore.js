/**
 * hashCore.js — shared perceptual hash computation
 *
 * Used by both the browser scanner (ScannerEngine.js) and the Node.js
 * seed script (generate-card-hashes.js). Pure JS — no DOM, OpenCV, or
 * native dependencies.
 *
 * IMPORTANT: If you change ANY step in computeHashFromGray, the existing
 * card_hashes table must be truncated and re-seeded.
 */

// ── Popcount lookup table (16-bit) ─────────────────────────────────────────

const POP16 = new Uint8Array(65536)
for (let i = 1; i < 65536; i++) POP16[i] = POP16[i >> 1] + (i & 1)

function popcount32(n) {
  return POP16[n & 0xFFFF] + POP16[(n >>> 16) & 0xFFFF]
}

/**
 * Hamming distance between two Uint32Array(8) hashes (0–256).
 */
export function hammingDistance(a, b) {
  let d = 0
  for (let i = 0; i < 8; i++) d += popcount32((a[i] ^ b[i]) >>> 0)
  return d
}

// ── Hex ↔ Uint32Array(8) conversion ────────────────────────────────────────
//
// Hex format: 64 chars, 4 big-endian 64-bit blocks (p1..p4).
// Each 64-bit block maps to two Uint32 words in [lo, hi] order:
//
//   hex[ 0:16] → p1 → hash[0] (lo), hash[1] (hi)
//   hex[16:32] → p2 → hash[2] (lo), hash[3] (hi)
//   hex[32:48] → p3 → hash[4] (lo), hash[5] (hi)
//   hex[48:64] → p4 → hash[6] (lo), hash[7] (hi)

function u32Hex(n) {
  return (n >>> 0).toString(16).padStart(8, '0')
}

/** Convert Uint32Array(8) hash → 64-char hex string. */
export function hashToHex(hash) {
  let hex = ''
  for (let i = 0; i < 8; i += 2) hex += u32Hex(hash[i + 1]) + u32Hex(hash[i])
  return hex
}

/** Convert 64-char hex string → Uint32Array(8). */
export function hexToHash(hex) {
  if (!hex || hex.length !== 64) return null
  try {
    const h = new Uint32Array(8)
    for (let i = 0; i < 4; i++) {
      h[i * 2 + 1] = parseInt(hex.slice(i * 16, i * 16 + 8), 16) >>> 0
      h[i * 2]     = parseInt(hex.slice(i * 16 + 8, i * 16 + 16), 16) >>> 0
    }
    return h
  } catch { return null }
}

// ── percentileCap (glare / highlight suppression) ───────────────────────────

function percentileCap(u8, percentile) {
  const hist = new Int32Array(256)
  for (let i = 0; i < u8.length; i++) hist[u8[i]]++
  const target = Math.max(1, Math.floor(u8.length * percentile))
  let seen = 0, cap = 255
  for (let v = 0; v < 256; v++) {
    seen += hist[v]
    if (seen >= target) { cap = v; break }
  }
  if (cap >= 250) return u8
  const out = new Uint8Array(u8.length)
  for (let i = 0; i < u8.length; i++) out[i] = u8[i] > cap ? cap : u8[i]
  return out
}

// ── CLAHE (Contrast Limited Adaptive Histogram Equalisation) ────────────────

function applyCLAHE(u8, width, height, tileGridX = 4, tileGridY = 4, clipLimit = 40.0) {
  const tileW = Math.floor(width / tileGridX)
  const tileH = Math.floor(height / tileGridY)
  const tileArea = tileW * tileH
  const clip = Math.max(1, Math.floor(clipLimit * tileArea / 256))

  const luts = []
  for (let ty = 0; ty < tileGridY; ty++) {
    for (let tx = 0; tx < tileGridX; tx++) {
      const hist = new Int32Array(256)
      for (let y = ty * tileH; y < (ty + 1) * tileH; y++)
        for (let x = tx * tileW; x < (tx + 1) * tileW; x++)
          hist[u8[y * width + x]]++

      let excess = 0
      for (let i = 0; i < 256; i++) {
        if (hist[i] > clip) { excess += hist[i] - clip; hist[i] = clip }
      }
      const add = Math.floor(excess / 256)
      let rem = excess % 256
      const step = rem > 0 ? Math.floor(256 / rem) : 256
      for (let i = 0; i < 256; i++) {
        hist[i] += add
        if (rem > 0 && i % step === 0) { hist[i]++; rem-- }
      }

      const lut = new Uint8Array(256)
      let cdf = 0
      for (let i = 0; i < 256; i++) {
        cdf += hist[i]
        lut[i] = Math.min(255, Math.round(cdf * 255.0 / tileArea))
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
        luts[(ty0 + 1) * tileGridX + tx0 + 1][v] * ax * ay,
      )
    }
  }
  return out
}

// ── 2D DCT (Discrete Cosine Transform) ─────────────────────────────────────
//
// Precomputed tables for N=32 so Math.cos is never called at runtime.
// COS_TABLE[x * 32 + u] = cos((2x+1)*u*PI/64)
// NORM[u] = (2/32) * (u===0 ? 1/sqrt(2) : 1) / 2

const _N = 32
const COS_TABLE = new Float64Array(_N * _N)
const NORM = new Float64Array(_N)
;(function buildTables() {
  for (let x = 0; x < _N; x++)
    for (let u = 0; u < _N; u++)
      COS_TABLE[x * _N + u] = Math.cos((2 * x + 1) * u * Math.PI / (2 * _N))
  for (let u = 0; u < _N; u++)
    NORM[u] = (2 / _N) * (u === 0 ? 1 / Math.sqrt(2) : 1) / 2
})()

function dct2d(matrix, N) {
  const out = new Float64Array(N * N)
  // Row-wise DCT
  for (let y = 0; y < N; y++) {
    const rowOff = y * N
    for (let u = 0; u < N; u++) {
      let sum = 0
      for (let x = 0; x < N; x++)
        sum += matrix[rowOff + x] * COS_TABLE[x * N + u]
      out[rowOff + u] = NORM[u] * sum
    }
  }
  // Column-wise DCT
  const tmp = out.slice()
  for (let x = 0; x < N; x++) {
    for (let v = 0; v < N; v++) {
      let sum = 0
      for (let y = 0; y < N; y++)
        sum += tmp[y * N + x] * COS_TABLE[y * N + v]
      out[v * N + x] = NORM[v] * sum
    }
  }
  return out
}

// ── Core hash from 32×32 grayscale pixels ───────────────────────────────────

/**
 * Compute a 256-bit perceptual hash from 32×32 grayscale pixels.
 * Returns Uint32Array(8).
 *
 * Pipeline: percentileCap(0.98) → CLAHE(4×4, clip=40) → 2D-DCT →
 *           top-left 16×16 coefficients → median threshold → 256 bits
 */
export function computeHashFromGray(grayU8) {
  if (grayU8.length !== 1024) throw new Error(`Expected 1024 gray pixels, got ${grayU8.length}`)

  const capped = percentileCap(grayU8, 0.98)
  const equalized = applyCLAHE(capped, 32, 32)

  const pixels = new Float64Array(1024)
  for (let i = 0; i < 1024; i++) pixels[i] = equalized[i]

  const dct = dct2d(pixels, 32)

  const coeffs = new Float64Array(256)
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++)
      coeffs[y * 16 + x] = dct[y * 32 + x]

  let sum = 0
  for (let i = 1; i < 256; i++) sum += coeffs[i]
  const mean = sum / 255

  const hash = new Uint32Array(8)
  for (let i = 0; i < 256; i++) {
    if (coeffs[i] > mean) hash[i >>> 5] |= 1 << (i & 31)
  }
  return hash
}

/**
 * Variant of computeHashFromGray with aggressive glare suppression (percentileCap 0.92).
 * Used as a fallback when the standard hash scores poorly — helps foil cards under
 * uneven lighting where specular hotspots dominate more than 2% of the art pixels.
 * Does NOT change stored DB hashes — only used client-side for re-hashing on miss.
 */
export function computeHashFromGrayGlare(grayU8) {
  if (grayU8.length !== 1024) throw new Error(`Expected 1024 gray pixels, got ${grayU8.length}`)
  const capped = percentileCap(grayU8, 0.92)
  const equalized = applyCLAHE(capped, 32, 32)
  const pixels = new Float64Array(1024)
  for (let i = 0; i < 1024; i++) pixels[i] = equalized[i]
  const dct = dct2d(pixels, 32)
  const coeffs = new Float64Array(256)
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++)
      coeffs[y * 16 + x] = dct[y * 32 + x]
  let sum = 0
  for (let i = 1; i < 256; i++) sum += coeffs[i]
  const mean = sum / 255
  const hash = new Uint32Array(8)
  for (let i = 0; i < 256; i++) {
    if (coeffs[i] > mean) hash[i >>> 5] |= 1 << (i & 31)
  }
  return hash
}

/**
 * Variant of computeHashFromGray for dark art cards (Swamp, Phyrexian cards, etc).
 * Stretches the dark dynamic range before hashing so CLAHE has more signal to work with.
 * percentileCap(0.98) is a no-op on dark images; this replaces it with a linear floor-stretch.
 * Does NOT change stored DB hashes — only used client-side for re-hashing on miss.
 */
export function computeHashFromGrayDark(grayU8) {
  if (grayU8.length !== 1024) throw new Error(`Expected 1024 gray pixels, got ${grayU8.length}`)
  const sorted = grayU8.slice().sort((a, b) => a - b)
  const p95 = sorted[Math.floor(grayU8.length * 0.95)]
  const scale = p95 > 10 ? Math.min(3.0, 200 / p95) : 1.0
  const stretched = new Uint8Array(1024)
  for (let i = 0; i < 1024; i++)
    stretched[i] = Math.min(255, Math.round(grayU8[i] * scale))
  const equalized = applyCLAHE(stretched, 32, 32)
  const pixels = new Float64Array(1024)
  for (let i = 0; i < 1024; i++) pixels[i] = equalized[i]
  const dct = dct2d(pixels, 32)
  const coeffs = new Float64Array(256)
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++)
      coeffs[y * 16 + x] = dct[y * 32 + x]
  let sum = 0
  for (let i = 1; i < 256; i++) sum += coeffs[i]
  const mean = sum / 255
  const hash = new Uint32Array(8)
  for (let i = 0; i < 256; i++) {
    if (coeffs[i] > mean) hash[i >>> 5] |= 1 << (i & 31)
  }
  return hash
}

/**
 * Convert 32×32 grayscale Uint8Array to BT.709 from raw RGB(A) buffer.
 * Works with both 3-channel (RGB) and 4-channel (RGBA) input.
 */
export function rgbToGray32x32(rgbData, channels = 4) {
  const grayU8 = new Uint8Array(1024)
  for (let i = 0; i < 1024; i++) {
    const off = i * channels
    grayU8[i] = Math.round(0.2126 * rgbData[off] + 0.7152 * rgbData[off + 1] + 0.0722 * rgbData[off + 2])
  }
  return grayU8
}

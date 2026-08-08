/**
 * scanner-harness-core.mjs — shared plumbing for the scanner A/B harnesses
 *
 * Scryfall fetch + image cache, deterministic RNG, and the capture-degradation
 * model (perspective jitter, blur, glare, noise, exposure, low-res, white
 * balance). Extracted so a new experiment doesn't have to re-derive the
 * degradation model — the numbers a harness produces are only comparable to a
 * previous verdict if the simulated capture chain is the same one.
 *
 * scripts/scanner-grid-harness.js (the frozen v8 tile experiment) still carries
 * its own copies of these helpers on purpose: it is the record behind the
 * "tiles regress" verdict in CLAUDE.md and is not worth re-touching. The
 * degradation functions here are byte-for-byte the same logic.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fetch from 'node-fetch'
import sharp from 'sharp'
import { CARD_W, CARD_H, ART_X, ART_Y, ART_W, ART_H } from '../../src/scanner/constants.js'
import { warpPerspectiveRGBA } from '../../src/scanner/visionCore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const CACHE_DIR = path.join(__dirname, '..', '..', 'node_modules', '.cache', 'scanner-harness')
const UA = { 'User-Agent': 'DeckLoomScannerHarness/1.0', Accept: '*/*' }

// ── Deterministic RNG ────────────────────────────────────────────────────────

export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── Scryfall fetch (search API, cached images) ──────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function searchCards(query, cap) {
  const cards = []
  let url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&unique=prints&order=released&dir=desc`
  while (url && cards.length < cap) {
    const res = await fetch(url, { headers: UA })
    if (!res.ok) throw new Error(`Scryfall search HTTP ${res.status} for ${query}`)
    const page = await res.json()
    for (const c of page.data ?? []) {
      if (c.digital) continue
      const img = c.image_uris?.normal ?? c.card_faces?.[0]?.image_uris?.normal
      if (!img || !/^[0-9a-f-]{36}$/.test(c.id)) continue
      cards.push({
        scryfall_id: c.id,
        name: c.name,
        set_code: c.set,
        collector_number: c.collector_number,
        flavor_name: c.flavor_name ?? '',
        face: 0,
        imageUri: img,
        illustration_id: c.illustration_id ?? c.card_faces?.[0]?.illustration_id ?? c.id,
      })
      if (cards.length >= cap) break
    }
    url = page.has_more ? page.next_page : null
    await sleep(110)
  }
  return cards
}

/** Download (once) and decode a card render to a 500×700 RGBA buffer. */
export async function fetchImageCached(card) {
  mkdirSync(CACHE_DIR, { recursive: true })
  const key = createHash('sha1').update(card.imageUri).digest('hex')
  const file = path.join(CACHE_DIR, `${key}.jpg`)
  if (!existsSync(file)) {
    const res = await fetch(card.imageUri, { headers: UA })
    if (!res.ok) throw new Error(`image HTTP ${res.status}`)
    writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  }
  const { data } = await sharp(readFileSync(file))
    .resize(CARD_W, CARD_H, { fit: 'fill', kernel: 'lanczos3' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return new Uint8ClampedArray(data.buffer, data.byteOffset, data.length)
}

// ── Capture degradation (pure JS on the 500×700 RGBA render) ────────────────

/** Perspective jitter: re-warp the card with corner-detection error of ±e px. */
export function jitterWarp(rgba, rng, e) {
  if (!e) return rgba
  const j = () => (rng() * 2 - 1) * e
  const corners = [
    { x: 0 + j(), y: 0 + j() },
    { x: CARD_W + j(), y: 0 + j() },
    { x: CARD_W + j(), y: CARD_H + j() },
    { x: 0 + j(), y: CARD_H + j() },
  ]
  return warpPerspectiveRGBA(rgba, CARD_W, CARD_H, corners, CARD_W, CARD_H) ?? rgba
}

/** Additive specular blob (foil glare): radial falloff toward white. */
export function addGlare(rgba, rng, { blobs = 1, radius = 130, strength = 230 } = {}) {
  const out = new Uint8ClampedArray(rgba)
  for (let n = 0; n < blobs; n++) {
    // Center the blob inside the art region — that's where glare hurts.
    const cx = ART_X + rng() * ART_W
    const cy = ART_Y + rng() * ART_H
    const r = radius * (0.7 + rng() * 0.6)
    const s = strength * (0.7 + rng() * 0.3)
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(CARD_W, Math.ceil(cx + r))
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(CARD_H, Math.ceil(cy + r))
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const d = Math.hypot(x - cx, y - cy) / r
        if (d >= 1) continue
        const add = s * (1 - d) * (1 - d)
        const p = (y * CARD_W + x) * 4
        out[p] = Math.min(255, out[p] + add)
        out[p + 1] = Math.min(255, out[p + 1] + add)
        out[p + 2] = Math.min(255, out[p + 2] + add)
      }
    }
  }
  return out
}

export function addNoise(rgba, rng, amp) {
  if (!amp) return rgba
  const out = new Uint8ClampedArray(rgba)
  for (let i = 0; i < out.length; i += 4) {
    const n = (rng() * 2 - 1) * amp
    out[i] += n; out[i + 1] += n; out[i + 2] += n
  }
  return out
}

export function scaleExposure(rgba, factor) {
  if (factor === 1) return rgba
  const out = new Uint8ClampedArray(rgba)
  for (let i = 0; i < out.length; i += 4) {
    out[i] *= factor; out[i + 1] *= factor; out[i + 2] *= factor
  }
  return out
}

/**
 * Residual white-balance cast: per-channel gains after imperfect AWB.
 * A phone under warm indoor light that the camera only partly corrects keeps a
 * cast of roughly this size; the reference renders are neutral, so this is the
 * mismatch a colour-channel descriptor has to survive.
 */
export function whiteBalance(rgba, { r = 1, g = 1, b = 1 } = {}) {
  const out = new Uint8ClampedArray(rgba)
  for (let i = 0; i < out.length; i += 4) {
    out[i] *= r; out[i + 1] *= g; out[i + 2] *= b
  }
  return out
}

/** Cheap separable box-blur ×3 ≈ Gaussian; radius in px. */
export function blurRGBA(rgba, radius) {
  if (!radius) return rgba
  let src = new Float32Array(rgba)
  const w = CARD_W, h = CARD_H
  const pass = (input, horizontal) => {
    const out = new Float32Array(input.length)
    const span = 2 * radius + 1
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 4; c++) {
          let sum = 0
          for (let k = -radius; k <= radius; k++) {
            const xx = horizontal ? Math.min(w - 1, Math.max(0, x + k)) : x
            const yy = horizontal ? y : Math.min(h - 1, Math.max(0, y + k))
            sum += input[(yy * w + xx) * 4 + c]
          }
          out[(y * w + x) * 4 + c] = sum / span
        }
      }
    }
    return out
  }
  for (let i = 0; i < 2; i++) src = pass(pass(src, true), false)
  return new Uint8ClampedArray(src)
}

/** Simulate low effective capture resolution: downscale then upscale. */
export function lowRes(rgba, factor) {
  const w = Math.round(CARD_W * factor), h = Math.round(CARD_H * factor)
  const cornersDown = [
    { x: 0, y: 0 }, { x: CARD_W, y: 0 }, { x: CARD_W, y: CARD_H }, { x: 0, y: CARD_H },
  ]
  const small = warpPerspectiveRGBA(rgba, CARD_W, CARD_H, cornersDown, w, h)
  const cornersUp = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]
  return warpPerspectiveRGBA(small, w, h, cornersUp, CARD_W, CARD_H) ?? rgba
}

// ── Scenario sets ────────────────────────────────────────────────────────────

/**
 * The capture-degradation scenarios the harnesses score against. Exported so
 * scanner-degradation-preview.js renders exactly what was measured — a copy
 * would drift and the preview would stop being evidence.
 *
 * SURVIVABLE: the seven from the frozen tile harness (scanner-grid-harness.js
 * still carries its own identical copy).
 * SEVERE: added for the acceptance-gate experiment, where the survivable tier
 * saturated at ~100% accept for every gate and could not discriminate.
 */
export const SURVIVABLE_SCENARIOS = [
  ['clean-j1', (rgba, rng) => jitterWarp(rgba, rng, 1)],
  ['jitter4', (rgba, rng) => jitterWarp(rgba, rng, 4)],
  ['jitter8', (rgba, rng) => jitterWarp(rgba, rng, 8)],
  ['lowres45', (rgba, rng) => lowRes(jitterWarp(rgba, rng, 3), 0.45)],
  ['blur+j3', (rgba, rng) => blurRGBA(jitterWarp(rgba, rng, 3), 3)],
  ['glare2+jit', (rgba, rng) => addGlare(jitterWarp(rgba, rng, 4), rng, { blobs: 2, strength: 250 })],
  ['dark+noise', (rgba, rng) => addNoise(scaleExposure(jitterWarp(rgba, rng, 3), 0.45), rng, 14)],
]

export const SEVERE_SCENARIOS = [
  ['jitter14', (rgba, rng) => jitterWarp(rgba, rng, 14)],
  ['glare4', (rgba, rng) => addGlare(jitterWarp(rgba, rng, 4), rng, { blobs: 4, radius: 160, strength: 255 })],
  ['blur6+j5', (rgba, rng) => blurRGBA(jitterWarp(rgba, rng, 5), 6)],
  ['lowres25', (rgba, rng) => lowRes(jitterWarp(rgba, rng, 4), 0.25)],
  ['vdark+noise', (rgba, rng) => addNoise(scaleExposure(jitterWarp(rgba, rng, 4), 0.30), rng, 25)],
  ['combo', (rgba, rng) =>
    addNoise(scaleExposure(addGlare(blurRGBA(jitterWarp(rgba, rng, 8), 3), rng, { blobs: 2 }), 0.6), rng, 12)],
]

/** White-balance scenarios — colour-harness only. */
export const WHITE_BALANCE_SCENARIOS = [
  ['wb-warm+j3', (rgba, rng) => whiteBalance(jitterWarp(rgba, rng, 3), { r: 1.14, g: 1.0, b: 0.86 })],
  ['wb-cool+j3', (rgba, rng) => whiteBalance(jitterWarp(rgba, rng, 3), { r: 0.88, g: 0.98, b: 1.16 })],
  ['wb-warm+gl', (rgba, rng) =>
    addGlare(whiteBalance(jitterWarp(rgba, rng, 3), { r: 1.14, g: 1.0, b: 0.86 }), rng, { blobs: 2 })],
]

// ── Reporting helpers ────────────────────────────────────────────────────────

export const pct = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : '—'
export const mean = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : NaN
export const percentile = (arr, q) => {
  if (!arr.length) return NaN
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length * q)]
}

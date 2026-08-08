/**
 * scanner-pipeline-harness.js — full scan pipeline, frame in → acceptance out
 *
 * Replays CardScanner's scan path against the REAL 111k-row pack in
 * public/scanner/hashpack/, through the real ScannerEngine and matchCore code:
 *
 *   synthetic frame → detectCardCorners (3-pass, on the ½-size frame)
 *                   → warpCard from full-res  |  cropCardFromReticle on failure
 *                   → crop-variant ladder × {standard, foil, dark} × rot180
 *                   → reticle re-run when the corner result is non-decisive
 *                   → stability voting over up to STABILITY_SAMPLES frames
 *                   → shouldAcceptMatch
 *
 * ── WHAT IS REAL HERE, AND WHAT IS NOT ──────────────────────────────────────
 * TRUSTWORTHY — detection. `detectCardCorners` solving a card quad out of a
 *   frame is a genuine geometric problem and is NOT affected by the self-match
 *   issue below. Detection rate, which pass succeeds, and detection cost are
 *   the numbers this harness is actually good for.
 *
 * NOT TRUSTWORTHY — hash-match difficulty. The pack was seeded from the same
 *   Scryfall renders these probes derive from, so every probe is effectively a
 *   self-match: the correct row sits at ~0 distance no matter how hard the
 *   degradation, and the ladder exits decisive on the first crop variant. An
 *   earlier revision of this file cranked degradation to absurd levels
 *   (jitter ±14, blur r=5, 3 max glare blobs, exposure 0.4) and STILL got 100%
 *   decisive-on-frame-1. So this harness CANNOT size how often the expensive
 *   ladder rungs fire in reality. That needs the on-device [scan] log, which
 *   the scanner's admin panel now exposes.
 *
 * NOT COVERED — the assign workflow (basket → folder → `cards` / `folder_cards`
 *   / `deck_allocations`). Those are RLS-governed Supabase writes; a harness
 *   could only mock them (proving nothing) or write to production (no). That
 *   path belongs in unit tests.
 *
 * NOT MEASURABLE — `CameraPreview.captureSample()` (~250 ms/frame, native, and
 *   the largest single term in a real 700–1200 ms scan), worker postMessage
 *   overhead, and phone CPU.
 *
 * Usage:
 *   node scripts/scanner-pipeline-harness.js [--quick] [--probes N]
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  searchCards, fetchImageCached, mulberry32,
  addGlare, addNoise, scaleExposure, blurRGBA, percentile,
} from './lib/scanner-harness-core.mjs'
import { CARD_W, CARD_H } from '../src/scanner/constants.js'
import { HashPackStore } from '../src/scanner/hashPack.js'
import { createMatcher } from '../src/scanner/matchCore.js'
import {
  detectCardCorners, warpCard, cropCardFromReticle, cropArtRegion,
  computeAllHashes, computeFullCardHash, rotateCard180, isUsableArtCrop,
} from '../src/scanner/ScannerEngine.js'
import { warpPerspectiveRGBA } from '../src/scanner/visionCore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PACK_DIR = path.join(__dirname, '..', 'public', 'scanner', 'hashpack')

const QUICK = process.argv.includes('--quick')
const probeArg = process.argv.indexOf('--probes')
const PROBE_COUNT = probeArg !== -1 ? Math.max(5, parseInt(process.argv[probeArg + 1], 10) || 40) : (QUICK ? 12 : 40)

// ── Constants copied verbatim from CardScanner.jsx ───────────────────────────
const MATCH_THRESHOLD = 122
const MATCH_MIN_GAP = 8
const MATCH_STRONG_THRESHOLD = 134
const MATCH_STRONG_SINGLE = 108
const STABILITY_SAMPLES = 3
const STABILITY_REQUIRED = 2
const PRIMARY_CROP_VARIANTS = [
  { xOffset: 0, yOffset: 0 },
  { xOffset: 0, yOffset: -10 },
  { xOffset: 0, yOffset: 10 },
  { xOffset: 0, yOffset: 0, inset: 6 },
]
const MARGINAL_CROP_VARIANTS = [
  { xOffset: -8, yOffset: 0 }, { xOffset: 8, yOffset: 0 },
  { xOffset: -8, yOffset: -8 }, { xOffset: 8, yOffset: -8 },
  { xOffset: -8, yOffset: 8 }, { xOffset: 8, yOffset: 8 },
]
const FAST_PRIMARY_VARIANTS = [PRIMARY_CROP_VARIANTS[0]]

const isDecisive = (best, gap) => !!best && best.distance <= MATCH_STRONG_SINGLE && gap >= MATCH_MIN_GAP
const normName = (v = '') => v.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()

function shouldAcceptMatch({ best, gap, stableCount, sameNameCluster = false }) {
  if (!best) return false
  if (stableCount >= STABILITY_REQUIRED && best.distance <= MATCH_THRESHOLD && gap >= MATCH_MIN_GAP) return true
  if (stableCount >= STABILITY_REQUIRED && sameNameCluster && best.distance <= MATCH_THRESHOLD) return true
  if (stableCount >= STABILITY_REQUIRED && best.distance <= MATCH_STRONG_THRESHOLD && gap >= MATCH_MIN_GAP) return true
  if (stableCount >= 1 && sameNameCluster && best.distance <= MATCH_STRONG_THRESHOLD) return true
  if (stableCount >= 1 && best.distance <= MATCH_STRONG_SINGLE && gap >= MATCH_MIN_GAP) return true
  return false
}

// ── Synthetic camera frame ───────────────────────────────────────────────────
// A 500×700 render composited onto a background at a plausible viewfinder size,
// so detectCardCorners has an actual quad-finding problem to solve rather than
// being handed the answer.
const FRAME_W = 720, FRAME_H = 1280
const CARD_DRAW_H = 900
const CARD_DRAW_W = Math.round(CARD_DRAW_H * (CARD_W / CARD_H))

/** Background presets — the detector's difficulty is mostly the card/bg edge. */
const BACKGROUNDS = {
  table: [78, 74, 70],      // mid-grey wood: clear luminance edge
  dark: [26, 24, 24],       // dark playmat: black border nearly vanishes
  colored: [96, 30, 30],    // red mat: low luma edge, strong chroma edge (pass 4)
  pattern: [70, 68, 66],    // GEOMETRIC mat — see patternAt(); adversarial worst case
  artmat: [72, 66, 62],     // printed ART mat — see artMatAt(); the realistic case
}

/**
 * Printed-playmat texture: diagonal banding plus a grid, at a contrast that
 * produces real contours. A flat background makes contour detection
 * unrealistically easy — a patterned mat gives findBestQuad plenty of rival
 * quads to score, which is the actual failure mode people hit on art mats.
 */
function patternAt(x, y) {
  const diag = Math.sin((x + y) * 0.055) * 26
  const grid = ((x % 96 < 3) || (y % 96 < 3)) ? 22 : 0
  const blot = Math.sin(x * 0.011) * Math.cos(y * 0.013) * 18
  return diag + grid + blot
}

/**
 * Printed ART playmat — the realistic case, and the one that decides whether
 * the patterned-mat failure is a genuine product problem or an artefact of an
 * adversarial fixture. Multi-octave organic variation with NO straight
 * high-contrast lines: illustration produces soft gradients and curved forms,
 * which give Canny far less to latch onto than a geometric grid does.
 */
function artMatAt(x, y) {
  const a = Math.sin(x * 0.004 + Math.cos(y * 0.003) * 2.0) * 16
  const b = Math.sin((x * 0.9 + y * 1.3) * 0.0026 + 1.1) * 12
  const c = Math.cos(y * 0.0071 + Math.sin(x * 0.0045) * 1.7) * 9
  const fine = Math.sin(x * 0.05) * Math.sin(y * 0.047) * 3   // paper texture
  return a + b + c + fine
}

// ── Sleeve model ─────────────────────────────────────────────────────────────
// A penny/perfect-fit sleeve is a few mm larger than the card on each side, so
// it presents a SECOND quad slightly outside the real one. If the detector
// locks onto the sleeve edge instead of the card edge, every downstream crop
// shifts outward and the art hash degrades systematically — which is why this
// harness measures corner error against the known card quad, not just whether
// a quad was found at all.
const SLEEVE_MARGIN = 0.035   // ~3 mm on a 63 mm card

/** Expand a quad about its centroid by `f` (fraction of size). */
function expandQuad(quad, f) {
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4
  const cy = quad.reduce((s, p) => s + p.y, 0) / 4
  return quad.map(p => ({ x: cx + (p.x - cx) * (1 + f), y: cy + (p.y - cy) * (1 + f) }))
}

function pointInQuad(q, px, py) {
  let inside = false
  for (let i = 0, j = 3; i < 4; j = i++) {
    const xi = q[i].x, yi = q[i].y, xj = q[j].x, yj = q[j].y
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * Specular streak off flat plastic. Unlike foil glare (localized radial
 * hotspots) a sleeve reflects a light source or window as an ELONGATED band
 * with a soft edge, often crossing most of the card.
 */
function sleeveGlare(data, w, h, rng, quad) {
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4
  const cy = quad.reduce((s, p) => s + p.y, 0) / 4
  const angle = (rng() * 0.8 - 0.4) + Math.PI / 3
  const dx = Math.cos(angle), dy = Math.sin(angle)
  const offset = (rng() * 2 - 1) * 180
  const halfWidth = 55 + rng() * 70
  const strength = 120 + rng() * 90
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!pointInQuad(quad, x, y)) continue
      // Perpendicular distance to the streak's centre line.
      const d = Math.abs((x - cx) * dy - (y - cy) * dx - offset)
      if (d > halfWidth) continue
      const t = 1 - d / halfWidth
      const add = strength * t * t
      const p = (y * w + x) * 4
      data[p] = Math.min(255, data[p] + add)
      data[p + 1] = Math.min(255, data[p + 1] + add)
      data[p + 2] = Math.min(255, data[p + 2] + add)
    }
  }
}

/**
 * Optical effect of the plastic itself: a slight haze (contrast pulled toward
 * mid-grey), a faint cool tint, and a touch of softening. Individually small,
 * but they shift every hash bit a little.
 */
function sleeveHaze(data, w, h, quad) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!pointInQuad(quad, x, y)) continue
      const p = (y * w + x) * 4
      for (let c = 0; c < 3; c++) {
        const tint = c === 2 ? 6 : (c === 0 ? -4 : 0)   // faint cool cast
        data[p + c] = 128 + (data[p + c] - 128) * 0.88 + 10 + tint
      }
    }
  }
}

/**
 * Composite the card into a frame at a jittered quad, so the detector must
 * recover a genuinely rotated/skewed card rather than an axis-aligned paste.
 */
function buildFrame(cardRGBA, rng, { bg = 'table', skew = 12, sleeve = false } = {}) {
  const [br, bg_, bb] = BACKGROUNDS[bg]
  const data = new Uint8ClampedArray(FRAME_W * FRAME_H * 4)
  for (let y = 0; y < FRAME_H; y++) {
    for (let x = 0; x < FRAME_W; x++) {
      const i = (y * FRAME_W + x) * 4
      // Slight per-pixel noise keeps the background from being a perfectly flat
      // field, which would make edge detection unrealistically easy.
      const n = (rng() * 2 - 1) * 4 +
        (bg === 'pattern' ? patternAt(x, y) : bg === 'artmat' ? artMatAt(x, y) : 0)
      data[i] = br + n; data[i + 1] = bg_ + n; data[i + 2] = bb + n; data[i + 3] = 255
    }
  }
  const cx = FRAME_W / 2, cy = FRAME_H / 2
  const hw = CARD_DRAW_W / 2, hh = CARD_DRAW_H / 2
  const j = () => (rng() * 2 - 1) * skew
  const quad = [
    { x: cx - hw + j(), y: cy - hh + j() },
    { x: cx + hw + j(), y: cy - hh + j() },
    { x: cx + hw + j(), y: cy + hh + j() },
    { x: cx - hw + j(), y: cy + hh + j() },
  ]
  // Sleeve first, UNDER the card: a slightly larger quad of clear plastic over
  // the mat. It lifts the background a little and adds a faint specular edge,
  // which is exactly the competing quad the detector may lock onto instead of
  // the card.
  const sleeveQuad = sleeve ? expandQuad(quad, SLEEVE_MARGIN) : null
  if (sleeveQuad) {
    const sxs = sleeveQuad.map(p => p.x), sys = sleeveQuad.map(p => p.y)
    const sx0 = Math.max(0, Math.floor(Math.min(...sxs))), sx1 = Math.min(FRAME_W, Math.ceil(Math.max(...sxs)))
    const sy0 = Math.max(0, Math.floor(Math.min(...sys))), sy1 = Math.min(FRAME_H, Math.ceil(Math.max(...sys)))
    for (let y = sy0; y < sy1; y++) {
      for (let x = sx0; x < sx1; x++) {
        if (!pointInQuad(sleeveQuad, x, y)) continue
        const p = (y * FRAME_W + x) * 4
        for (let c = 0; c < 3; c++) data[p + c] = Math.min(255, data[p + c] * 0.92 + 26)
      }
    }
  }

  // Inverse-map every pixel inside the quad's bounding box back to card space.
  const xs = quad.map(p => p.x), ys = quad.map(p => p.y)
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(FRAME_W, Math.ceil(Math.max(...xs)))
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(FRAME_H, Math.ceil(Math.max(...ys)))
  // Solve card→frame as a bilinear interpolation over the quad; adequate for a
  // small skew and avoids inverting a homography by hand.
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const uv = inverseBilinear(quad, x, y)
      if (!uv) continue
      const { u, v } = uv
      if (u < 0 || u > 1 || v < 0 || v > 1) continue
      const sx = Math.min(CARD_W - 1, Math.max(0, u * CARD_W))
      const sy = Math.min(CARD_H - 1, Math.max(0, v * CARD_H))
      const si = ((sy | 0) * CARD_W + (sx | 0)) * 4
      const di = (y * FRAME_W + x) * 4
      data[di] = cardRGBA[si]; data[di + 1] = cardRGBA[si + 1]
      data[di + 2] = cardRGBA[si + 2]; data[di + 3] = 255
    }
  }
  if (sleeveQuad) {
    sleeveHaze(data, FRAME_W, FRAME_H, sleeveQuad)
    sleeveGlare(data, FRAME_W, FRAME_H, rng, sleeveQuad)
  }
  return { data, width: FRAME_W, height: FRAME_H, quad, sleeveQuad }
}

/** Newton solve for (u,v) in a bilinear quad. Converges in a few iterations. */
function inverseBilinear(q, px, py) {
  let u = 0.5, v = 0.5
  for (let i = 0; i < 8; i++) {
    const top = { x: q[0].x + (q[1].x - q[0].x) * u, y: q[0].y + (q[1].y - q[0].y) * u }
    const bot = { x: q[3].x + (q[2].x - q[3].x) * u, y: q[3].y + (q[2].y - q[3].y) * u }
    const fx = top.x + (bot.x - top.x) * v - px
    const fy = top.y + (bot.y - top.y) * v - py
    const dxu = (q[1].x - q[0].x) * (1 - v) + (q[2].x - q[3].x) * v
    const dyu = (q[1].y - q[0].y) * (1 - v) + (q[2].y - q[3].y) * v
    const dxv = bot.x - top.x, dyv = bot.y - top.y
    const det = dxu * dyv - dxv * dyu
    if (!det) return null
    u -= (fx * dyv - dxv * fy) / det
    v -= (dxu * fy - fx * dyu) / det
    if (u < -0.5 || u > 1.5 || v < -0.5 || v > 1.5) return null
  }
  return { u, v }
}

/** Half-size frame, matching the scanner's detection input. */
function downscaleFrame(frame) {
  const sw = Math.round(frame.width / 2), sh = Math.round(frame.height / 2)
  const corners = [
    { x: 0, y: 0 }, { x: frame.width, y: 0 },
    { x: frame.width, y: frame.height }, { x: 0, y: frame.height },
  ]
  const data = warpPerspectiveRGBA(frame.data, frame.width, frame.height, corners, sw, sh)
  return { data, width: sw, height: sh }
}

const SCENARIOS = [
  ['clean-table', { bg: 'table', skew: 8, degrade: (f) => f }],
  ['skewed', { bg: 'table', skew: 26, degrade: (f) => f }],
  ['dark-mat', { bg: 'dark', skew: 12, degrade: (f, rng) => ({ ...f, data: addNoise(scaleExposure(f.data, 0.45), rng, 12) }) }],
  ['red-mat', { bg: 'colored', skew: 12, degrade: (f) => f }],
  ['blur', { bg: 'table', skew: 12, degrade: (f) => ({ ...f, data: blurFrame(f, 3) }) }],
  ['glare', { bg: 'table', skew: 12, degrade: (f, rng) => ({ ...f, data: glareFrame(f, rng, 3) }) }],
  // Sleeved cards — the common real case. The sleeve adds a competing outer
  // quad, a plastic haze, and an elongated specular streak.
  ['sleeve', { bg: 'table', skew: 12, sleeve: true, degrade: (f) => f }],
  ['sleeve+pattern', { bg: 'pattern', skew: 12, sleeve: true, degrade: (f) => f }],
  ['pattern-mat', { bg: 'pattern', skew: 12, degrade: (f) => f }],
  ['artmat', { bg: 'artmat', skew: 12, degrade: (f) => f }],
  ['sleeve+artmat', { bg: 'artmat', skew: 12, sleeve: true, degrade: (f) => f }],
  ['sleeve+dark', { bg: 'dark', skew: 12, sleeve: true, degrade: (f, rng) => ({ ...f, data: addNoise(f.data, rng, 10) }) }],
]

/**
 * Mean per-corner distance between the detected quad and the TRUE card quad,
 * in frame px. This is the metric that exposes sleeve lock-on: finding "a"
 * quad is not the same as finding the CARD, and a detector that latches onto
 * the sleeve edge reports success while shifting every downstream crop
 * outward. Corner order from detectCardCorners is [TL,TR,BR,BL], matching how
 * buildFrame lays out its quad.
 */
function cornerError(detected, truth) {
  if (!detected || detected.length !== 4) return null
  let sum = 0
  for (let i = 0; i < 4; i++) sum += Math.hypot(detected[i].x - truth[i].x, detected[i].y - truth[i].y)
  return sum / 4
}

function blurFrame(frame, radius) {
  let src = new Float32Array(frame.data)
  const w = frame.width, h = frame.height
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
  src = pass(pass(src, true), false)
  return new Uint8ClampedArray(src)
}

function glareFrame(frame, rng, blobs) {
  const out = new Uint8ClampedArray(frame.data)
  for (let n = 0; n < blobs; n++) {
    const cx = frame.width * (0.3 + rng() * 0.4), cy = frame.height * (0.3 + rng() * 0.4)
    const r = 240 * (0.7 + rng() * 0.6), s = 245
    for (let y = Math.max(0, (cy - r) | 0); y < Math.min(frame.height, (cy + r) | 0); y++) {
      for (let x = Math.max(0, (cx - r) | 0); x < Math.min(frame.width, (cx + r) | 0); x++) {
        const d = Math.hypot(x - cx, y - cy) / r
        if (d >= 1) continue
        const add = s * (1 - d) * (1 - d)
        const p = (y * frame.width + x) * 4
        out[p] = Math.min(255, out[p] + add)
        out[p + 1] = Math.min(255, out[p + 1] + add)
        out[p + 2] = Math.min(255, out[p + 2] + add)
      }
    }
  }
  return out
}

async function main() {
  console.log(`Scan-pipeline harness — ${PROBE_COUNT} probes${QUICK ? ' (quick)' : ''}\n`)

  const manifest = JSON.parse(readFileSync(path.join(PACK_DIR, 'manifest.json'), 'utf8'))
  const store = new HashPackStore()
  for (const chunk of manifest.chunks) {
    const buf = readFileSync(path.join(PACK_DIR, chunk.file))
    store.appendChunkBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  }
  const matcher = createMatcher(store)
  console.log(`Loaded REAL pack: ${store.count} rows, format v${manifest.formatVersion}, hash v${manifest.hashVersion}`)
  matcher.match(new Uint32Array(8), null, null, {})   // build indexes off the clock
  console.log('Band indexes built.\n')

  console.log('Fetching probe cards…')
  const pool = await searchCards('e:dsk game:paper', QUICK ? 40 : 140)
  const rng = mulberry32(90210)
  const probes = []
  const used = new Set()
  while (probes.length < Math.min(PROBE_COUNT, pool.length)) {
    const i = Math.floor(rng() * pool.length)
    if (used.has(i)) continue
    used.add(i); probes.push(pool[i])
  }
  console.log(`  ${probes.length} probes\n`)

  const matchOpts = { broadFallbackOnWeak: true, weakDistance: MATCH_THRESHOLD, weakGap: MATCH_MIN_GAP }

  function tryMatch(card, variants, state, counters) {
    const fullHash = computeFullCardHash(card)
    for (const v of variants) {
      const t0 = performance.now()
      const art = cropArtRegion(card, v)
      if (!isUsableArtCrop(art)) { counters.unusableCrops++; continue }
      const hs = computeAllHashes(art, { tileGrid: 0 })
      counters.hashMs += performance.now() - t0
      counters.variantsHashed++
      const queries = [
        { hash: hs.hash, label: 'standard' },
        ...(hs.foilHash ? [{ hash: hs.foilHash, label: 'foil' }] : []),
        ...(hs.darkHash ? [{ hash: hs.darkHash, label: 'dark' }] : []),
      ]
      const t1 = performance.now()
      const r = matcher.matchAll(queries, hs.colorHash, fullHash, matchOpts)
      counters.matchMs += performance.now() - t1
      counters.matchCalls++
      if (r.best && (!state.best || r.best.distance < state.best.distance)) {
        state.best = r.best
        state.second = r.second
        state.diffGap = r.diffGap ?? 0
      }
      if (isDecisive(state.best, state.diffGap)) return true
    }
    return false
  }

  function runLadder(card, state, counters) {
    const expand = () => !state.best || state.best.distance > MATCH_THRESHOLD || state.diffGap < MATCH_MIN_GAP
    const marginal = () => !state.best || state.best.distance > MATCH_STRONG_THRESHOLD || state.diffGap < MATCH_MIN_GAP
    counters.rungs.fast++
    if (tryMatch(card, FAST_PRIMARY_VARIANTS, state, counters)) return
    if (expand()) { counters.rungs.primary++; if (tryMatch(card, PRIMARY_CROP_VARIANTS.slice(1), state, counters)) return }
    if (marginal()) { counters.rungs.marginal++; if (tryMatch(card, MARGINAL_CROP_VARIANTS, state, counters)) return }
    if (expand()) {
      const rot = rotateCard180(card)
      counters.rungs.rot180++
      if (tryMatch(rot, FAST_PRIMARY_VARIANTS, state, counters)) return
      if (expand() && tryMatch(rot, PRIMARY_CROP_VARIANTS.slice(1), state, counters)) return
      if (marginal()) tryMatch(rot, MARGINAL_CROP_VARIANTS, state, counters)
    }
  }

  const results = {}
  let n = 0
  for (const probe of probes) {
    let base
    try { base = await fetchImageCached(probe) } catch { continue }

    for (const [scen, cfg] of SCENARIOS) {
      const cell = (results[scen] ??= {
        scans: 0, detected: 0, reticleUsed: 0, reticleRerun: 0, decisiveFrame1: 0,
        accepted: 0, correctName: 0, correctPrint: 0,
        samples: [], variants: [], matches: [], detectMs: [], hashMs: [], matchMs: [], warpMs: [],
        rungs: { fast: 0, primary: 0, marginal: 0, rot180: 0 }, unusableCrops: 0, cornerErrors: [],
      })
      const counters = {
        variantsHashed: 0, matchCalls: 0, hashMs: 0, matchMs: 0, detectMs: 0, warpMs: 0,
        unusableCrops: 0, rungs: { fast: 0, primary: 0, marginal: 0, rot180: 0 },
      }

      const votes = new Map()
      let bestObserved = null, bestObservedGap = 0, bestObservedCluster = false
      let samples = 0, detectedAny = false, reticleUsedAny = false, reticleRerun = false
      let decisiveOnFirst = false

      for (let i = 0; i < STABILITY_SAMPLES; i++) {
        samples++
        const sRng = mulberry32(probe.scryfall_id.charCodeAt(0) * 7919 + scen.length * 131 + i * 17)
        const raw = buildFrame(base, sRng, cfg)
        const frame = cfg.degrade(raw, sRng)
        const small = downscaleFrame(frame)

        // ── Real detection ────────────────────────────────────────────────
        const td = performance.now()
        const cornersSmall = detectCardCorners(small, small.width, small.height)
        counters.detectMs += performance.now() - td

        const state = { best: null, second: null, diffGap: 0 }
        let usedReticle = false
        if (cornersSmall?.length === 4) {
          detectedAny = true
          const sx = frame.width / small.width, sy = frame.height / small.height
          const corners = cornersSmall.map(p => ({ x: p.x * sx, y: p.y * sy }))
          // Did it find the CARD, or the sleeve around it? Compared against the
          // known card quad — the sleeve sits ~SLEEVE_MARGIN outside it.
          const err = cornerError(corners, raw.quad)
          if (err != null) cell.cornerErrors.push(err)
          const tw = performance.now()
          const card = warpCard(frame, corners)
          counters.warpMs += performance.now() - tw
          if (card) runLadder(card, state, counters)
        }
        // Manual-scan reticle path: fires when detection failed OR the corner
        // result is merely non-decisive (review finding 1).
        const weak = !state.best || state.best.distance > MATCH_THRESHOLD || state.diffGap < MATCH_MIN_GAP
        if (weak) {
          if (cornersSmall?.length === 4) reticleRerun = true
          const tw = performance.now()
          const card = cropCardFromReticle(frame, frame.width, frame.height, FRAME_W, FRAME_H)
          counters.warpMs += performance.now() - tw
          if (card) { usedReticle = true; runLadder(card, state, counters) }
        }
        if (usedReticle) reticleUsedAny = true

        if (state.best && (!bestObserved || state.best.distance < bestObserved.distance)) {
          bestObserved = state.best
          bestObservedGap = state.diffGap
          bestObservedCluster = !!(state.second?.name && normName(state.best.name) === normName(state.second.name))
        }
        const found = state.best && state.best.distance <= MATCH_THRESHOLD &&
          (state.diffGap >= MATCH_MIN_GAP || (state.second?.name && normName(state.best.name) === normName(state.second.name)))
        if (found) {
          const prev = votes.get(state.best.id) ?? { count: 0, best: state.best }
          votes.set(state.best.id, { count: prev.count + 1, best: state.best })
        }
        if (i === 0 && isDecisive(state.best, state.diffGap)) decisiveOnFirst = true
        const top = [...votes.values()].sort((a, b) => b.count - a.count)[0]
        if (top?.count >= STABILITY_REQUIRED) break
        if (isDecisive(state.best, state.diffGap)) break
      }

      const top = [...votes.values()].sort((a, b) => b.count - a.count)[0]
      const chosen = top?.best ?? bestObserved
      const accepted = shouldAcceptMatch({
        best: chosen, gap: bestObservedGap,
        stableCount: top?.count ?? 0, sameNameCluster: bestObservedCluster,
      })

      cell.scans++
      if (detectedAny) cell.detected++
      if (reticleUsedAny) cell.reticleUsed++
      if (reticleRerun) cell.reticleRerun++
      if (decisiveOnFirst) cell.decisiveFrame1++
      cell.samples.push(samples)
      cell.variants.push(counters.variantsHashed)
      cell.matches.push(counters.matchCalls)
      cell.detectMs.push(counters.detectMs)
      cell.hashMs.push(counters.hashMs)
      cell.matchMs.push(counters.matchMs)
      cell.warpMs.push(counters.warpMs)
      cell.unusableCrops += counters.unusableCrops
      for (const k in counters.rungs) cell.rungs[k] += counters.rungs[k]
      if (accepted) {
        cell.accepted++
        // Two metrics, and NEITHER is the ideal one. Name-only is too generous:
        // a same-name DIFFERENT-ART card counts as a hit. Exact printing is too
        // strict: a same-art reprint in another set is deliberately NOT an error
        // (the art hash cannot distinguish them — that is what collector-line
        // OCR is for). Art identity (name + illustration_id) is what the
        // tile/colour harnesses scored on and is the right metric, but the hash
        // pack does not carry illustration_id (rows are id/name/setCode/collNum
        // /flavorName), so it cannot be computed here. True accuracy sits
        // between these two columns.
        if (chosen?.name === probe.name) cell.correctName++
        if (chosen?.id === probe.scryfall_id) cell.correctPrint++
      }
    }
    if (++n % 5 === 0) console.log(`  ${n}/${probes.length} probes`)
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const p50 = a => percentile(a, 0.5)
  const pc = (a, b) => b ? `${(100 * a / b).toFixed(0)}%` : '—'

  console.log('\n══ DETECTION (the trustworthy half — not affected by self-match) ══')
  console.log('Corner error = mean px between the detected quad and the TRUE card quad.')
  console.log(`A sleeve sits ~${(SLEEVE_MARGIN * 100).toFixed(1)}% outside the card — on a ${CARD_DRAW_H}px-tall card that is ~${Math.round(CARD_DRAW_H * SLEEVE_MARGIN / 2)}px per edge,`)
  console.log('so a jump to roughly that magnitude means the detector locked onto the SLEEVE.')
  console.log(`  ${'scenario'.padEnd(15)}${'quad found'.padEnd(12)}${'reticle'.padEnd(10)}${'corner err'.padEnd(12)}detect ms`)
  for (const [scen] of SCENARIOS) {
    const c = results[scen]; if (!c) continue
    const err = c.cornerErrors.length ? `${p50(c.cornerErrors).toFixed(1)}px` : '—'
    console.log(`  ${scen.padEnd(15)}${pc(c.detected, c.scans).padEnd(12)}${pc(c.reticleUsed, c.scans).padEnd(10)}${err.padEnd(12)}${p50(c.detectMs).toFixed(0)}ms`)
  }

  console.log('\n══ WORK PER SCAN (real 111k pack) ══')
  console.log(`  ${'scenario'.padEnd(15)}${'samples'.padEnd(9)}${'variants'.padEnd(10)}${'matches'.padEnd(9)}${'warp'.padEnd(8)}${'hash'.padEnd(8)}${'match'.padEnd(9)}decisive f1`)
  for (const [scen] of SCENARIOS) {
    const c = results[scen]; if (!c) continue
    console.log(`  ${scen.padEnd(15)}${p50(c.samples).toFixed(0).padEnd(9)}${p50(c.variants).toFixed(0).padEnd(10)}${p50(c.matches).toFixed(0).padEnd(9)}${`${p50(c.warpMs).toFixed(0)}ms`.padEnd(8)}${`${p50(c.hashMs).toFixed(0)}ms`.padEnd(8)}${`${p50(c.matchMs).toFixed(0)}ms`.padEnd(9)}${pc(c.decisiveFrame1, c.scans)}`)
  }

  console.log('\n══ REVIEW FINDING 1 — reticle ladder re-run after a SUCCESSFUL detect ══')
  for (const [scen] of SCENARIOS) {
    const c = results[scen]; if (!c) continue
    console.log(`  ${scen.padEnd(15)}${pc(c.reticleRerun, c.scans)} of scans`)
  }

  console.log('\n══ ACCURACY — true value sits BETWEEN these columns (see code comment) ══')
  console.log(`  ${'scenario'.padEnd(15)}${'accepted'.padEnd(11)}${'name (generous)'.padEnd(18)}exact print (strict)`)
  for (const [scen] of SCENARIOS) {
    const c = results[scen]; if (!c) continue
    console.log(`  ${scen.padEnd(15)}${pc(c.accepted, c.scans).padEnd(11)}${pc(c.correctName, c.scans).padEnd(18)}${pc(c.correctPrint, c.scans)}`)
  }

  console.log('\n══ LADDER RUNGS ENTERED (summed) ══')
  for (const [scen] of SCENARIOS) {
    const c = results[scen]; if (!c) continue
    console.log(`  ${scen.padEnd(15)}fast ${String(c.rungs.fast).padEnd(5)}primary ${String(c.rungs.primary).padEnd(5)}marginal ${String(c.rungs.marginal).padEnd(5)}rot180 ${String(c.rungs.rot180).padEnd(5)}unusable crops ${c.unusableCrops}`)
  }

  console.log('\nReminder: hash-match difficulty here is NOT realistic (probes are self-matches')
  console.log('against a pack seeded from the same renders). Detection numbers are real.')
  console.log('Capture (~250ms × samples, native), worker overhead and phone CPU are not measured.')
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })

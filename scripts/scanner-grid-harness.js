/**
 * scanner-grid-harness.js — tile-grid A/B experiment for hash pipeline v8
 *
 * Decides the TILE_GRID constant empirically instead of by argument. Finer
 * grids discriminate lookalike arts better (dense-tree Forests, gate cycles)
 * until per-tile signal runs out and warp misalignment moves content across
 * tile boundaries — where that crossover sits depends on this pipeline's
 * exact math, so we measure it.
 *
 * What it does:
 *   1. Downloads real Scryfall renders: every Forest/Island printing (the
 *      worst-case lookalike pool), gate cycles, plus a modern-set distractor
 *      pool. Images cache in node_modules/.cache/scanner-harness/.
 *   2. Builds one reference store per config (baseline v7 / 2×2 / 3×3 / 4×4)
 *      through the REAL seed path (computeSeedHashes → encodeHashPack →
 *      HashPackStore → createMatcher).
 *   3. Simulates degraded captures from the renders: corner-detection error
 *      (perspective jitter via warpPerspectiveRGBA), Gaussian blur, specular
 *      glare blobs, sensor noise, under-exposure — the same failure modes the
 *      live scanner sees, built from the same visionCore primitives.
 *   4. Scores every config on every scenario: exact-print top-1, name top-1,
 *      and the mean different-name gap (confidence margin). Also measures
 *      3-frame per-bit fusion (hashFusion.js) on the glare scenario.
 *
 * Usage:
 *   node scripts/scanner-grid-harness.js [--quick] [--probes N]
 *
 * Read the table, set TILE_GRID in src/scanner/constants.js to the winner,
 * then run generate-card-hashes.js --reseed.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fetch from 'node-fetch'
import sharp from 'sharp'
import { CARD_W, CARD_H, ART_X, ART_Y, ART_W, ART_H } from '../src/scanner/constants.js'
import { computeSeedHashes } from '../src/scanner/hashCard.js'
import { encodeHashPack, HashPackStore } from '../src/scanner/hashPack.js'
import { createMatcher, tileKeepCount } from '../src/scanner/matchCore.js'
import { hexToHash, hammingDistance } from '../src/scanner/hashCore.js'
import { fuseFrameHashes } from '../src/scanner/hashFusion.js'
import { warpPerspectiveRGBA } from '../src/scanner/visionCore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = path.join(__dirname, '..', 'node_modules', '.cache', 'scanner-harness')
const UA = { 'User-Agent': 'DeckLoomGridHarness/1.0', Accept: '*/*' }

const QUICK = process.argv.includes('--quick')
const probesArgIdx = process.argv.indexOf('--probes')
const PROBE_COUNT = probesArgIdx !== -1
  ? Math.max(20, parseInt(process.argv[probesArgIdx + 1], 10) || 200)
  : (QUICK ? 80 : 220)

const GRIDS = [0, 2, 3, 4]   // 0 = v7 baseline (no tiles)

// ── Deterministic RNG ────────────────────────────────────────────────────────

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── Scryfall fetch (search API, cached images) ──────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function searchCards(query, cap) {
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

async function fetchImageCached(card) {
  mkdirSync(CACHE_DIR, { recursive: true })
  const key = createHash('sha1').update(card.imageUri).digest('hex')
  const file = path.join(CACHE_DIR, `${key}.jpg`)
  if (!existsSync(file)) {
    const res = await fetch(card.imageUri, { headers: UA, timeout: 20000 })
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
function jitterWarp(rgba, rng, e) {
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
function addGlare(rgba, rng, { blobs = 1, radius = 130, strength = 230 } = {}) {
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

function addNoise(rgba, rng, amp) {
  if (!amp) return rgba
  const out = new Uint8ClampedArray(rgba)
  for (let i = 0; i < out.length; i += 4) {
    const n = (rng() * 2 - 1) * amp
    out[i] += n; out[i + 1] += n; out[i + 2] += n
  }
  return out
}

function scaleExposure(rgba, factor) {
  if (factor === 1) return rgba
  const out = new Uint8ClampedArray(rgba)
  for (let i = 0; i < out.length; i += 4) {
    out[i] *= factor; out[i + 1] *= factor; out[i + 2] *= factor
  }
  return out
}

/** Cheap separable box-blur ×3 ≈ Gaussian; radius in px. */
function blurRGBA(rgba, radius) {
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
function lowRes(rgba, factor) {
  const w = Math.round(CARD_W * factor), h = Math.round(CARD_H * factor)
  const cornersDown = [
    { x: 0, y: 0 }, { x: CARD_W, y: 0 }, { x: CARD_W, y: CARD_H }, { x: 0, y: CARD_H },
  ]
  const small = warpPerspectiveRGBA(rgba, CARD_W, CARD_H, cornersDown, w, h)
  const cornersUp = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]
  return warpPerspectiveRGBA(small, w, h, cornersUp, CARD_W, CARD_H) ?? rgba
}

// Scenario list: name → per-probe transform. Jitter is the misalignment
// variable the grid choice hinges on; glare/noise/blur/exposure/low-res are
// the robustness checks that punish over-fine grids. Deliberately harsher
// than typical captures — at mild degradation every config sits at 100% and
// the experiment can't discriminate.
const SCENARIOS = [
  ['clean-j1',   (rgba, rng) => jitterWarp(rgba, rng, 1)],
  ['jitter4',    (rgba, rng) => jitterWarp(rgba, rng, 4)],
  ['jitter8',    (rgba, rng) => jitterWarp(rgba, rng, 8)],
  ['lowres45',   (rgba, rng) => lowRes(jitterWarp(rgba, rng, 3), 0.45)],
  ['blur+j3',    (rgba, rng) => blurRGBA(jitterWarp(rgba, rng, 3), 3)],
  ['glare2+jit', (rgba, rng) => addGlare(jitterWarp(rgba, rng, 4), rng, { blobs: 2, strength: 250 })],
  ['dark+noise', (rgba, rng) => addNoise(scaleExposure(jitterWarp(rgba, rng, 3), 0.45), rng, 14)],
]

// ── Matching helpers ─────────────────────────────────────────────────────────

function buildConfig(rows, grid) {
  const store = new HashPackStore()
  const CHUNK = 6000
  for (let i = 0; i < rows.length; i += CHUNK) {
    store.appendChunkBuffer(encodeHashPack(rows.slice(i, i + CHUNK), 8, { tileGrid: grid }))
  }
  return { grid, store, matcher: createMatcher(store) }
}

function toQueries(hashes, grid) {
  const q = {
    hash: hexToHash(hashes.phash_hex),
    colorHash: hexToHash(hashes.phash_hex2),
    fullHash: hexToHash(hashes.phash_full_hex),
    tileQuery: null,
  }
  if (grid > 0 && hashes.phash_tiles_hex) {
    q.tileQuery = new Uint32Array(grid * grid * 8)
    hashes.phash_tiles_hex.forEach((hex, t) => q.tileQuery.set(hexToHash(hex), t * 8))
  }
  return q
}

function matchOne(config, q) {
  return config.matcher.match(q.hash, q.colorHash, q.fullHash, {
    broadFallbackOnWeak: true,
    ...(q.tileQuery ? { tileQuery: q.tileQuery } : {}),
  })
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Tile-grid harness — ${PROBE_COUNT} probes${QUICK ? ' (quick)' : ''}\n`)

  console.log('Fetching card lists from Scryfall…')
  const pools = await Promise.all([
    searchCards('!"Forest" t:basic game:paper', QUICK ? 160 : 420),
    searchCards('!"Island" t:basic game:paper', QUICK ? 60 : 180),
    searchCards('t:gate game:paper', QUICK ? 50 : 140),
    searchCards('e:fdn game:paper', QUICK ? 120 : 320),
  ])
  const [forests, islands, gates, distractors] = pools
  const seen = new Set()
  const cards = [...forests, ...islands, ...gates, ...distractors]
    .filter(c => !seen.has(c.scryfall_id) && seen.add(c.scryfall_id))
  console.log(`  ${forests.length} Forests, ${islands.length} Islands, ${gates.length} gates, ${distractors.length} distractors → ${cards.length} unique cards`)

  console.log('Downloading + hashing reference renders (cached after first run)…')
  const renders = new Map()   // scryfall_id → RGBA render
  const rowsByGrid = new Map(GRIDS.map(g => [g, []]))
  let done = 0, failed = 0
  for (const card of cards) {
    try {
      const rgba = await fetchImageCached(card)
      renders.set(card.scryfall_id, rgba)
      for (const grid of GRIDS) {
        rowsByGrid.get(grid).push({ ...card, ...computeSeedHashes(rgba, { tileGrid: grid }) })
      }
    } catch (e) {
      failed++
      if (failed <= 10) console.warn(`  x ${card.name} [${card.set_code}]: ${e.message}`)
    }
    if (++done % 100 === 0) console.log(`  ${done}/${cards.length}`)
  }
  console.log(`  hashed ${renders.size} cards (${failed} failed)\n`)

  const configs = GRIDS.map(g => buildConfig(rowsByGrid.get(g), g))

  // Success metric: same name AND same illustration. Same-art reprints in a
  // different set are NOT errors (the art carries no set information — and
  // the user explicitly doesn't care); picking a lookalike art IS the error
  // class this harness exists to measure.
  const illustById = new Map(cards.map(c => [c.scryfall_id, c.illustration_id]))
  const isArtHit = (best, probe) =>
    !!best && best.name === probe.name && illustById.get(best.id) === probe.illustration_id

  // Lookalike margin — THE decision metric. Accuracy saturates at 100% under
  // simulated degradation (probes share the reference imaging chain), but the
  // margin between the correct art and the nearest same-name DIFFERENT-art
  // candidate quantifies the headroom that survives real capture noise —
  // exactly the quantity that fails on dense-tree Forests. Combined-distance
  // formula replicated from matchCore (weights + best-k tile mean).
  // Pools carry PRE-PARSED hashes — the margin scan runs per probe × scenario
  // × config over hundreds of same-name rows; re-parsing hex there would
  // dominate the whole run.
  const namePoolByGrid = new Map(GRIDS.map(g => {
    const pools = new Map()
    for (const row of rowsByGrid.get(g)) {
      if (!pools.has(row.name)) pools.set(row.name, [])
      pools.get(row.name).push({
        illustration_id: row.illustration_id,
        luma: hexToHash(row.phash_hex),
        color: hexToHash(row.phash_hex2),
        full: hexToHash(row.phash_full_hex),
        tiles: row.phash_tiles_hex ? row.phash_tiles_hex.map(hexToHash) : null,
      })
    }
    return [g, pools]
  }))

  const FULL_SCALE = 1.14
  const combinedDist = (row, q, grid) => {
    const art = hammingDistance(q.hash, row.luma)
    const color = hammingDistance(q.colorHash, row.color)
    const full = hammingDistance(q.fullHash, row.full)
    if (grid > 0 && row.tiles && q.tileQuery) {
      const keep = tileKeepCount(row.tiles.length)
      const dists = row.tiles.map((tile, t) =>
        hammingDistance(q.tileQuery.subarray(t * 8, t * 8 + 8), tile))
      dists.sort((a, b) => a - b)
      let tile = 0
      for (let t = 0; t < keep; t++) tile += dists[t]
      tile /= keep
      return 0.15 * art + 0.30 * tile + 0.20 * color + 0.35 * FULL_SCALE * full
    }
    return 0.45 * art + 0.20 * color + 0.35 * FULL_SCALE * full
  }

  const lookalikeMargin = (config, q, probe) => {
    const pool = namePoolByGrid.get(config.grid).get(probe.name)
    if (!pool) return null
    let dCorrect = Infinity, dWrong = Infinity
    for (const row of pool) {
      const d = combinedDist(row, q, config.grid)
      if (row.illustration_id === probe.illustration_id) { if (d < dCorrect) dCorrect = d }
      else if (d < dWrong) dWrong = d
    }
    if (!Number.isFinite(dCorrect) || !Number.isFinite(dWrong)) return null
    return dWrong - dCorrect
  }

  // Probe selection: seeded, lookalike-heavy (that's the problem under test).
  const rng = mulberry32(1337)
  const pick = (pool, n) => {
    const available = pool.filter(c => renders.has(c.scryfall_id))
    const out = []
    const used = new Set()
    while (out.length < Math.min(n, available.length)) {
      const i = Math.floor(rng() * available.length)
      if (used.has(i)) continue
      used.add(i)
      out.push(available[i])
    }
    return out
  }
  const probes = [
    ...pick(forests, Math.round(PROBE_COUNT * 0.45)),
    ...pick(islands, Math.round(PROBE_COUNT * 0.15)),
    ...pick(gates, Math.round(PROBE_COUNT * 0.15)),
    ...pick(distractors, Math.round(PROBE_COUNT * 0.25)),
  ]
  console.log(`Probing with ${probes.length} cards × ${SCENARIOS.length} scenarios × ${configs.length} configs…\n`)

  // results[scenario][grid] = { print, name, total, gapSum, gapN }
  const results = {}
  const fusionResults = new Map(GRIDS.map(g => [g, { print: 0, name: 0, total: 0 }]))

  for (const probe of probes) {
    const rgba = renders.get(probe.scryfall_id)
    for (const [scenario, degrade] of SCENARIOS) {
      const scenarioRng = mulberry32(probe.scryfall_id.charCodeAt(0) * 7919 + scenario.length * 101)
      const degraded = degrade(rgba, scenarioRng)
      results[scenario] ??= {}
      for (const config of configs) {
        const hashes = computeSeedHashes(degraded, { tileGrid: config.grid })
        const q = toQueries(hashes, config.grid)
        const r = matchOne(config, q)
        const cell = (results[scenario][config.grid] ??= { print: 0, name: 0, total: 0, margins: [] })
        cell.total++
        if (isArtHit(r.best, probe)) cell.print++
        if (r.best?.name === probe.name) cell.name++
        const margin = lookalikeMargin(config, q, probe)
        if (margin != null) cell.margins.push(margin)
      }
    }

    // 3-frame fusion on fresh glare draws (different blob positions per frame).
    const frameRng = mulberry32(probe.scryfall_id.charCodeAt(2) * 31337 + 7)
    const frames = [0, 1, 2].map(() => addGlare(jitterWarp(rgba, frameRng, 3), frameRng, { blobs: 2 }))
    for (const config of configs) {
      const frameHashes = frames.map(f => {
        const hs = computeSeedHashes(f, { tileGrid: config.grid })
        const q = toQueries(hs, config.grid)
        return {
          hash: Array.from(q.hash),
          colorHash: Array.from(q.colorHash),
          fullHash: Array.from(q.fullHash),
          tileHashes: q.tileQuery ? Array.from(q.tileQuery) : null,
        }
      })
      const fused = fuseFrameHashes(frameHashes)
      const q = {
        hash: new Uint32Array(fused.hash),
        colorHash: new Uint32Array(fused.colorHash),
        fullHash: new Uint32Array(fused.fullHash),
        tileQuery: fused.tileHashes ? new Uint32Array(fused.tileHashes) : null,
      }
      const r = matchOne(config, q)
      const cell = fusionResults.get(config.grid)
      cell.total++
      if (isArtHit(r.best, probe)) cell.print++
      if (r.best?.name === probe.name) cell.name++
      // Margin comparison: fused query vs each single glare frame — does the
      // per-bit majority vote actually buy back lookalike headroom?
      cell.margins ??= []; cell.singleMargins ??= []
      const fusedMargin = lookalikeMargin(config, q, probe)
      if (fusedMargin != null) {
        cell.margins.push(fusedMargin)
        for (const fh of frameHashes) {
          const singleQ = {
            hash: new Uint32Array(fh.hash),
            colorHash: new Uint32Array(fh.colorHash),
            fullHash: new Uint32Array(fh.fullHash),
            tileQuery: fh.tileHashes ? new Uint32Array(fh.tileHashes) : null,
          }
          const m = lookalikeMargin(config, singleQ, probe)
          if (m != null) cell.singleMargins.push(m)
        }
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const pct = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : '—'
  const label = g => g === 0 ? 'v7 base' : `${g}×${g}`
  const p10 = arr => {
    if (!arr.length) return NaN
    const s = [...arr].sort((a, b) => a - b)
    return s[Math.floor(s.length * 0.10)]
  }
  const mean = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : NaN

  console.log('Art top-1 / lookalike margin mean / margin p10 (margin = nearest same-name')
  console.log('wrong-art distance − correct-art distance; higher = more real-world headroom):')
  console.log(`  ${'scenario'.padEnd(12)}${GRIDS.map(g => label(g).padEnd(26)).join('')}`)
  for (const [scenario] of SCENARIOS) {
    const row = GRIDS.map(g => {
      const c = results[scenario][g]
      return `${pct(c.print, c.total)}  m${mean(c.margins).toFixed(1)} p${p10(c.margins).toFixed(1)}`.padEnd(26)
    })
    console.log(`  ${scenario.padEnd(12)}${row.join('')}`)
  }
  console.log('\n3-frame fusion on glare2+jit3 (art top-1, fused margin vs single-frame margin):')
  console.log(`  ${'fused'.padEnd(12)}${GRIDS.map(g => {
    const c = fusionResults.get(g)
    return `${pct(c.print, c.total)}  m${mean(c.margins ?? []).toFixed(1)} vs ${mean(c.singleMargins ?? []).toFixed(1)}`.padEnd(26)
  }).join('')}`)

  // Composites. Accuracy saturates by design; the margin p10 across all
  // scenarios is the decision number (worst-decile headroom on lookalikes).
  console.log('\nComposites:')
  const stats = GRIDS.map(g => {
    let printSum = 0, n = 0
    const allMargins = []
    for (const [scenario] of SCENARIOS) {
      const c = results[scenario][g]
      printSum += c.print / c.total; n++
      allMargins.push(...c.margins)
    }
    return { g, acc: printSum / n, mMean: mean(allMargins), mP10: p10(allMargins) }
  })
  for (const s of stats) {
    console.log(`  ${label(s.g).padEnd(10)}acc ${(100 * s.acc).toFixed(2)}%   margin mean ${s.mMean.toFixed(2)}   margin p10 ${s.mP10.toFixed(2)}`)
  }
  // Winner: best p10 margin among configs within 0.5% of the best accuracy.
  const accBest = Math.max(...stats.map(s => s.acc))
  const eligible = stats.filter(s => s.acc >= accBest - 0.005)
  const winner = eligible.reduce((a, b) => (b.mP10 > a.mP10 ? b : a))
  console.log(`\n→ Winner: ${label(winner.g)}${winner.g > 0 ? ` — set TILE_GRID = ${winner.g} in src/scanner/constants.js` : ' (tiles not worth it?!)'}`)
}

main().then(() => process.exit(0)).catch(e => {
  console.error(e)
  process.exit(1)
})

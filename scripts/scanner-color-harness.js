/**
 * scanner-color-harness.js — colour-signal A/B for the hash pipeline
 *
 * Question under test, from the Moss Machines MTG sorter write-up: it computes
 * "separate hashes for Red, Green, and Blue channels" where we compute one
 * saturation hash (phash_hex2). Saturation keeps *how colourful* a region is
 * and throws away *which hue* — hue is exactly the signal that should separate
 * lookalike arts (dense-tree Forests, gate cycles). So per-channel hashes
 * ought to help.
 *
 * The reason it needs measuring rather than building: that sorter is a
 * mechanical rig with fixed LED lighting. A phone has auto-white-balance, and
 * a residual colour cast moves R and B relative to G — precisely the axis a
 * per-channel descriptor is built on. Saturation is comparatively cast-robust.
 * So the two effects pull opposite ways and the sign of the sum is empirical.
 *
 * What it does (deliberately mirrors scripts/scanner-grid-harness.js so the
 * numbers are comparable to the v8 tile verdict):
 *   1. Same lookalike-heavy Scryfall pool, same cached renders.
 *   2. Computes SIX descriptors per card: art luma, art saturation, art R,
 *      art G, art B, whole-card luma — each through the real
 *      computeHashFromGray (percentileCap → CLAHE → DCT → 256 bits).
 *   3. Auto-calibrates a per-signal scale from measured random-pair distances,
 *      so a challenger is not handicapped by FULL_SCALE-style hand tuning.
 *   4. Degrades probes with the shared capture model + three white-balance
 *      scenarios, and scores every weighting config on art top-1 and the
 *      lookalike margin (the decision metric).
 *
 * Matching here is a direct full-pool scan, not the LSH matcher: the band
 * indexes are built over the art and full-card hashes only, so the colour
 * signal cannot affect candidate generation and leaving the index out removes
 * a confound without changing what is being compared.
 *
 * Usage:
 *   node scripts/scanner-color-harness.js [--quick] [--probes N]
 *
 * Ship a challenger only if it beats `base` on margin p10 without losing
 * accuracy — same bar the tile experiment failed. Shipping one means a new
 * pack section, a format bump and a full --reseed.
 */

import {
  searchCards, fetchImageCached, mulberry32,
  jitterWarp, addGlare, addNoise, scaleExposure, whiteBalance, blurRGBA, lowRes,
  pct, mean, percentile,
} from './lib/scanner-harness-core.mjs'
import { CARD_W, CARD_H, ART_X, ART_Y, ART_W, ART_H } from '../src/scanner/constants.js'
import {
  computeHashFromGray, rgbToGray32x32, rgbToSaturation32x32, hammingDistance,
} from '../src/scanner/hashCore.js'
import { areaResizeRGBA, bilinearCropResize } from '../src/scanner/visionCore.js'

const QUICK = process.argv.includes('--quick')
const probesArgIdx = process.argv.indexOf('--probes')
const PROBE_COUNT = probesArgIdx !== -1
  ? Math.max(20, parseInt(process.argv[probesArgIdx + 1], 10) || 200)
  : (QUICK ? 80 : 220)

// ── Descriptors ──────────────────────────────────────────────────────────────

/** One 32×32 colour channel as a gray plane, for computeHashFromGray. */
function channel32x32(rgbData, channel) {
  const out = new Uint8Array(1024)
  for (let i = 0; i < 1024; i++) out[i] = rgbData[i * 4 + channel]
  return out
}

const SIGNALS = ['art', 'sat', 'r', 'g', 'b', 'full']

/** All six descriptors from a 500×700 RGBA card. Art crops match hashCard.js. */
function computeSignals(cardRGBA) {
  const art = bilinearCropResize(cardRGBA, CARD_W, CARD_H, ART_X, ART_Y, ART_W, ART_H, ART_W, ART_H)
  const art32 = areaResizeRGBA(art, ART_W, ART_H, 32, 32)
  const full32 = areaResizeRGBA(cardRGBA, CARD_W, CARD_H, 32, 32)
  return {
    art: computeHashFromGray(rgbToGray32x32(art32, 4)),
    sat: computeHashFromGray(rgbToSaturation32x32(art32, 4)),
    r: computeHashFromGray(channel32x32(art32, 0)),
    g: computeHashFromGray(channel32x32(art32, 1)),
    b: computeHashFromGray(channel32x32(art32, 2)),
    full: computeHashFromGray(rgbToGray32x32(full32, 4)),
  }
}

// ── Scenarios ────────────────────────────────────────────────────────────────

// The first seven are byte-identical to the tile harness. The last three are
// new: residual colour cast, the failure mode a per-channel descriptor is most
// exposed to. Gains are the size an imperfectly-corrected indoor scene leaves.
const SCENARIOS = [
  ['clean-j1', (rgba, rng) => jitterWarp(rgba, rng, 1)],
  ['jitter4', (rgba, rng) => jitterWarp(rgba, rng, 4)],
  ['jitter8', (rgba, rng) => jitterWarp(rgba, rng, 8)],
  ['lowres45', (rgba, rng) => lowRes(jitterWarp(rgba, rng, 3), 0.45)],
  ['blur+j3', (rgba, rng) => blurRGBA(jitterWarp(rgba, rng, 3), 3)],
  ['glare2+jit', (rgba, rng) => addGlare(jitterWarp(rgba, rng, 4), rng, { blobs: 2, strength: 250 })],
  ['dark+noise', (rgba, rng) => addNoise(scaleExposure(jitterWarp(rgba, rng, 3), 0.45), rng, 14)],
  ['wb-warm+j3', (rgba, rng) => whiteBalance(jitterWarp(rgba, rng, 3), { r: 1.14, g: 1.0, b: 0.86 })],
  ['wb-cool+j3', (rgba, rng) => whiteBalance(jitterWarp(rgba, rng, 3), { r: 0.88, g: 0.98, b: 1.16 })],
  ['wb-warm+gl', (rgba, rng) =>
    addGlare(whiteBalance(jitterWarp(rgba, rng, 3), { r: 1.14, g: 1.0, b: 0.86 }), rng, { blobs: 2 })],
]

// ── Weighting configs ────────────────────────────────────────────────────────

// `d` is the raw Hamming distance per signal; `s` the calibrated scale that
// puts each signal on the art hash's distance scale. `base` deliberately uses
// the SHIPPING constants (0.45/0.20/0.35 with FULL_SCALE 1.14) rather than the
// measured scale, so the incumbent in this table is the real thing;
// `base-cal` isolates how much the recalibration alone moves.
const SHIPPING_FULL_SCALE = 1.14

const rgbMean = (d, s) => (s.r * d.r + s.g * d.g + s.b * d.b) / 3
const rgbMax = (d, s) => Math.max(s.r * d.r, s.g * d.g, s.b * d.b)

const CONFIGS = [
  ['base', (d) => 0.45 * d.art + 0.20 * d.sat + 0.35 * SHIPPING_FULL_SCALE * d.full],
  ['base-cal', (d, s) => 0.45 * d.art + 0.20 * s.sat * d.sat + 0.35 * s.full * d.full],
  // RGB as a drop-in replacement for saturation, same weight budget.
  ['rgb-drop', (d, s) => 0.45 * d.art + 0.20 * rgbMean(d, s) + 0.35 * s.full * d.full],
  // Both colour descriptors, splitting the colour budget.
  ['rgb+sat', (d, s) => 0.45 * d.art + 0.10 * s.sat * d.sat + 0.10 * rgbMean(d, s) + 0.35 * s.full * d.full],
  // More colour weight, taken from the art hash.
  ['rgb-heavy', (d, s) => 0.35 * d.art + 0.30 * rgbMean(d, s) + 0.35 * s.full * d.full],
  // Worst-disagreeing channel instead of the mean — a different statistic, not
  // just a different weight: one badly-off channel is enough to reject.
  ['rgb-max', (d, s) => 0.45 * d.art + 0.20 * rgbMax(d, s) + 0.35 * s.full * d.full],
]

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Colour-signal harness — ${PROBE_COUNT} probes${QUICK ? ' (quick)' : ''}\n`)

  console.log('Fetching card lists from Scryfall…')
  const [forests, islands, gates, distractors] = await Promise.all([
    searchCards('!"Forest" t:basic game:paper', QUICK ? 160 : 420),
    searchCards('!"Island" t:basic game:paper', QUICK ? 60 : 180),
    searchCards('t:gate game:paper', QUICK ? 50 : 140),
    searchCards('e:fdn game:paper', QUICK ? 120 : 320),
  ])
  const seen = new Set()
  const cards = [...forests, ...islands, ...gates, ...distractors]
    .filter(c => !seen.has(c.scryfall_id) && seen.add(c.scryfall_id))
  console.log(`  ${forests.length} Forests, ${islands.length} Islands, ${gates.length} gates, ${distractors.length} distractors → ${cards.length} unique cards`)

  console.log('Downloading + hashing reference renders (cached after first run)…')
  const renders = new Map()
  const rows = []
  let done = 0, failed = 0
  for (const card of cards) {
    try {
      const rgba = await fetchImageCached(card)
      renders.set(card.scryfall_id, rgba)
      rows.push({ ...card, signals: computeSignals(rgba) })
    } catch (e) {
      failed++
      if (failed <= 10) console.warn(`  x ${card.name} [${card.set_code}]: ${e.message}`)
    }
    if (++done % 100 === 0) console.log(`  ${done}/${cards.length}`)
  }
  console.log(`  hashed ${rows.length} cards (${failed} failed)\n`)

  // ── Scale calibration ──────────────────────────────────────────────────────
  // Each descriptor has its own random inter-card distance scale (whole cards
  // share frame structure, so their hashes are closer than random; a single
  // colour channel is closer still). Weighting them before equalising those
  // scales would silently under-weight the tighter signals. Measured, not
  // assumed — the shipping FULL_SCALE 1.14 came from the same calculation.
  const calRng = mulberry32(24601)
  const randomMeans = Object.fromEntries(SIGNALS.map(k => [k, 0]))
  const PAIRS = Math.min(4000, rows.length * 8)
  let pairsUsed = 0
  for (let n = 0; n < PAIRS; n++) {
    const a = rows[Math.floor(calRng() * rows.length)]
    const b = rows[Math.floor(calRng() * rows.length)]
    if (a === b || a.name === b.name) continue   // same-name pairs are not "random"
    for (const k of SIGNALS) randomMeans[k] += hammingDistance(a.signals[k], b.signals[k])
    pairsUsed++
  }
  for (const k of SIGNALS) randomMeans[k] /= pairsUsed
  const scale = Object.fromEntries(SIGNALS.map(k => [k, randomMeans.art / randomMeans[k]]))
  console.log(`Random-pair distance means (${pairsUsed} pairs) and calibrated scales:`)
  for (const k of SIGNALS) {
    console.log(`  ${k.padEnd(5)} mean ${randomMeans[k].toFixed(1).padStart(6)}   scale ${scale[k].toFixed(3)}`)
  }
  console.log()

  // ── Probes ─────────────────────────────────────────────────────────────────
  const rng = mulberry32(1337)
  const pick = (pool, n) => {
    const available = pool.filter(c => renders.has(c.scryfall_id))
    const out = [], used = new Set()
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
  console.log(`Probing with ${probes.length} cards × ${SCENARIOS.length} scenarios × ${CONFIGS.length} configs…\n`)

  // results[scenario][configName] = { print, name, total, margins: [] }
  const results = {}
  // Raw distances for one probe against every row, computed once and reused by
  // every config — the configs differ only in how they weight these.
  const dist = { art: 0, sat: 0, r: 0, g: 0, b: 0, full: 0 }

  for (const probe of probes) {
    const rgba = renders.get(probe.scryfall_id)
    for (const [scenario, degrade] of SCENARIOS) {
      const scenarioRng = mulberry32(probe.scryfall_id.charCodeAt(0) * 7919 + scenario.length * 101)
      const q = computeSignals(degrade(rgba, scenarioRng))

      results[scenario] ??= {}
      const cells = CONFIGS.map(([name]) =>
        (results[scenario][name] ??= { print: 0, name: 0, total: 0, margins: [] }))

      // Per config: best row overall (top-1), plus best correct-art and best
      // wrong-art row within the probe's own name pool (the margin).
      const best = CONFIGS.map(() => ({ d: Infinity, row: null }))
      const dCorrect = CONFIGS.map(() => Infinity)
      const dWrong = CONFIGS.map(() => Infinity)

      for (const row of rows) {
        for (const k of SIGNALS) dist[k] = hammingDistance(q[k], row.signals[k])
        const sameName = row.name === probe.name
        const correctArt = sameName && row.illustration_id === probe.illustration_id
        for (let c = 0; c < CONFIGS.length; c++) {
          const d = CONFIGS[c][1](dist, scale)
          if (d < best[c].d) { best[c].d = d; best[c].row = row }
          if (sameName) {
            if (correctArt) { if (d < dCorrect[c]) dCorrect[c] = d }
            else if (d < dWrong[c]) dWrong[c] = d
          }
        }
      }

      for (let c = 0; c < CONFIGS.length; c++) {
        const cell = cells[c]
        const hit = best[c].row
        cell.total++
        // Same-art reprints in another set are NOT errors (the art carries no
        // set information); picking a lookalike art IS the error under test.
        if (hit?.name === probe.name) cell.name++
        if (hit?.name === probe.name && hit.illustration_id === probe.illustration_id) cell.print++
        if (Number.isFinite(dCorrect[c]) && Number.isFinite(dWrong[c])) {
          cell.margins.push(dWrong[c] - dCorrect[c])
        }
      }
    }
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  const names = CONFIGS.map(([n]) => n)
  const COL = 24
  console.log('Art top-1 / lookalike margin mean / margin p10 (margin = nearest same-name')
  console.log('wrong-art distance − correct-art distance; higher = more real-world headroom):')
  console.log(`  ${'scenario'.padEnd(12)}${names.map(n => n.padEnd(COL)).join('')}`)
  for (const [scenario] of SCENARIOS) {
    const row = names.map(n => {
      const c = results[scenario][n]
      return `${pct(c.print, c.total)}  m${mean(c.margins).toFixed(1)} p${percentile(c.margins, 0.10).toFixed(1)}`.padEnd(COL)
    })
    console.log(`  ${scenario.padEnd(12)}${row.join('')}`)
  }

  console.log('\nComposites (all scenarios pooled):')
  const stats = names.map(n => {
    let printSum = 0, k = 0
    const allMargins = []
    for (const [scenario] of SCENARIOS) {
      const c = results[scenario][n]
      printSum += c.print / c.total; k++
      allMargins.push(...c.margins)
    }
    return { n, acc: printSum / k, mMean: mean(allMargins), mP10: percentile(allMargins, 0.10) }
  })
  for (const s of stats) {
    console.log(`  ${s.n.padEnd(11)}acc ${(100 * s.acc).toFixed(2)}%   margin mean ${s.mMean.toFixed(2)}   margin p10 ${s.mP10.toFixed(2)}`)
  }

  // White-balance scenarios reported on their own: a challenger that wins
  // overall but collapses under a colour cast is not shippable to a phone.
  console.log('\nWhite-balance scenarios only:')
  const wb = SCENARIOS.filter(([s]) => s.startsWith('wb-')).map(([s]) => s)
  for (const n of names) {
    const m = []
    let printSum = 0
    for (const s of wb) { m.push(...results[s][n].margins); printSum += results[s][n].print / results[s][n].total }
    console.log(`  ${n.padEnd(11)}acc ${(100 * printSum / wb.length).toFixed(2)}%   margin mean ${mean(m).toFixed(2)}   margin p10 ${percentile(m, 0.10).toFixed(2)}`)
  }

  const baseStat = stats.find(s => s.n === 'base')
  const accBest = Math.max(...stats.map(s => s.acc))
  const eligible = stats.filter(s => s.acc >= accBest - 0.005)
  const winner = eligible.reduce((a, b) => (b.mP10 > a.mP10 ? b : a))
  console.log(`\n→ Best margin p10 among accuracy-eligible configs: ${winner.n} (${winner.mP10.toFixed(2)} vs base ${baseStat.mP10.toFixed(2)})`)
  console.log(winner.n === 'base' || winner.mP10 <= baseStat.mP10
    ? '  Verdict: colour-channel hashes do NOT beat the shipping saturation hash. Keep phash_hex2.'
    : '  Verdict: a colour-channel config leads — re-run at full probe count before acting on it.')
}

main().then(() => process.exit(0)).catch(e => {
  console.error(e)
  process.exit(1)
})

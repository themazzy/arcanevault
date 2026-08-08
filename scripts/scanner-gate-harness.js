/**
 * scanner-gate-harness.js — acceptance-gate A/B (fixed thresholds vs z-score)
 *
 * Question under test, from tmikonen's magic_card_detector write-up:
 *
 *     d_0_dist = (mean_of_others - min_distance) / std_dev
 *     recognised if d_0_dist > 4.0
 *
 * It accepts on a z-score against the whole distance distribution. We accept on
 * absolute constants (MATCH_THRESHOLD 122, MATCH_MIN_GAP 8, and the strong
 * tiers in CardScanner.jsx). The argument for the z-score is that absolute
 * thresholds assume a stable distance scale, and a blurry/dark/glared frame
 * compresses every distance toward the mean — so the true match drifts past 122
 * and is rejected even when it is still clearly the best row in the pool. A
 * self-calibrating gate should keep those.
 *
 * EXPERIMENT DESIGN — the part that makes this measurable:
 *
 * A looser gate always wins if every probe is a card that IS in the reference
 * pool. So the probe set has two disjoint halves:
 *   - IN-POOL   probes: the correct row exists. Accept+correct = true accept,
 *                       accept+wrong = wrong accept, reject = miss.
 *   - OUT-POOL  probes: cards held out of the reference pool entirely (no row
 *                       shares their name or illustration). ANY accept is a
 *                       false accept — this is what the fixed gates exist for.
 * Gates are then compared at MATCHED total error, not in isolation.
 *
 * KNOWN LIMIT, stated up front: a z-score's scale depends on the reference
 * pool's size and composition, and this pool is ~1k rows against production's
 * ~120k. Any winning threshold here would still need re-deriving against the
 * real pack before shipping. The pool is deliberately more diverse than the
 * tile/colour harnesses' lookalike-heavy one for the same reason — a gate has
 * to work on the whole collection, not just the Forest drawer.
 *
 * Usage:
 *   node scripts/scanner-gate-harness.js [--quick] [--probes N]
 */

import {
  searchCards, fetchImageCached, mulberry32,
  SURVIVABLE_SCENARIOS, SEVERE_SCENARIOS,
  mean as meanOf, percentile,
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
  : (QUICK ? 60 : 200)

// Production constants (CardScanner.jsx) — the incumbent gates.
const MATCH_THRESHOLD = 122
const MATCH_MIN_GAP = 8
const MATCH_STRONG_SINGLE = 108
const FULL_SCALE = 1.14

// ── Descriptors + shipping combined distance ────────────────────────────────

function computeSignals(cardRGBA) {
  const art = bilinearCropResize(cardRGBA, CARD_W, CARD_H, ART_X, ART_Y, ART_W, ART_H, ART_W, ART_H)
  const art32 = areaResizeRGBA(art, ART_W, ART_H, 32, 32)
  const full32 = areaResizeRGBA(cardRGBA, CARD_W, CARD_H, 32, 32)
  return {
    art: computeHashFromGray(rgbToGray32x32(art32, 4)),
    sat: computeHashFromGray(rgbToSaturation32x32(art32, 4)),
    full: computeHashFromGray(rgbToGray32x32(full32, 4)),
  }
}

const combined = (q, s) =>
  0.45 * hammingDistance(q.art, s.art) +
  0.20 * hammingDistance(q.sat, s.sat) +
  0.35 * FULL_SCALE * hammingDistance(q.full, s.full)

// ── Scenarios (the seven from the tile harness; white balance is not the
// question here, degradation severity is) ───────────────────────────────────

// Severe tier is included because the survivable seven saturate at ~100%
// accept for every gate and cannot show whether an adaptive gate rescues
// anything. The question only has content where scans actually fail.
const SCENARIOS = [...SURVIVABLE_SCENARIOS, ...SEVERE_SCENARIOS]

// ── Gates ────────────────────────────────────────────────────────────────────
// Each takes the per-scan observation and returns accept/reject.
//   bestDist  — combined distance of the winning row
//   gap       — bestDist to the nearest DIFFERENT-NAME row (exact here; the
//               production matchCore approximates it over its top-8)
//   zAll      — (mean of all other rows − bestDist) / std of all other rows
//   zTop      — same over the 50 nearest rows only, standing in for the
//               distribution the LSH prefilter would actually hand the gate
const FIXED_GATES = [
  ['fixed-prod', o => o.bestDist <= MATCH_THRESHOLD && o.gap >= MATCH_MIN_GAP],
  ['fixed-strong', o => o.bestDist <= MATCH_STRONG_SINGLE && o.gap >= MATCH_MIN_GAP],
]
const Z_SWEEP = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16]
const Z_FAMILIES = [
  ['z-all', (o, t) => o.zAll >= t],
  ['z-top50', (o, t) => o.zTop >= t],
  ['z-all+gap', (o, t) => o.zAll >= t && o.gap >= MATCH_MIN_GAP],
]

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Acceptance-gate harness — ${PROBE_COUNT} probes${QUICK ? ' (quick)' : ''}\n`)

  console.log('Fetching card lists from Scryfall…')
  // Reference pool: diverse (a gate must hold over the whole collection), with
  // a lookalike core retained so the wrong-accept class is still exercised.
  const [forests, islands, gates, fdn, dsk, blb] = await Promise.all([
    searchCards('!"Forest" t:basic game:paper', QUICK ? 40 : 110),
    searchCards('!"Island" t:basic game:paper', QUICK ? 25 : 60),
    searchCards('t:gate game:paper', QUICK ? 25 : 60),
    searchCards('e:fdn game:paper', QUICK ? 90 : 280),
    searchCards('e:dsk game:paper', QUICK ? 90 : 280),
    searchCards('e:blb game:paper', QUICK ? 80 : 250),
  ])
  // Held-out pool: must share no name and no artwork with the reference pool,
  // or an "unknown" probe would have a legitimate answer sitting in the pool.
  const heldRaw = await searchCards('e:otj game:paper', QUICK ? 90 : 260)

  const seen = new Set()
  const refCards = [...forests, ...islands, ...gates, ...fdn, ...dsk, ...blb]
    .filter(c => !seen.has(c.scryfall_id) && seen.add(c.scryfall_id))
  const refNames = new Set(refCards.map(c => c.name))
  const refIllust = new Set(refCards.map(c => c.illustration_id))
  const heldSeen = new Set()
  const heldCards = heldRaw.filter(c =>
    !refNames.has(c.name) && !refIllust.has(c.illustration_id) &&
    !heldSeen.has(c.scryfall_id) && heldSeen.add(c.scryfall_id))

  console.log(`  reference pool ${refCards.length} cards (${forests.length}F/${islands.length}I/${gates.length}gate + ${fdn.length + dsk.length + blb.length} diverse)`)
  console.log(`  held-out pool  ${heldCards.length} cards (from ${heldRaw.length} OTJ, after name+art exclusion)`)

  console.log('Downloading + hashing renders (cached after first run)…')
  const rows = []                 // reference store
  const renders = new Map()
  const heldRenders = new Map()
  let done = 0, failed = 0
  for (const card of refCards) {
    try {
      const rgba = await fetchImageCached(card)
      renders.set(card.scryfall_id, rgba)
      rows.push({ ...card, signals: computeSignals(rgba) })
    } catch { failed++ }
    if (++done % 200 === 0) console.log(`  ref ${done}/${refCards.length}`)
  }
  for (const card of heldCards) {
    try { heldRenders.set(card.scryfall_id, await fetchImageCached(card)) } catch { failed++ }
  }
  console.log(`  ${rows.length} reference rows, ${heldRenders.size} held-out cards (${failed} failed)\n`)

  // ── Probes ───────────────────────────────────────────────────────────────
  const rng = mulberry32(1337)
  const pick = (pool, n, have) => {
    const available = pool.filter(c => have.has(c.scryfall_id))
    const out = [], used = new Set()
    while (out.length < Math.min(n, available.length)) {
      const i = Math.floor(rng() * available.length)
      if (used.has(i)) continue
      used.add(i); out.push(available[i])
    }
    return out
  }
  const inProbes = [
    ...pick(forests, Math.round(PROBE_COUNT * 0.20), renders),
    ...pick(islands, Math.round(PROBE_COUNT * 0.10), renders),
    ...pick(gates, Math.round(PROBE_COUNT * 0.10), renders),
    ...pick([...fdn, ...dsk, ...blb], Math.round(PROBE_COUNT * 0.60), renders),
  ]
  const outProbes = pick(heldCards, Math.round(PROBE_COUNT * 0.6), heldRenders)
  console.log(`Probing ${inProbes.length} in-pool + ${outProbes.length} held-out × ${SCENARIOS.length} scenarios…\n`)

  /** Full-pool scan → the observation every gate is evaluated against. */
  function observe(queryRGBA, probe, isInPool) {
    const q = computeSignals(queryRGBA)
    const dists = new Float64Array(rows.length)
    let bestI = -1, bestD = Infinity, diffD = Infinity
    for (let i = 0; i < rows.length; i++) {
      const d = combined(q, rows[i].signals)
      dists[i] = d
      if (d < bestD) { bestD = d; bestI = i }
    }
    const bestRow = rows[bestI]
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].name !== bestRow.name && dists[i] < diffD) diffD = dists[i]
    }
    // mean/std over all rows EXCEPT the winner (tmikonen's "mean_of_others")
    let sum = 0, sumSq = 0
    for (let i = 0; i < rows.length; i++) {
      if (i === bestI) continue
      sum += dists[i]; sumSq += dists[i] * dists[i]
    }
    const n = rows.length - 1
    const mAll = sum / n
    const sdAll = Math.sqrt(Math.max(0, sumSq / n - mAll * mAll))
    // Same statistic over the 50 nearest rows — a stand-in for the truncated
    // distribution the LSH prefilter would hand a production implementation.
    const sorted = Float64Array.from(dists).sort()
    const K = Math.min(50, sorted.length - 1)
    let s2 = 0, sq2 = 0
    for (let i = 1; i <= K; i++) { s2 += sorted[i]; sq2 += sorted[i] * sorted[i] }
    const mTop = s2 / K
    const sdTop = Math.sqrt(Math.max(0, sq2 / K - mTop * mTop))
    return {
      bestDist: bestD,
      gap: diffD - bestD,
      zAll: sdAll > 0 ? (mAll - bestD) / sdAll : 0,
      zTop: sdTop > 0 ? (mTop - bestD) / sdTop : 0,
      correct: isInPool && bestRow.name === probe.name &&
               bestRow.illustration_id === probe.illustration_id,
    }
  }

  const observations = []   // { scenario, inPool, obs }
  let progress = 0
  for (const [probes, isInPool, store] of [[inProbes, true, renders], [outProbes, false, heldRenders]]) {
    for (const probe of probes) {
      const rgba = store.get(probe.scryfall_id)
      for (const [scenario, degrade] of SCENARIOS) {
        const sRng = mulberry32(probe.scryfall_id.charCodeAt(0) * 7919 + scenario.length * 101)
        observations.push({ scenario, inPool: isInPool, obs: observe(degrade(rgba, sRng), probe, isInPool) })
      }
      if (++progress % 50 === 0) console.log(`  ${progress}/${inProbes.length + outProbes.length} probes`)
    }
  }
  console.log()

  // ── Scoring ──────────────────────────────────────────────────────────────
  const inObs = observations.filter(o => o.inPool)
  const outObs = observations.filter(o => !o.inPool)

  function score(predicate) {
    let trueAccept = 0, wrongAccept = 0, miss = 0
    for (const { obs } of inObs) {
      if (!predicate(obs)) { miss++; continue }
      if (obs.correct) trueAccept++; else wrongAccept++
    }
    let falseAccept = 0
    for (const { obs } of outObs) if (predicate(obs)) falseAccept++
    return {
      trueAccept, wrongAccept, miss, falseAccept,
      taRate: trueAccept / inObs.length,
      waRate: wrongAccept / inObs.length,
      faRate: falseAccept / outObs.length,
      // Any accept that is not the right card, over all probes.
      errRate: (wrongAccept + falseAccept) / observations.length,
    }
  }

  const fmt = s => `TA ${(100 * s.taRate).toFixed(1)}%  wrong ${(100 * s.waRate).toFixed(2)}%  false ${(100 * s.faRate).toFixed(2)}%  err ${(100 * s.errRate).toFixed(2)}%`

  console.log(`Scans: ${inObs.length} in-pool, ${outObs.length} held-out\n`)
  console.log('Incumbent fixed gates:')
  const fixedScores = FIXED_GATES.map(([name, fn]) => {
    const s = score(fn)
    console.log(`  ${name.padEnd(14)}${fmt(s)}`)
    return { name, s }
  })

  console.log('\nz-score sweep:')
  const zScores = []
  for (const [family, fn] of Z_FAMILIES) {
    console.log(`  ${family}:`)
    for (const t of Z_SWEEP) {
      const s = score(o => fn(o, t))
      zScores.push({ name: `${family}@${t}`, family, t, s })
      console.log(`    t=${String(t).padStart(2)}  ${fmt(s)}`)
    }
  }

  // Head-to-head at MATCHED false-accept rate: the only fair comparison.
  const baseline = fixedScores.find(f => f.name === 'fixed-prod').s
  console.log(`\nHead-to-head vs fixed-prod (TA ${(100 * baseline.taRate).toFixed(1)}%, false ${(100 * baseline.faRate).toFixed(2)}%):`)
  console.log('  best z config whose false-accept rate does NOT exceed the incumbent:')
  for (const [family] of Z_FAMILIES) {
    const eligible = zScores.filter(z => z.family === family && z.s.faRate <= baseline.faRate + 1e-9)
    if (!eligible.length) { console.log(`    ${family.padEnd(11)}— none reach the incumbent's false-accept rate`); continue }
    const best = eligible.reduce((a, b) => (b.s.taRate > a.s.taRate ? b : a))
    const delta = 100 * (best.s.taRate - baseline.taRate)
    console.log(`    ${family.padEnd(11)}${best.name.padEnd(13)}${fmt(best.s)}   ΔTA ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} pts`)
  }

  // Per-scenario true-accept, incumbent vs the matched-false-accept z config.
  // Pooling hides the answer: the survivable tier saturates at 100% for every
  // gate, so any real difference lives entirely in the severe tier.
  const zEligible = zScores.filter(z => z.family === 'z-all' && z.s.faRate <= baseline.faRate + 1e-9)
  if (zEligible.length) {
    const bestZ = zEligible.reduce((a, b) => (b.s.taRate > a.s.taRate ? b : a))
    console.log(`\nPer-scenario true-accept — fixed-prod vs ${bestZ.name}:`)
    console.log(`  ${'scenario'.padEnd(13)}${'fixed'.padEnd(9)}${'z'.padEnd(9)}delta`)
    for (const [scenario] of SCENARIOS) {
      const sub = inObs.filter(o => o.scenario === scenario)
      const ta = pred => sub.filter(o => pred(o.obs) && o.obs.correct).length / sub.length
      const f = ta(o => o.bestDist <= MATCH_THRESHOLD && o.gap >= MATCH_MIN_GAP)
      const z = ta(o => o.zAll >= bestZ.t)
      const d = 100 * (z - f)
      console.log(`  ${scenario.padEnd(13)}${(100 * f).toFixed(1).padEnd(9)}${(100 * z).toFixed(1).padEnd(9)}${d >= 0 ? '+' : ''}${d.toFixed(1)}`)
    }
  }

  // Where the incumbent actually loses: correct matches it rejects.
  const rejectedCorrect = inObs.filter(o => o.obs.correct && !(o.obs.bestDist <= MATCH_THRESHOLD && o.obs.gap >= MATCH_MIN_GAP))
  console.log(`\nCorrect matches the fixed gate rejects: ${rejectedCorrect.length} of ${inObs.filter(o => o.obs.correct).length}`)
  if (rejectedCorrect.length) {
    console.log(`  their zAll:  median ${percentile(rejectedCorrect.map(o => o.obs.zAll), 0.5).toFixed(2)}  mean ${meanOf(rejectedCorrect.map(o => o.obs.zAll)).toFixed(2)}`)
    const byScenario = {}
    for (const o of rejectedCorrect) byScenario[o.scenario] = (byScenario[o.scenario] ?? 0) + 1
    console.log(`  by scenario: ${Object.entries(byScenario).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  }
  // Separation diagnostics: if these distributions overlap, no threshold helps.
  const zCorrect = inObs.filter(o => o.obs.correct).map(o => o.obs.zAll)
  const zFalse = outObs.map(o => o.obs.zAll)
  console.log('\nzAll separation (the ceiling on any threshold choice):')
  console.log(`  correct in-pool : p05 ${percentile(zCorrect, 0.05).toFixed(2)}  median ${percentile(zCorrect, 0.5).toFixed(2)}`)
  console.log(`  held-out cards  : median ${percentile(zFalse, 0.5).toFixed(2)}  p95 ${percentile(zFalse, 0.95).toFixed(2)}  max ${Math.max(...zFalse).toFixed(2)}`)
  const dCorrect = inObs.filter(o => o.obs.correct).map(o => o.obs.bestDist)
  const dFalse = outObs.map(o => o.obs.bestDist)
  console.log('bestDist separation, same probes (what the incumbent uses):')
  console.log(`  correct in-pool : p95 ${percentile(dCorrect, 0.95).toFixed(1)}  median ${percentile(dCorrect, 0.5).toFixed(1)}`)
  console.log(`  held-out cards  : p05 ${percentile(dFalse, 0.05).toFixed(1)}  median ${percentile(dFalse, 0.5).toFixed(1)}  min ${Math.min(...dFalse).toFixed(1)}`)
}

main().then(() => process.exit(0)).catch(e => {
  console.error(e)
  process.exit(1)
})

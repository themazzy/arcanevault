/**
 * matchCore.js — hash matching over a HashPackStore
 *
 * Shared by hashMatchWorker.js (primary path) and DatabaseService.js
 * (synchronous fallback when the worker is unavailable). Pure JS.
 *
 * Ranking semantics are intentionally identical to the previous
 * object-per-card implementation:
 *  - LSH pre-filter: 16 bands of 6 bits over the luma hash; candidates need
 *    ≥2 matching bands (top 1500 by band hits), relaxing to ≥1 (top 2500),
 *    then to a full scan.
 *  - Combined distance = 0.65 × luma + 0.35 × color when a color hash is given.
 *  - Locked sets restrict the pool, with optional all-sets fallback on weak
 *    results; broadFallbackOnWeak re-ranks the full pool when the indexed
 *    subset produced a weak best.
 */

// Explicit .js extension keeps this module loadable from plain Node too.
import { hammingDistanceAt } from './hashCore.js'

const BAND_MASK = 0x3F
// [wordIndex, shift] — 16 bands of 6 bits across the 8 Uint32 hash words
const BAND_SPECS = [
  [0, 0], [0, 16], [1, 0], [1, 16],
  [2, 0], [2, 16], [3, 0], [3, 16],
  [4, 0], [4, 16], [5, 0], [5, 16],
  [6, 0], [6, 16], [7, 0], [7, 16],
]
const BANDS = BAND_SPECS.length
const KEYS_PER_BAND = 64
// Below this store size a full scan is cheaper than the band index.
const INDEX_MIN_CARDS = 2000

// Combined-distance weights. The no-full combinations are exactly the v6
// formula, so a format-v1 (pre-reseed) pack behaves identically.
// FULL_SCALE aligns the full-card hash's distance scale with the art hash —
// whole cards share frame structure, so their random inter-card distances sit
// below 128. Harness-calibrated on 400 real cards (2,772 pairs): art random
// mean 126.0, full random mean 110.8 → 126.0 / 110.8 ≈ 1.14. Keeps combined
// distances on the same scale the acceptance thresholds were tuned for.
const FULL_SCALE = 1.14

export function createMatcher(store) {
  // CSR band indexes over global row indices (art always; full when the pack
  // carries full-card hashes — a glare-corrupted art hash can miss the true
  // card in the art bands while the full-card bands still surface it):
  //   entries[band * count + starts[band * 65 + key] .. starts[band * 65 + key + 1]]
  let indexCount = -1   // store.count the indexes were built for; -1 = never built
  let artIndex = null   // { starts: Uint32Array, entries: Uint32Array }
  let fullIndex = null

  function buildBandIndex(getWords) {
    const count = store.count
    const starts = new Uint32Array(BANDS * (KEYS_PER_BAND + 1))
    const entries = new Uint32Array(BANDS * count)
    // Pass 1: bucket sizes
    for (const chunk of store.chunks) {
      const words = getWords(chunk)
      for (let i = 0; i < chunk.count; i++) {
        const base = i * 8
        for (let b = 0; b < BANDS; b++) {
          const key = (words[base + BAND_SPECS[b][0]] >>> BAND_SPECS[b][1]) & BAND_MASK
          starts[b * (KEYS_PER_BAND + 1) + key + 1]++
        }
      }
    }
    // Prefix sums per band
    for (let b = 0; b < BANDS; b++) {
      const off = b * (KEYS_PER_BAND + 1)
      for (let k = 0; k < KEYS_PER_BAND; k++) {
        starts[off + k + 1] += starts[off + k]
      }
    }
    // Pass 2: fill
    const cursors = starts.slice()
    let globalIdx = 0
    for (const chunk of store.chunks) {
      const words = getWords(chunk)
      for (let i = 0; i < chunk.count; i++, globalIdx++) {
        const base = i * 8
        for (let b = 0; b < BANDS; b++) {
          const key = (words[base + BAND_SPECS[b][0]] >>> BAND_SPECS[b][1]) & BAND_MASK
          entries[b * count + cursors[b * (KEYS_PER_BAND + 1) + key]++] = globalIdx
        }
      }
    }
    return { starts, entries }
  }

  function ensureIndex() {
    if (indexCount === store.count) return
    artIndex = buildBandIndex(chunk => chunk.luma)
    fullIndex = store.hasFullHashes ? buildBandIndex(chunk => chunk.full) : null
    indexCount = store.count
  }

  function probeBands(index, query, hitCounts) {
    const count = store.count
    for (let b = 0; b < BANDS; b++) {
      const key = (query[BAND_SPECS[b][0]] >>> BAND_SPECS[b][1]) & BAND_MASK
      const off = b * (KEYS_PER_BAND + 1)
      const from = b * count + index.starts[off + key]
      const to = b * count + index.starts[off + key + 1]
      for (let e = from; e < to; e++) {
        const idx = index.entries[e]
        hitCounts.set(idx, (hitCounts.get(idx) ?? 0) + 1)
      }
    }
  }

  /** Candidate global indices for a query, or null for "scan everything". */
  function getCandidates(query, fullQuery) {
    const count = store.count
    if (count <= INDEX_MIN_CARDS) return null
    ensureIndex()

    const hitCounts = new Map()
    probeBands(artIndex, query, hitCounts)
    if (fullQuery && fullIndex) probeBands(fullIndex, fullQuery, hitCounts)

    let candidates = [...hitCounts.entries()]
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 1500)
      .map(([idx]) => idx)

    if (candidates.length >= 32) return candidates

    candidates = [...hitCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2500)
      .map(([idx]) => idx)

    return candidates.length ? candidates : null
  }

  /** Per-chunk allowed-set-index flags for a Set of lowercase set codes. */
  function buildAllowedFlags(allowedSets) {
    return store.chunks.map(chunk => {
      const flags = new Uint8Array(chunk.sets.length)
      for (let s = 0; s < chunk.sets.length; s++) {
        if (allowedSets.has(chunk.sets[s])) flags[s] = 1
      }
      return flags
    })
  }

  /**
   * Rank candidates by combined distance. `indices` is an array of global
   * card indices, or null to scan the whole store. `allowedFlags` (from
   * buildAllowedFlags) restricts the pool when present.
   * Returns { bestIdx, bestDist, secondIdx, secondDist, scanned }.
   */
  function rank(indices, query, colorQuery, fullQuery, allowedFlags) {
    let bestIdx = -1, secondIdx = -1
    let bestDist = Infinity, secondDist = Infinity
    let scanned = 0

    const consider = (chunkIdx, chunk, local, globalIdx) => {
      if (allowedFlags && !allowedFlags[chunkIdx][chunk.setIdx[local]]) return
      scanned++
      const base = local * 8
      const artDist = hammingDistanceAt(chunk.luma, base, query)
      const useColor = !!colorQuery
      const useFull = !!(fullQuery && chunk.full)
      let d = artDist
      if (useColor && useFull) {
        d = Math.round(
          0.45 * artDist +
          0.20 * hammingDistanceAt(chunk.color, base, colorQuery) +
          0.35 * FULL_SCALE * hammingDistanceAt(chunk.full, base, fullQuery),
        )
      } else if (useColor) {
        d = Math.round(0.65 * artDist + 0.35 * hammingDistanceAt(chunk.color, base, colorQuery))
      } else if (useFull) {
        d = Math.round(0.65 * artDist + 0.35 * FULL_SCALE * hammingDistanceAt(chunk.full, base, fullQuery))
      }
      if (d < bestDist) {
        secondIdx = bestIdx; secondDist = bestDist
        bestIdx = globalIdx; bestDist = d
      } else if (d < secondDist) {
        secondIdx = globalIdx; secondDist = d
      }
    }

    if (indices) {
      for (const globalIdx of indices) {
        // locate() is a short linear scan over the chunk list
        const loc = store.locate(globalIdx)
        if (!loc) continue
        consider(loc.chunkIdx, loc.chunk, loc.local, globalIdx)
      }
    } else {
      let globalIdx = 0
      for (let c = 0; c < store.chunks.length; c++) {
        const chunk = store.chunks[c]
        for (let i = 0; i < chunk.count; i++, globalIdx++) {
          consider(c, chunk, i, globalIdx)
        }
      }
    }
    return { bestIdx, bestDist, secondIdx, secondDist, scanned }
  }

  function toResult(ranked, fallback) {
    return {
      best: ranked.bestIdx >= 0 ? store.getCardPublic(ranked.bestIdx, ranked.bestDist) : null,
      second: ranked.secondIdx >= 0 ? store.getCardPublic(ranked.secondIdx, ranked.secondDist) : null,
      candidateCount: ranked.scanned,
      totalCount: store.count,
      fallback,
    }
  }

  function match(query, colorQuery = null, fullQuery = null, opts = {}) {
    if (!store.count) {
      return { best: null, second: null, candidateCount: 0, totalCount: 0 }
    }
    const {
      allowedSets = null,
      allowSetFallback = false,
      broadFallbackOnWeak = false,
      weakDistance = 122,
      weakGap = 8,
    } = opts

    const allowedFlags = allowedSets?.size ? buildAllowedFlags(allowedSets) : null
    const isWeak = (ranked) => {
      if (ranked.bestIdx < 0) return true
      const gap = ranked.secondIdx >= 0 ? ranked.secondDist - ranked.bestDist : 256
      return ranked.bestDist > weakDistance || gap < weakGap
    }

    const baseCandidates = getCandidates(query, fullQuery)

    // Rank the (set-filtered) indexed candidates; when that comes back empty
    // or weak, widen to the full (set-filtered) pool.
    const rankWithFallback = (flags, source) => {
      let ranked = baseCandidates ? rank(baseCandidates, query, colorQuery, fullQuery, flags) : null
      let usedIndexedSubset = !!baseCandidates
      if (!ranked || ranked.bestIdx < 0) {
        ranked = rank(null, query, colorQuery, fullQuery, flags)
        usedIndexedSubset = false
      }
      let fallback = source
      if (broadFallbackOnWeak && usedIndexedSubset && isWeak(ranked)) {
        ranked = rank(null, query, colorQuery, fullQuery, flags)
        fallback = `${source}+broad`
      }
      return { ranked, fallback }
    }

    let { ranked, fallback } = rankWithFallback(allowedFlags, allowedFlags ? 'locked-set' : 'indexed')

    if (allowedFlags && allowSetFallback && isWeak(ranked)) {
      ;({ ranked, fallback } = rankWithFallback(null, 'all-sets-fallback'))
    }

    return toResult(ranked, fallback)
  }

  /** Try several query hashes (standard/foil/dark) and keep the best result. */
  function matchAll(queries, colorQuery = null, fullQuery = null, opts = {}) {
    if (!store.count) {
      return { best: null, second: null, candidateCount: 0, totalCount: 0, bestLabel: null }
    }
    let best = null, second = null, candidateCount = 0
    let fallback = null, bestLabel = null
    for (const { hash, label } of queries) {
      if (!hash) continue
      const result = match(hash, colorQuery, fullQuery, opts)
      if (result.best && (!best || result.best.distance < best.distance)) {
        best = result.best; second = result.second
        candidateCount = result.candidateCount
        fallback = result.fallback; bestLabel = label
      }
    }
    return { best, second, candidateCount, totalCount: store.count, fallback, bestLabel }
  }

  return {
    match,
    matchAll,
    /** Force index rebuild on next match (call after appending chunks). */
    invalidate() { indexCount = -1 },
  }
}

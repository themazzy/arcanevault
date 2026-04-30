import { hammingDistance } from './hashCore'

const BAND_MASK = 0x3F
const BAND_SPECS = [
  [0, 0], [0, 16], [1, 0], [1, 16],
  [2, 0], [2, 16], [3, 0], [3, 16],
  [4, 0], [4, 16], [5, 0], [5, 16],
  [6, 0], [6, 16], [7, 0], [7, 16],
]

let hashes = []
let bandIndex = BAND_SPECS.map(() => new Map())

function normalizeCard(card) {
  return {
    id: card.id,
    name: card.name,
    setCode: card.setCode,
    collNum: card.collNum,
    imageUri: card.imageUri,
    hash: new Uint32Array(card.hash),
    hashColor: card.hashColor ? new Uint32Array(card.hashColor) : null,
  }
}

function publicCard(card, distance) {
  if (!card) return null
  return {
    id: card.id,
    name: card.name,
    setCode: card.setCode,
    collNum: card.collNum,
    imageUri: card.imageUri,
    distance,
  }
}

function addToIndex(card, idx) {
  BAND_SPECS.forEach(([wordIdx, shift], bandIdx) => {
    const key = (card.hash[wordIdx] >>> shift) & BAND_MASK
    const bucket = bandIndex[bandIdx].get(key)
    if (bucket) bucket.push(idx)
    else bandIndex[bandIdx].set(key, [idx])
  })
}

function rebuildIndex() {
  bandIndex = BAND_SPECS.map(() => new Map())
  hashes.forEach((card, idx) => addToIndex(card, idx))
}

function getCandidates(hash) {
  if (!bandIndex.length || hashes.length <= 2000) return hashes

  const hitCounts = new Map()
  BAND_SPECS.forEach(([wordIdx, shift], bandIdx) => {
    const key = (hash[wordIdx] >>> shift) & BAND_MASK
    const bucket = bandIndex[bandIdx].get(key)
    if (!bucket) return
    for (const idx of bucket) {
      hitCounts.set(idx, (hitCounts.get(idx) ?? 0) + 1)
    }
  })

  let candidates = [...hitCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 1500)
    .map(([idx]) => hashes[idx])

  if (candidates.length >= 32) return candidates

  candidates = [...hitCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2500)
    .map(([idx]) => hashes[idx])

  return candidates.length ? candidates : hashes
}

function rankMatch(hash, colorHash = null, opts = {}) {
  if (!hashes.length) {
    return { best: null, second: null, candidateCount: 0, totalCount: 0 }
  }

  const {
    allowedSets = null,
    allowSetFallback = false,
    broadFallbackOnWeak = false,
    weakDistance = 122,
    weakGap = 8,
  } = opts
  const allowedSet = allowedSets?.length ? new Set(allowedSets.map(code => String(code).toLowerCase())) : null
  const allowed = allowedSet
    ? card => card.setCode && allowedSet.has(String(card.setCode).toLowerCase())
    : null

  const rank = (cards) => {
    let best = null, second = null
    let bestDist = Infinity, secondDist = Infinity
    for (const card of cards) {
      const lumaDist = hammingDistance(hash, card.hash)
      const d = (colorHash && card.hashColor)
        ? Math.round(0.65 * lumaDist + 0.35 * hammingDistance(colorHash, card.hashColor))
        : lumaDist
      if (d < bestDist) {
        second = best; secondDist = bestDist
        best = card;   bestDist = d
      } else if (d < secondDist) {
        second = card; secondDist = d
      }
    }
    return {
      best: publicCard(best, bestDist),
      second: publicCard(second, secondDist),
      candidateCount: cards.length,
    }
  }

  const isWeak = ({ best, second }) => {
    if (!best) return true
    const gap = second ? second.distance - best.distance : 256
    return best.distance > weakDistance || gap < weakGap
  }

  const baseCandidates = getCandidates(hash)
  const rankWithFallback = (pool, candidates, source) => {
    let result = rank(candidates)
    let fallback = source
    if (broadFallbackOnWeak && isWeak(result) && candidates.length < pool.length) {
      result = rank(pool)
      fallback = `${source}+broad`
    }
    return { ...result, fallback }
  }

  const pool = allowed ? hashes.filter(allowed) : hashes
  const candidates = allowed ? baseCandidates.filter(allowed) : baseCandidates
  let ranked = rankWithFallback(pool, candidates.length ? candidates : pool, allowed ? 'locked-set' : 'indexed')

  if (allowed && allowSetFallback && isWeak(ranked)) {
    ranked = rankWithFallback(hashes, baseCandidates, 'all-sets-fallback')
  }

  return {
    best: ranked.best,
    second: ranked.second,
    candidateCount: ranked.candidateCount,
    totalCount: hashes.length,
    fallback: ranked.fallback,
  }
}

self.onmessage = (event) => {
  const { id, type, payload } = event.data || {}
  try {
    if (type === 'reset') {
      hashes = (payload?.hashes || []).map(normalizeCard)
      rebuildIndex()
      self.postMessage({ id, ok: true, result: { count: hashes.length } })
      return
    }

    if (type === 'append') {
      const incoming = (payload?.hashes || []).map(normalizeCard)
      const startIdx = hashes.length
      hashes.push(...incoming)
      for (let i = startIdx; i < hashes.length; i++) addToIndex(hashes[i], i)
      self.postMessage({ id, ok: true, result: { count: hashes.length } })
      return
    }

    if (type === 'match') {
      const hash = new Uint32Array(payload.hash)
      const colorHash = payload.colorHash ? new Uint32Array(payload.colorHash) : null
      self.postMessage({ id, ok: true, result: rankMatch(hash, colorHash, payload.opts || {}) })
      return
    }

    if (type === 'matchAll') {
      // Try all hash variants (standard/foil/dark) in one call and return the best.
      const colorHash = payload.colorHash ? new Uint32Array(payload.colorHash) : null
      const opts = payload.opts || {}
      let best = null, second = null, candidateCount = 0, fallback = null, bestLabel = null
      for (const { hash: hashArr, label } of (payload.queries || [])) {
        if (!hashArr) continue
        const result = rankMatch(new Uint32Array(hashArr), colorHash, opts)
        if (result.best && (!best || result.best.distance < best.distance)) {
          best = result.best; second = result.second
          candidateCount = result.candidateCount; fallback = result.fallback; bestLabel = label
        }
      }
      self.postMessage({ id, ok: true, result: { best, second, candidateCount, totalCount: hashes.length, fallback, bestLabel } })
      return
    }

    throw new Error(`Unknown worker message: ${type}`)
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) })
  }
}

/**
 * nameMatch.js — fuzzy card-name matching for the title-OCR rescue path
 *
 * When art hashing can't identify a card (glare, foils, low light), the
 * scanner OCRs the title bar and matches it against every card name in the
 * hash pack. OCR text is noisy and may carry trailing junk (mana-cost
 * symbols), so matching uses a banded prefix-Levenshtein: a name matches any
 * prefix of the OCR text within a length-scaled edit budget, and a hit is
 * only accepted when the runner-up (different) name is ≥2 edits worse.
 *
 * Pure JS — shared by the scanner and tests.
 */

const MARGIN = 2                 // best must beat the runner-up name by this
const BAND = 3                   // Levenshtein band half-width (max edits considered)

/** Max edit distance allowed for a name of the given (normalized) length. */
export function maxEditsFor(len) {
  if (len <= 7) return 1
  if (len <= 13) return 2
  return 3
}

/**
 * Normalize a name or OCR line: lowercase, fold diacritics/ligatures
 * (Æther → aether), keep [a-z0-9 ] only, collapse whitespace.
 */
export function normalizeTitle(value) {
  return String(value ?? '')
    .toLowerCase()
    .replaceAll('æ', 'ae').replaceAll('œ', 'oe')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Build the name index from { name, idx } entries ordered newest-first
 * (the hash pack's natural order). Double-faced names ("A // B") are also
 * indexed under their front face. Each unique normalized name keeps ALL its
 * printing indices, newest first — callers can honor set locks.
 */
export function buildNameIndex(entries) {
  const byNorm = new Map()
  const add = (norm, name, idx) => {
    if (!norm) return
    const existing = byNorm.get(norm)
    if (existing) existing.idxs.push(idx)
    else byNorm.set(norm, { norm, name, idxs: [idx] })
  }
  for (const { name, idx } of entries) {
    const norm = normalizeTitle(name)
    add(norm, name, idx)
    const slash = name.indexOf(' // ')
    if (slash > 0) add(normalizeTitle(name.slice(0, slash)), name, idx)
  }
  return { byNorm, names: [...byNorm.values()] }
}

/**
 * Banded Levenshtein of `name` against any PREFIX of `text` (min over the
 * final DP row) — trailing OCR junk after the name costs nothing.
 * Returns Infinity when the distance exceeds `cutoff`.
 */
export function prefixEditDistance(name, text, cutoff = BAND) {
  const n = name.length
  const m = Math.min(text.length, n + cutoff)
  if (n === 0 || m === 0) return Infinity
  if (Math.abs(n - Math.min(text.length, n)) > cutoff && text.length < n - cutoff) return Infinity

  // DP rows over `text` (j), banded around the diagonal |j - i| ≤ cutoff.
  const INF = cutoff + 1
  let prev = new Float64Array(m + 1).fill(INF)
  let curr = new Float64Array(m + 1)
  for (let j = 0; j <= Math.min(m, cutoff); j++) prev[j] = j

  for (let i = 1; i <= n; i++) {
    curr.fill(INF)
    const jLo = Math.max(1, i - cutoff)
    const jHi = Math.min(m, i + cutoff)
    if (i - cutoff <= 0) curr[0] = i
    let rowMin = curr[0]
    const ci = name.charCodeAt(i - 1)
    for (let j = jLo; j <= jHi; j++) {
      const sub = prev[j - 1] + (ci === text.charCodeAt(j - 1) ? 0 : 1)
      const del = prev[j] + 1
      const ins = curr[j - 1] + 1
      const v = sub < del ? (sub < ins ? sub : ins) : (del < ins ? del : ins)
      curr[j] = v
      if (v < rowMin) rowMin = v
    }
    if (rowMin > cutoff) return Infinity
    ;[prev, curr] = [curr, prev]
  }

  // Name may end anywhere in [n - cutoff, n + cutoff] of the text (prefix).
  let best = INF
  for (let j = Math.max(0, n - cutoff); j <= Math.min(m, n + cutoff); j++) {
    if (prev[j] < best) best = prev[j]
  }
  return best > cutoff ? Infinity : best
}

/**
 * Match OCR'd title text against the index.
 * Returns { name, norm, idxs, distance } or null when no name is a
 * sufficiently unique match. The title strip starts at the card edge, so
 * border-ornament misreads can precede the name — leading tokens of ≤2
 * chars (never a name's real first word given the other gates) are dropped
 * and retried.
 */
export function matchTitle(rawText, index) {
  let attempt = normalizeTitle(rawText)
  for (let drops = 0; drops < 3; drops++) {
    const hit = matchNormalized(attempt, index)
    if (hit) return hit
    const space = attempt.indexOf(' ')
    if (space === -1 || space > 2) return null
    attempt = attempt.slice(space + 1)
  }
  return null
}

function matchNormalized(text, index) {
  if (text.length < 3) return null

  // Exact full-text hit short-circuits.
  const exact = index.byNorm.get(text)
  if (exact) return { ...exact, distance: 0 }

  const prefixRelated = (a, b) => a.startsWith(b) || b.startsWith(a)

  let best = null, bestDist = Infinity
  let secondDist = Infinity
  for (const entry of index.names) {
    // Cheap length gate: the name must fit within the text (+ edit slack).
    if (entry.norm.length > text.length + BAND) continue
    let d = prefixEditDistance(entry.norm, text, BAND)
    // A perfect prefix that ends mid-word ("fire" inside "firebolt...") is
    // suspect — penalize so the full-word name wins the tiebreak.
    if (d === 0 && text.length > entry.norm.length && text[entry.norm.length] !== ' ') d = 1
    // Names beyond their own edit budget are implausible readings — they can
    // never win, and a 4-char name at 3 edits must not poison the margin as
    // a runner-up either.
    if (d > maxEditsFor(entry.norm.length)) continue
    // Very short names (the card "X" exists!) match OCR garbage within one
    // edit far too easily — they must read exactly, on a word boundary.
    if (entry.norm.length < 5 && d !== 0) continue
    if (d < bestDist || (d === bestDist && best && entry.norm.length > best.norm.length)) {
      if (best && best.norm !== entry.norm && !prefixRelated(best.norm, entry.norm) && bestDist < secondDist) {
        secondDist = bestDist
      }
      best = entry
      bestDist = d
    } else if (d < secondDist && best && entry.norm !== best.norm && !prefixRelated(best.norm, entry.norm)) {
      secondDist = d
    }
    if (bestDist === 0 && secondDist >= MARGIN) break
  }

  if (!best) return null
  if (bestDist > maxEditsFor(best.norm.length)) return null
  if (secondDist - bestDist < MARGIN) return null

  return { name: best.name, norm: best.norm, idxs: best.idxs, distance: bestDist }
}

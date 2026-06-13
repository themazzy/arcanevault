// Hypergeometric draw probabilities for deck stats. Pure math, no deps.
//
// Deck of N cards containing K "successes"; draw n without replacement.
//   hypergeomPMF(N,K,n,k)     P(exactly k successes)
//   hypergeomAtLeast(N,K,n,k) P(at least k successes)
//   expectedCount(N,K,n)      mean successes drawn = n·K/N
//
// Uses log-gamma so large binomials don't overflow (decks can be 100+ cards).

// Lanczos approximation of ln(Γ(x)).
const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
]
function lgamma(x) {
  if (x < 0.5) {
    // Reflection formula
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x)
  }
  x -= 1
  let a = 0.99999999999980993
  const t = x + 7.5
  for (let i = 0; i < LANCZOS.length; i++) a += LANCZOS[i] / (x + i + 1)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

function logChoose(n, k) {
  if (k < 0 || k > n) return -Infinity
  return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1)
}

export function hypergeomPMF(N, K, n, k) {
  N = Math.round(N); K = Math.round(K); n = Math.round(n); k = Math.round(k)
  if (N <= 0 || n <= 0 || n > N || K < 0 || K > N) return 0
  if (k < 0 || k > K || k > n || n - k > N - K) return 0
  const logP = logChoose(K, k) + logChoose(N - K, n - k) - logChoose(N, n)
  const p = Math.exp(logP)
  return p > 1 ? 1 : p < 0 ? 0 : p
}

export function hypergeomAtLeast(N, K, n, k) {
  const hi = Math.min(n, K)
  if (k <= 0) return N > 0 && n > 0 && n <= N ? 1 : 0
  let sum = 0
  for (let i = Math.round(k); i <= hi; i++) sum += hypergeomPMF(N, K, n, i)
  return sum > 1 ? 1 : sum
}

export function expectedCount(N, K, n) {
  if (N <= 0) return 0
  return (n * K) / N
}

// Opening-hand land summary for the given deck size and land count.
// Returns { avg, idealPct } where idealPct is P(2–4 lands) in a 7-card hand
// — the "keepable" range most guides target.
export function openingHandLands(deckSize, landCount, handSize = 7) {
  if (deckSize <= 0 || handSize <= 0) return { avg: 0, idealPct: 0 }
  const n = Math.min(handSize, deckSize)
  const avg = expectedCount(deckSize, landCount, n)
  let idealPct = 0
  for (let k = 2; k <= 4; k++) idealPct += hypergeomPMF(deckSize, landCount, n, k)
  return { avg, idealPct: Math.min(idealPct, 1) }
}

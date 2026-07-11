// Classifier staples audit.
//
// Pulls the most-played Commander cards (lowest edhrec_rank) from the
// public-read card_prints table and runs each through getCardCategory. Cards
// that land in a *type-fallback* bucket (Creature/Instant/Sorcery/… — "the
// regex found no functional role") are the misclassification backlog: a staple
// that should read as Ramp/Removal/Draw but slipped through. Vanilla beaters
// and plain lands legitimately fall through, so the output is for human review,
// not an assertion.
//
// Usage: node scripts/classifier-staples-audit.mjs [limit]
// Env:   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (read from .env)

import { readFileSync } from 'node:fs'
import { getCardCategory, isTypeFallbackCategory } from '../src/lib/cardCategory.js'

const LIMIT = Number(process.argv[2] || 1500)

function loadEnv() {
  const txt = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  const env = {}
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return env
}

async function fetchStaples(env, limit) {
  const base = env.VITE_SUPABASE_URL.replace(/\/$/, '')
  const key = env.VITE_SUPABASE_ANON_KEY
  const seen = new Set()
  const out = []
  const PAGE = 1000
  // Over-fetch (many printings share a name); dedupe by name, keep the best
  // rank. Reprints of top staples dominate the lowest ranks, so the multiplier
  // is generous to reach `limit` distinct names.
  for (let from = 0; out.length < limit && from < limit * 40; from += PAGE) {
    const url = `${base}/rest/v1/card_prints?select=name,type_line,oracle_text,edhrec_rank,card_faces` +
      `&edhrec_rank=not.is.null&order=edhrec_rank.asc&limit=${PAGE}&offset=${from}`
    const res = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } })
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${await res.text()}`)
    const rows = await res.json()
    if (!rows.length) break
    for (const r of rows) {
      const nm = (r.name || '').toLowerCase()
      if (!nm || seen.has(nm)) continue
      seen.add(nm)
      out.push(r)
      if (out.length >= limit) break
    }
  }
  return out
}

function oracleOf(row) {
  if (row.oracle_text) return row.oracle_text
  const faces = Array.isArray(row.card_faces) ? row.card_faces.map(f => f.oracle_text).filter(Boolean) : []
  return faces.join('\n')
}

const env = loadEnv()
const staples = await fetchStaples(env, LIMIT)
console.log(`Fetched ${staples.length} distinct staples (by edhrec_rank).\n`)

// Group the type-fallback hits by category, skipping plain lands (Land is
// correct for them) and true vanilla/near-vanilla creatures with no rules text.
const byBucket = new Map()
let functional = 0
for (const row of staples) {
  const type = row.type_line || ''
  const oracle = oracleOf(row)
  const cat = getCardCategory(oracle, type)
  if (!isTypeFallbackCategory(cat)) { functional++; continue }
  if (cat === 'Land') continue
  // Skip creatures/artifacts with no oracle text at all (nothing to classify).
  if (!oracle.trim()) continue
  if (!byBucket.has(cat)) byBucket.set(cat, [])
  byBucket.get(cat).push({ name: row.name, rank: row.edhrec_rank, oracle: oracle.replace(/\n/g, ' ') })
}

console.log(`Functional role: ${functional}/${staples.length}. Type-fallback (with rules text) below, by bucket:\n`)
for (const [cat, list] of [...byBucket.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n=== ${cat} (${list.length}) ===`)
  for (const c of list.slice(0, 60)) {
    console.log(`  [${String(c.rank).padStart(5)}] ${c.name}\n            ${c.oracle.slice(0, 150)}`)
  }
}

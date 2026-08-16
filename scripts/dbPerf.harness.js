// Database RPC latency harness.
//
// Answers: how long do the hot read paths actually take, as a client sees
// them — over the real network, through PostgREST, under RLS?
//
// Why this exists. `pg_stat_statements` is the obvious place to look and it
// misleads in a specific way: its counters are lifetime totals since
// `stats_reset`. On this project that window was 157 days when first read
// (2026-03-12 → 2026-08-16), so every mean it reported was an average across
// months that included the *pre-optimisation* version of each function.
// `get_public_profile` showed a 1.7–5.0 s mean and a 19.7 s max there, which
// reads like an emergency; measured live it is 38 ms cold / 0.8 ms warm,
// because the profile_stats cache had already fixed it. The historical rows
// never age out. Conversely a function that regressed *yesterday* is hidden
// under months of good samples. Neither error is detectable from the
// aggregate alone — hence a harness that measures now.
//
// Method: call each RPC through supabase-js exactly as the app does, N times,
// and report the distribution. The first call is reported separately because
// it is the only one that reflects a cold shared-buffer state; Postgres will
// have the pages resident for every call after it. That first/warm split is
// the whole point — the app's worst cases are cold ones (a user opening a
// surface nobody has touched in an hour), and an all-warm benchmark reports
// numbers no real user experiences.
//
// Runs as ANON, deliberately. Every RPC probed here is granted to `anon`
// (get_my_decks is the one hot RPC that is not, so it is absent), and anon
// carries a *3 s* statement timeout against authenticated's 8 s. Measuring on
// the tighter budget means the harness reports a failure at the threshold the
// public routes actually live under, rather than one only signed-in users get.
//
// This is a report, not a pass/fail — same contract as buildAssist.harness.js.
// It prints a table, marks anything over budget, and exits 0 regardless. The
// budgets below are judgement calls anchored to what the surface is doing:
// type-ahead needs to feel instant, a page-load RPC has more room.
//
// Run: npm run harness:db-perf
// Env: HARNESS_RUNS=n      (samples per probe, default 7)
//      HARNESS_OUT=path    (report destination)
//      HARNESS_ONLY=a,b    (probe name substrings to include)

import { it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { createClient } from '@supabase/supabase-js'

const URL = import.meta.env.VITE_SUPABASE_URL
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

// A fresh client with no session: we want the anon role, not whatever token
// happens to be cached. persistSession would try to touch storage that does
// not exist under the node environment this config runs in.
const sb = createClient(URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// 25 names — the Build Assistant enriches in batches of this rough size, and
// per-row LATERAL cost in these functions has bitten before (see the
// "RPC lateral per-row cost" note in the project memory), so a 1-name probe
// would measure the wrong thing entirely.
const SAMPLE_NAMES = [
  'Sol Ring', 'Arcane Signet', 'Command Tower', 'Lightning Bolt', 'Counterspell',
  'Swords to Plowshares', 'Cultivate', 'Rhystic Study', 'Smothering Tithe', 'Cyclonic Rift',
  'Demonic Tutor', 'Vampiric Tutor', 'Path to Exile', 'Beast Within', 'Chaos Warp',
  'Farseek', 'Nature\'s Lore', 'Three Visits', 'Talisman of Dominance', 'Fellwar Stone',
  'Mystic Remora', 'Esper Sentinel', 'Dockside Extortionist', 'Craterhoof Behemoth', 'Eternal Witness',
]

// Search terms are chosen to be *common* rather than convenient. A term with
// few matches understates the cost: the expensive part of these functions is
// the number of rows that survive the filter and have to be sorted, so a
// probe on a rare word measures a best case the UI rarely hits.
const PROBES = [
  {
    name: 'search_deck_builder_cards(bolt)',
    budget: 400,
    surface: 'DeckBuilder card search (type-ahead)',
    run: () => sb.rpc('search_deck_builder_cards', { search_term: 'bolt', page_size: 41, page_offset: 0 }),
  },
  {
    name: 'search_deck_builder_cards(dragon)',
    budget: 400,
    surface: 'DeckBuilder card search (type-ahead)',
    run: () => sb.rpc('search_deck_builder_cards', { search_term: 'dragon', page_size: 41, page_offset: 0 }),
  },
  {
    name: 'search_card_names(light)',
    budget: 400,
    surface: 'AddCardModal / Home autocomplete',
    run: () => sb.rpc('search_card_names', { search_term: 'light', max_results: 20 }),
  },
  {
    name: 'search_card_art(goblin)',
    budget: 600,
    surface: 'CardArtPicker (binder/wishlist/profile art)',
    run: () => sb.rpc('search_card_art', { search_term: 'goblin', max_results: 60 }),
  },
  {
    name: 'get_recommendation_card_metadata(25)',
    budget: 600,
    surface: 'Build Assistant enrichment',
    run: () => sb.rpc('get_recommendation_card_metadata', { requested_names: SAMPLE_NAMES }),
  },
  {
    name: 'get_deck_builder_display_printings(25)',
    budget: 600,
    surface: 'DeckBuilder printing display',
    run: () => sb.rpc('get_deck_builder_display_printings', { card_names: SAMPLE_NAMES, price_source: 'eur' }),
  },
  {
    name: 'get_community_decks(hot,24)',
    budget: 800,
    surface: 'Builder community index',
    run: () => sb.rpc('get_community_decks', { p_sort: 'hot', p_limit: 24, p_offset: 0 }),
  },
]

function pct(sorted, p) {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]
}

async function timeOnce(probe) {
  const t0 = performance.now()
  const res = await probe.run()
  const ms = performance.now() - t0
  // A statement timeout surfaces as an error payload, not a throw. Counting
  // it as a fast sample would be the worst possible failure mode for a
  // latency harness, so it is recorded explicitly.
  return { ms, error: res?.error?.message || null, rows: Array.isArray(res?.data) ? res.data.length : null }
}

it('database RPC latency', async () => {
  if (!URL || !KEY) throw new Error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing — copy .env.example to .env')

  // 12 rather than 7: below ~20 samples the p95 index lands on the last
  // element and the column silently becomes a duplicate of max. 12 keeps the
  // run under a minute while making p50 stable; treat p95 as "worst of the
  // warm samples" unless HARNESS_RUNS is raised to 20+.
  const runs = Number(process.env.HARNESS_RUNS || 12)
  const only = (process.env.HARNESS_ONLY || '').split(',').map(s => s.trim()).filter(Boolean)
  const probes = only.length ? PROBES.filter(p => only.some(o => p.name.includes(o))) : PROBES

  const out = []
  const line = s => { out.push(s); console.log(s) }

  line('DATABASE RPC LATENCY')
  line(`${new Date().toISOString()} · ${runs} runs/probe · role=anon (3s statement timeout)`)
  line('')
  line('first = cold shared buffers. p50/p95 = warm. Budget applies to p95.')
  if (runs < 20) line(`(${runs} runs — p95 collapses onto max at this sample size; read it as "worst warm sample")`)
  line('')
  line('probe                                    first    p50    p95    max   budget  rows  status')
  line('-'.repeat(100))

  const results = []
  for (const probe of probes) {
    const samples = []
    let firstMs = null
    let firstErr = null
    let rows = null
    let errors = 0

    for (let i = 0; i < runs; i++) {
      const { ms, error, rows: n } = await timeOnce(probe)
      if (i === 0) { firstMs = ms; firstErr = error; rows = n }
      if (error) { errors++; continue }
      // The first call is the cold one and is reported on its own. Letting it
      // into the warm distribution makes p95 a restatement of `first` — which
      // it silently was until 2026-08-16, when a run where every probe's p95
      // exactly equalled its first made the bug visible.
      if (i > 0) samples.push(ms)
    }

    const sorted = [...samples].sort((a, b) => a - b)
    const p50 = pct(sorted, 50)
    const p95 = pct(sorted, 95)
    const max = sorted.length ? sorted[sorted.length - 1] : 0

    // Cold cost is judged against a deliberately looser bar than warm. A
    // single slow first call is tolerable; a slow p95 means it is slow for
    // everyone, all the time.
    const overWarm = p95 > probe.budget
    const overCold = firstMs > probe.budget * 4
    const status = errors ? `FAIL ${errors}/${runs}` : overWarm ? 'OVER' : overCold ? 'cold' : 'ok'

    line(
      probe.name.padEnd(40) +
      `${Math.round(firstMs)}`.padStart(6) +
      `${Math.round(p50)}`.padStart(7) +
      `${Math.round(p95)}`.padStart(7) +
      `${Math.round(max)}`.padStart(7) +
      `${probe.budget}`.padStart(9) +
      `${rows ?? '-'}`.padStart(6) +
      '  ' + status
    )
    if (firstErr) line(`${' '.repeat(42)}error: ${firstErr}`)

    results.push({ ...probe, run: undefined, firstMs, p50, p95, max, rows, errors, status })
  }

  line('')
  const bad = results.filter(r => r.status !== 'ok')
  if (!bad.length) {
    line('All probes within budget.')
  } else {
    line('NEEDS ATTENTION')
    for (const r of bad) {
      line(`  ${r.name} — ${r.surface}`)
      if (r.errors) line(`      ${r.errors}/${runs} calls failed (statement timeout at the anon 3s ceiling?)`)
      else if (r.p95 > r.budget) line(`      warm p95 ${Math.round(r.p95)}ms over the ${r.budget}ms budget`)
      else line(`      cold first call ${Math.round(r.firstMs)}ms — pages are not staying resident`)
    }
  }

  line('')
  line('Reading a "cold" status: the buffer pool is 224 MB and the Scryfall')
  line('catalogue (card_prints 177 MB + oracle_cards 114 MB) does not fit in it.')
  line('A large cold/warm gap therefore means the query reads heap pages from')
  line('disk, and the fix is usually to touch fewer rows — not to add an index')
  line('that is already there.')

  const dest = process.env.HARNESS_OUT || path.join(process.cwd(), 'harness-db-perf.txt')
  fs.writeFileSync(dest, out.join('\n'))
  console.log(`\nreport → ${dest}`)
}, 10 * 60 * 1000)

# Performance & reliability findings — 2026-08-16

Baseline measurement pass plus the harnesses committed to keep it repeatable.
Numbers here are measured, not estimated; where something is unverified it says so.

---

## 1. `search_deck_builder_cards` timed out in production — **FIXED**

> Shipped as `supabase/migrations/20260816120000_speed_up_deck_builder_card_search.sql`,
> applied to production 2026-08-16. Verified result-equivalent before deploying
> (identical result sets *and* identical top-10 ordering across 10 terms), then
> re-measured through PostgREST:
>
> | | before | after |
> |---|---|---|
> | failures | **3 of 7 timed out** | **0 of 12** |
> | warm p50 | 765 ms | **127 ms** |
> | warm p95 | 3,116 ms | **383 ms** |
> | cold first | 4,218 ms | 1,608 ms |
> | shared buffers/search | 12,011 | **1,102** |
>
> Direct timings, old vs new body: bolt 714 → 9 ms (77×), fire 583 → 35 ms,
> dragon 595 → 70 ms. The remaining cold cost is the buffer-pool constraint in
> §2, not the query shape.
>
> Original diagnosis below, kept as the record.


Measured live via `npm run harness:db-perf`:

```
probe                                    first    p50    p95    max   budget  status
search_deck_builder_cards(bolt)           4218    765   3116   3116      400   FAIL 3/7
                                          error: canceling statement due to statement timeout
search_deck_builder_cards(dragon)          697    716    736    736      400   OVER
```

**3 of 7 consecutive calls failed.** Not a cold-start artifact — it recurs.

### Why

`EXPLAIN (ANALYZE, BUFFERS)` on the function body:

```
Limit (actual rows=43)
  Buffers: shared hit=12011
  ->  Sort
        ->  Seq Scan on oracle_cards          <-- full scan, no index
              Rows Removed by Filter: 38583
              Buffers: shared hit=12000
              SubPlan 1
                ->  Function Scan on unnest fn (loops=35011)
Execution Time: 4384.803 ms
```

A **Seq Scan over all 44,686 rows** of the 94 MB `oracle_cards` heap, plus `unnest`
run **35,011 times**. The trigram indexes exist and are simply unusable here: the
predicate is a three-way `OR` whose third branch is a correlated
`EXISTS (SELECT 1 FROM unnest(oc.face_names) fn WHERE fn ILIKE ...)`, which the
planner cannot fold into a bitmap OR.

`oracle_cards_face_trgm_idx` was built on `face_names_text(face_names)` for exactly
this predicate — the function doesn't use it.

### The fix already exists next door

`search_card_names` does the same job and **already uses the indexed expression**:

| function | face-name predicate | cold | warm p50 |
|---|---|---|---|
| `search_card_names` | `face_names_text(...)` (indexed) | 720 ms | 84 ms |
| `search_deck_builder_cards` | `EXISTS(unnest(...))` (not indexable) | 7,299 ms | 634–765 ms |

Rewriting the predicate to match `search_card_names` is the whole change. Worth
also splitting the `OR` into a `UNION` of indexable branches so the trigram index
is reachable at all.

### Blast radius

`searchCards()` in `deckBuilderApi.js:226` returns `{ cards: [], error: true }` on
failure — **no Scryfall fallback** (unlike the `cardSearch.js` entry points). So a
timeout renders as an empty result set in the DeckBuilder Add Cards panel.
Error plumbing through `useCardSearch` is correct and now covered by tests.

Measured as `anon` (3 s statement timeout). DeckBuilder is a private route, so real
users are `authenticated` (8 s) and mostly get a 3–4 s hang rather than an error —
but the 8 s ceiling is reachable under the autovacuum I/O storms that follow the
03:20 price sync.

---

## 2. Other RPCs over budget

Post-fix run, with the cold sample correctly excluded from the warm stats:

```
probe                                    first    p50    p95   budget  status
search_deck_builder_cards(bolt)           1608    134    383      400  cold
search_deck_builder_cards(dragon)          467    118    142      400  ok
search_card_names(light)                   642    113    123      400  ok
search_card_art(goblin)                    465     93    103      600  ok
get_recommendation_card_metadata(25)       447     90     98      600  ok
get_deck_builder_display_printings(25)     707     94    102      600  ok
get_community_decks(hot,24)                380    105    119      800  ok
```

Warm p50 is fine everywhere (90–134 ms). The cost is **cold**: the buffer pool is
224 MB and the Scryfall catalogue alone is 291 MB (`card_prints` 177 MB +
`oracle_cards` 114 MB), so it cannot stay resident and cold reads hit disk. The
lever is touching fewer rows, not adding indexes that are already there.

`oracle_cards` is **2.1 KB/row** (94 MB heap / 44,686 rows). `search_deck_builder_cards`
is declared `RETURNS SETOF oracle_cards`, so it hauls every column of a very fat
row. Returning only the columns the UI renders would cut the heap traffic on its own.

---

## 3. `pg_stat_statements` is actively misleading here — don't tune from it

Its counters are lifetime totals since `stats_reset`, which was **157 days** ago
(2026-03-12). Every mean it reports is averaged across months including the
*pre-optimisation* version of each function.

Worked example: it reports `get_public_profile` at a 1.7–5.0 s mean with a **19.7 s**
max across 7 plan variants — which reads like the worst problem in the app. Measured
live it is **38 ms cold / 0.8 ms warm**. The `profile_stats` cache already fixed it;
the historical rows never age out.

It fails the other way too: a function that regressed yesterday is buried under
months of good samples. `card_hashes` still appears in the top-25 despite the table
being dropped in July.

This is why `scripts/dbPerf.harness.js` measures rather than reads counters.

---

## 4. Sourcemaps are published to production

`vite.config.js` sets `build.sourcemap: true`, and the maps are live:

```
GET https://deckloom.app/assets/index-D9_mty88.js.map  →  200, 208,401 bytes
//# sourceMappingURL=index-D9_mty88.js.map              (in the shipped bundle)
```

**11.6 MB across 108 `.map` files**, all publicly fetchable — the complete original
source of the app.

No runtime cost to users: browsers fetch maps only with devtools open, and
`globIgnores: ['**/*.map']` keeps them out of the precache. So this is a source-
disclosure and artifact-weight question, not a speed one. Sourcemaps are 11.6 MB of
the 37 MB `dist/`. Your call — `sourcemap: 'hidden'` keeps them for local debugging
while dropping the `sourceMappingURL` comment.

---

## 5. CI never ran the tests — and the suite couldn't run without a local `.env`

None of the five workflows referenced `npm test` or `npm run lint`. 2,550 tests only
ran when someone remembered to run them locally. Closed by `.github/workflows/ci.yml`.

**The first CI run failed, and the failure was itself a finding.** 45 of 176 suites
died at import:

```
Error: supabaseUrl is required.
 ❯ createClient  node_modules/@supabase/supabase-js/src/index.ts:65:9
 ❯ src/lib/supabase.js:6:19
```

`src/lib/supabase.js` calls `createClient()` at module scope, and supabase-js throws
on undefined input. Every suite that transitively imports it therefore required a
populated `.env` — so **the suite had never been runnable on a clean checkout**. It
went unnoticed because every machine that ran it had a `.env`; CI was the first
environment without one. A 46th suite failed the same way for a different reason:
`scripts/sync-oracle-cards.mjs` calls `process.exit(1)` at import when its service
key is absent, taking `oracleSyncSkip.test.js` with it.

Fixed with stub credentials in `vite.config.js`'s `test.env`, which also closes a
latent hazard: with a real `.env` loaded, any test that forgets to mock Supabase
talks to **production** using the developer's own credentials. The stub URL is
deliberately non-resolvable (`https://stub.supabase.invalid`) so such a test fails
loudly instead. Verified by running the suite with `.env` moved aside — 176/176.

The harnesses are unaffected: they run on `vitest.harness.config.js`, which does not
set these, and still reach real Supabase.

---

## 6. Data invariants — clean, one drift

Checked against production (`scripts/sql/invariants.sql`), 22,139 cards / 299 folders:

| check | result |
|---|---|
| `cards.qty` ≠ sum of placements | **0** |
| owned cards with no placement | **0** |
| zero-qty `deck_allocations` / `folder_cards` | **0** |
| linked-pair links not reciprocated | **0** |
| **linked-pair name drift** | **1** |
| placements in group folders | 0 *(vacuous — 0 group folders exist)* |

The one drift:

```
builder_deck  "Xenagos"                     43029abd-…
deck          "Big creatures tiny brains"   392eeb23-…
both updated_at 2026-07-22 15:12:42.522299+00
```

Identical to the microsecond, so both rows were written by one transaction — this is
a pair *linked* under two different names, not a rename that failed to propagate.
Left alone: it's one row of your data and may well be intentional.

---

## Committed in this pass

| file | what it does |
|---|---|
| `.github/workflows/ci.yml` | lint (`--max-warnings 35`) → build → test, on push/PR. Build precedes test so bundle budgets have a real `dist/`. Does not gate the deploy. |
| `scripts/dbPerf.harness.js` | `npm run harness:db-perf` — times 7 hot RPCs as anon, cold/warm split, flags over-budget. Report → `harness-db-perf.txt`. |
| `src/lib/bundleBudget.test.js` | entry ≤ 35 kB gzip (now 26.9), no route chunk > 150 kB (Stats 128.2), recharts confined to one chunk, precache < 4 MB. Skips without `dist/`. |
| `src/lib/searchFailurePaths.test.js` | timeout ≠ no-results; enrichment failure doesn't lose search results. |
| `src/hooks/useCardSearchFailure.test.jsx` | rejected search must not hang the spinner. |
| `scripts/sql/invariants.sql` | the six checks above, runnable in the SQL editor. |
| `supabase/migrations/20260816…_speed_up_deck_builder_card_search.sql` | the §1 fix. Applied to production. |

### Bug fixed in passing

`src/hooks/useCardSearch.js` awaited `searchCards()` with no `try/catch`. A rejection
(offline, DNS, aborted fetch) skipped `setLoading(false)` — **the Add Cards spinner
span forever** and the rejection went unhandled. Both new hook tests failed against
the old code and pass now. Load-more failures deliberately keep already-loaded pages.

### Harness bug caught by its own output

The first post-migration run had `p95` exactly equal to `first` on all seven
probes. That was not a coincidence in the data — the cold sample was being
pushed into the warm distribution, so `p95` was just restating `first` while the
header claimed it was warm. Fixed; warm stats now start at the second call. The
pre-fix numbers in §1's "before" column are unaffected (they were failures and
p50s, not p95s).

### Incidental

`harness:build-assist` was `vitest run --config vitest.harness.config.js` with no file
argument, and that config globs `scripts/**/*.harness.js` — adding a second harness
would have silently pulled it into that command. Both scripts now name their file.

---

## Not done

- **Browser-side route measurement** (Home, Collection, DeckBuilder render cost,
  Web Vitals). AGENTS.md forbids browser-control tools for verifying DeckLoom, and
  the meaningful numbers need a real login against a real collection. The `perfSpan`
  instrumentation in `src/lib/perf.js` already emits `av:*` marks — the fastest route
  is you loading those surfaces with the Performance panel open. Say the word and
  I'll build a scripted Lighthouse/Playwright run instead.
- **Soak / memory-growth testing.** Needs a long-running real session; same blocker.
- **Whole-app route sweep.** Only the RPCs behind the hot surfaces were probed.

`src/lib/perf.js` cites `performance-upgrade-plan.md`, which no longer exists.

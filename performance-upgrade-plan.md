# Performance Upgrade Plan — Web (PC/mobile browser) + Android (Capacitor)

Goal: close the perceived-speed gap to native apps like Manabox. The two
structural costs are (1) the startup hydration wall — all ~12k cached card
entries are deserialized from IndexedDB into one in-memory map before
collection pages feel alive — and (2) zero offline asset caching: every visit
re-fetches bundles and card images. Everything below attacks one of those or
the network chatter around them.

Baseline reference (2026-06-12, ~12k-card collection): IDB metadata cache hit
logs `[SF IDB] loaded 11974 cards`; price overlay already optimized (2 IDB
index reads + 6-wide chunk fetches). No service worker. Stats JS chunk 440 kB
(recharts). Scanner already uses native SQLite on Android via
`DatabaseService` — proof the plugin path works in this app.

---

## Phase 0 — Measure first (half a day)

- Add `performance.mark/measure` around: bundle boot → React mount, IDB
  hydration (`getInstantCache`), price overlay, first card grid paint.
  Log in dev + expose in CacheDebug.
- Capture Lighthouse (web) and a cold/warm stopwatch run on the Android APK.
- Output: a small table in this file; every later phase quotes before/after.

## Phase 1 — Service worker / PWA (1–2 days) — biggest perceived win

Both platforms benefit (Android WebView supports SW).

- `vite-plugin-pwa` (Workbox):
  - **Precache** hashed `/assets/*` + index.html (app shell loads from disk).
  - **Cache-first + LRU cap** for card images (`cards.scryfall.io`,
    `svgs.scryfall.io`) — e.g. 4k entries / 30 days. Grids render instantly on
    revisit, offline included.
  - **Network-only** for Supabase REST/auth (sync must stay live).
- Update UX: on new deploy, show a ToastContext toast "Update available —
  Refresh" (skipWaiting on accept). Guards against stale-app bugs.
- Manifest + icons → installable PWA ("Add to Home Screen") — free promo win.
- Compatibility notes: GitHub Pages scope `/` fine; the 404.html SPA redirect
  is unaffected (SW serves index.html from cache for navigations).
- Risks: stale deploys (mitigated by update toast), cache bloat (capped).

## Phase 2 — Kill the hydration wall (2–4 days) — biggest real win

1. **Split the metadata record.** New IDB layout: `card_core` (name, set,
   collector number, type_line, rarity, cmc, color identity, image URIs,
   prices — ~0.3 kB) vs `card_full` (oracle_text, keywords, faces, …).
   Boot hydrates **core only** (~4 MB instead of 30–50 MB). Oracle-needing
   surfaces (CardDetail, deck builder category inference via `requireOracle`,
   bracket analyzer) load full records on demand — the `requireOracle`
   plumbing already exists in `loadCardMapWithSharedPrices`.
2. **Hydrate off the main thread.** Reuse the `filterWorker` pattern: a worker
   opens IDB (available in workers), reads + assembles the map, posts it back.
   UI paints skeletons immediately; React Query resolves when the worker
   finishes. Existing `hydrateCollectionQueriesFromIdb` becomes worker-backed.
3. **Per-page laziness.** Home renders its snapshot from the first N rows;
   only Collection/Stats need the full core map.
4. **Cached tile values (stale-while-revalidate display).** Folder/deck tiles
   on Folders/Builder/Lists currently render instantly but their values pop in
   after placements + prices resolve. Persist each folder's last computed
   value (`folder_id → { value, count, computedAt }` in IDB), render it with
   the tiles on first paint, recompute in the background and update only on
   change. Values move at most daily, so the cached number is almost always
   already right — eliminates the pop entirely rather than just shrinking it.
- Migration: one-time IDB re-shape with version bump in `db.js`; cache
  rebuilds lazily if absent (existing enrichment path already handles cold).
- Acceptance: warm reload → interactive Collection under ~1 s on mid phone;
  no main-thread task > 200 ms during boot.

## Phase 3 — Server-side card_prints completeness (1 day) — helps cold starts

- Extend the existing GitHub Action (`backfill-card-prints.mjs`) to seed
  `card_prints` from **Scryfall bulk data** nightly (bulk downloads are
  exempt from their rate limits).
- Result: a fresh device fills its local cache from fast Supabase batch reads
  instead of 75-card Scryfall batches with 120 ms spacing — first-ever load on
  a 12k collection drops from minutes to seconds. Benefits web + Android + new
  users equally.

## Phase 4 — Android-native storage (spike 1 day, then 2–4 days if green)

- Abstract the metadata cache behind a `cardStore` interface; implement
  SQLite-backed store for native (same plugin the scanner's
  `DatabaseService` uses), IDB for web. After Phase 2 the hydrated core map is
  small, so SQLite's wins here are cold-start I/O and write throughput in the
  WebView (IDB in Android WebView is markedly slower than desktop Chrome).
- Optional follow-up: Wi-Fi-only background bulk seed on native for true
  Manabox-style "everything local" search.
- Decision gate: only proceed past the spike if profiling shows IDB-in-WebView
  is still a top-3 cost after Phases 1–2.

## Phase 5 — Asset & bundle trims (1 day, lowest priority)

- Cloudflare Cache Rule: `/assets/*` → cache everything, 1-year edge TTL
  (hashed filenames make this safe); GitHub Pages' default 10-min TTL wastes
  the proxy we now have.
- Stats chunk (440 kB): lazy-import recharts inside the chart components so
  the Stats route shell paints before chart code arrives.
- Income audit of `vendor-supabase` (196 kB) — likely fine, measure first.

## Explicitly not doing (for now)

- **SQLite-over-WASM/OPFS on web** — real but heavy architecture change;
  revisit only if Phases 1–2 don't hit targets.
- SSR/prerendering — wrong tool for a logged-in IDB-first app.
- Rewriting in native/Flutter — the WebView ceiling is acceptable once warm
  loads are instant.

## Order & rough effort

| Phase | Effort | Platforms | Expected effect |
|---|---|---|---|
| 0 Measure | 0.5 d | both | baseline numbers |
| 1 Service worker | 1–2 d | both | repeat visits near-instant; images cached |
| 2 Hydration wall | 2–4 d | both | warm interactive < 1 s; no jank on boot |
| 3 card_prints bulk seed | 1 d | both | first-ever load: minutes → seconds |
| 4 Native SQLite spike | 1 d (+2–4 d) | Android | cold start I/O; gated on data |
| 5 Asset/bundle trims | 1 d | both | marginal, cheap |

Suggested sequencing: 0 → 1 → 2 → 3, re-measure, then decide 4/5.

## Resolution (2026-06-14)

Phases 0–2 shipped (incl. the Phase 2e price-overlay deep-dive: negative
cache + worker price prefetch). After re-measuring, the remaining phases were
decided as follows:

- **Phase 3 (card_prints bulk seed) — SKIPPED.** Cold-start on a new device is
  a one-time cost and per-load speed is already solved; not worth hundreds of
  MB on the 500 MB free tier. Revisit if first-load complaints appear or the
  tier is upgraded.
- **Phase 4 (Android SQLite) — SKIPPED.** Was gated on the numbers, which came
  back healthy (hydrate ~280 ms off-thread, overlay ~95 ms). IDB-in-WebView is
  no longer a top cost. Revisit only if the APK feels slow in real use.
- **Phase 5 — only the Cloudflare asset cache rule is worth doing** (hand-off:
  dashboard Cache Rule, URI path contains `/assets/`, Edge+Browser TTL 1 year;
  hashed filenames make this safe — live headers were `max-age=14400` +
  REVALIDATED). The recharts lazy-import was dropped: Stats is already
  route-split, so the benefit is negligible for the refactor risk.

Net: performance work is considered complete. Outstanding is the one manual
Cloudflare cache-rule tweak.

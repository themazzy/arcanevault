# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## ⚠️ Do Not OverUse Subagents

Only spawn subagents (Agent tool) when necessary for this project. Try to perform research, searches, and edits directly in the main conversation. Subagents waste tokens.

---

## ⚠️ Handling Ambiguous Instructions — READ THIS FIRST

**This is the highest-priority rule in this file.**

When a prompt contains requirements that could be interpreted in more than one meaningful way, **stop immediately and ask the user to choose** before writing any code. Present the ambiguous points as a numbered list with brief trade-off notes for each option.

**Do not:**
- Guess or pick the "most likely" interpretation
- Start coding and ask mid-way through
- Assume you understand scope without confirming

**Do:**
- Ask upfront, before any code is written
- Present concrete options (not open-ended questions)
- Include trade-offs so the user can make an informed choice

The cost of a 30-second clarification is always lower than building the wrong thing. When in doubt, ask.

---

## Project Overview

**DeckLoom** is a personal Magic: The Gathering collection tracker hosted at **https://deckloom.app/** (served via GitHub Pages with a custom domain). Users catalog owned cards, organise them into binders/decks/wishlists, track prices and P&L, build decks, scan cards with camera OCR, view collection analytics, manage tournaments, and trade cards. Also packaged as a native Android app via Capacitor.

**Stack:** React 18 + Vite + Supabase + IndexedDB + TanStack React Query

---

## Commands

```bash
npm run dev       # Start Vite dev server (http://localhost:5173) with API proxies
npm run build     # Production build → dist/
npm run preview   # Preview production build locally
```

There is no test runner configured. There are no lint scripts — Vite's dev server surfaces JSX/import errors on save.

---

## Environment

Copy `.env.example` to `.env` and fill in:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are required at startup; the app will fail silently without them.

---

## Deployment — GitHub Pages (custom domain) + Android (Capacitor)

The web app is deployed to **https://deckloom.app/** via GitHub Actions (`.github/workflows/deploy.yml`). The Android APK is built by `.github/workflows/build-android.yml` (runs `npm ci` → `vite build` → `cap sync android` → Gradle).

### Critical GitHub Pages files — do not remove or modify without care:

| File | Purpose |
|---|---|
| `public/404.html` | Catches 404s from direct URL access; encodes the path as a query param and redirects to `index.html`. Auto-detects custom domain vs `*.github.io` subpath via `pathSegmentsToKeep`. |
| `index.html` (redirect script) | Decodes the query param from `404.html` and restores the correct route via `history.replaceState` |
| `public/CNAME` | Maps the GitHub Pages site to `deckloom.app` |
| `vite.config.js` | `base: '/'` — assets serve from root (custom domain), not a subpath |

`BrowserRouter` in `src/App.jsx` uses the default basename (`/`); do **not** add `basename="/arcanevault"` back — it's a legacy artifact from the old `themazzy.github.io/arcanevault/` URL.

### Email links

`src/components/Auth.jsx` passes `emailRedirectTo: 'https://deckloom.app/'` in `signUp()` to ensure Supabase confirmation emails link to prod, not localhost. Production-URL helpers live in `src/lib/publicUrl.js` (`getPublicBaseUrl()`, `getPublicAppUrl(path)`) — always use those instead of hardcoding `deckloom.app`.

### Native OAuth (Capacitor)

Social login under Capacitor cannot use the web `redirectTo` (the browser would land on `deckloom.app` and the app would never see the session). Instead:

- Supabase client uses `flowType: 'pkce'` (`src/lib/supabase.js`).
- `src/lib/nativeAuth.js` exposes `openNativeOAuth(provider)` which calls `signInWithOAuth({ redirectTo: 'deckloom://auth/callback', skipBrowserRedirect: true })`, then opens the URL via `@capacitor/browser`.
- `registerNativeAuthDeepLinkHandler()` (registered in `src/main.jsx`) listens for `App.appUrlOpen` and calls `sb.auth.exchangeCodeForSession(url)` when the OS routes the `deckloom://auth/callback?code=…` deep link back into the app, then closes the in-app browser.
- `android/app/src/main/AndroidManifest.xml` declares an `<intent-filter>` for `android:scheme="deckloom"` `android:host="auth"`. The deep-link URL must also be on the Supabase Auth → Redirect URLs allow-list.
- iOS is not yet shipped; when it is, mirror the scheme in `ios/App/App/Info.plist` (`CFBundleURLTypes`).

`isNativeApp()` from `src/lib/nativeAuth.js` is the canonical check for "running under Capacitor" in auth flows.

### Social share previews (Open Graph) — `deckloom-og` Cloudflare Worker

Deck share links are the direct `https://deckloom.app/d/<id>` URL (built via `getPublicAppUrl` in `src/lib/publicUrl.js`). Rich previews for link crawlers are served by a **Cloudflare Worker** (`cloudflare/og-worker/`) routed at `deckloom.app/d/*` — the domain's DNS is on Cloudflare, so the worker runs on the branded URL itself:

- **Crawler UA** (`isCrawler` in `og.js`) → 200 `text/html` with deck-specific `og:`/`twitter:` tags + commander/key-card `art_crop` image. No redirect in the HTML — it's served at the canonical URL, a redirect would loop.
- **Everyone else** → transparent `fetch(request)` pass-through to the GitHub Pages SPA. Removing the worker degrades gracefully to generic previews.
- Deck metadata comes from the `get_deck_og_meta(uuid)` SECURITY DEFINER RPC, which **returns null for any non-public deck** — private decks never leak.
- Deployed manually via `wrangler deploy` (see `cloudflare/og-worker/README.md`); requires the Cloudflare DNS records to be **Proxied** (orange cloud) and SSL mode **Full**.
- Pure helpers in `og.js` are unit-tested in `src/lib/ogWorker.test.js`.
- History: a previous `og-deck` Supabase Edge Function did the same job but made share links point at `*.supabase.co` (ugly, plus the Edge Runtime forces `Content-Type: text/plain` on the shared domain). It was removed 2026-06 and replaced by this worker.

---

## Architecture

### Data Flow — Offline-First

The most important architectural principle: **IDB is the primary data store; Supabase is the sync backend.**

```
User action
  → write to Supabase (authoritative source)
  → sync pulled into IDB on next load
  → all reads come from IDB (instant, offline-capable)
```

- `src/lib/db.js` — All IndexedDB access. Use `getLocalCards(userId)`, `getLocalFolders(userId)`, `getAllLocalFolderCards(folderIds)` for reads. `replaceLocalFolderCards(folderIds, rows)` is the bulk-reconcile helper. Never bypass IDB for performance-critical pages.
- `src/lib/supabase.js` — Exports the `sb` singleton. Used for auth + cloud sync fallback only.
- `src/lib/scryfall.js` — Scryfall metadata/art cache. `getInstantCache()` returns in-memory map (null if cold); always guard with `sfMap || {}`.

**React Query layer:** Collection data loading is migrated to **TanStack React Query** (`@tanstack/react-query`). The `queryClient` is in `src/lib/queryClient.js` (staleTime 5 min, gcTime 30 min, networkMode `offlineFirst`). On startup, `hydrateCollectionQueriesFromIdb()` from `src/lib/idbQueryBridge.js` seeds the cache from IDB so the first render is instant. Query keys: `['cards', userId]`, `['folders', userId]`. Pages that previously read IDB directly may now use `useQuery` hooks backed by `src/lib/collectionFetchers.js`.

**Key gotcha:** Never use Supabase's nested `select('folder_cards(cards(*))')` — it requires FK relationships configured in PostgREST and silently returns empty. Always do flat queries and join in memory.

### Group Folders

Folders whose description JSON contains `"isGroup": true` are organisational group containers, not placement folders. `isGroupFolder(folder)` (exported from `src/lib/collectionFetchers.js`) identifies them. Group folders must be excluded from `folder_cards` queries, placement writes, and allocation logic.

### Pricing

- Shared market prices live in Supabase `card_prices` with `today` + `yesterday` retention.
- Client pages that show collection values should load prices through `src/lib/sharedCardPrices.js`.

- `getPrice(sfCard, foil, { price_source })` → numeric value
- `formatPrice(value, priceSourceId)` → `"€1.23"` or `"$1.23"`
- `getPriceWithMeta(sfCard, foil, opts)` → `{ value, symbol, isFallback, pct }`
- Manual overrides stored in `localStorage` as `arcanevault_manual_prices`
- Price source from `useSettings().price_source` — always pass it down; never hardcode.

### Icons

All SVG icons live in **`src/icons/index.jsx`** — this is the single source of truth for iconography.

- 56 icons, all `viewBox="0 0 16 16"` (except `SettingsIcon` which uses `0 0 24 24` to match its detailed gear path), `currentColor`, props: `size` (default 16), `color`, `className`.
- **`SettingsIcon`** uses the same detailed Material-style gear as the CardScanner menu button. Do not replace it with a simpler cog.
- `src/components/Icons.jsx` is a compatibility shim — it re-exports folder-type icons from `src/icons`. Import new icons directly from `../icons` (or `../../icons` from scanner/).
- When adding new icons, add them to `src/icons/index.jsx` following the existing pattern. Never use `⚙`, `☰`, `✕`, `⊞`, `≡`, `⊟` Unicode characters as icon substitutes — use the SVG components instead.

Categories: Navigation · Actions · Folder types · View modes · Status · Game · UI chrome.

### Settings

`useSettings()` returns all user preferences plus `save(patch)`, `syncNow()`, sync status, and the last sync error. Settings write to `localStorage` immediately and debounce a Supabase upsert (800 ms).

Important settings: `theme`, `oled_mode`, `higher_contrast`, `reduce_motion`, `font_size`, `font_weight`, `card_name_size`, `price_source`, `grid_density`, `show_price`, `cache_ttl_h`, `default_grouping`, `nickname`, `anonymize_email`, `keep_screen_awake`, `show_sync_errors`, `premium`, `profile_config`.

Always read these values from `useSettings()` instead of hardcoding defaults.

#### Premium Themes

`PREMIUM_THEMES = new Set(['obsidian', 'crimson_court', 'verdant_realm'])` — these themes require `settings.premium === true`. The `premium` flag is set server-side only (Stripe webhook → edge function → `user_settings`). **Never** allow client code to set `premium: true` directly; `SettingsContext` strips it from any local write. On successful Stripe checkout, the URL will contain `?premium_checkout=success` — `SettingsContext` detects this, polls for the server flag, and applies the theme.

`DEFAULT_BENTO_CONFIG` is exported from `SettingsContext` and used by `Profile.jsx` for the bento-grid block order.

### Filtering & Sorting

Heavy filtering runs in a **Web Worker** (`src/lib/filterWorker.js`). The worker receives `{ id, cards, sfMap, search, sort, filters, priceSource, cardFolderMap }` and posts back sorted results. `matchNumeric(valStr, op, minStr, maxStr)` handles `= | < | <= | > | >= | between | in`.

The same filter logic is duplicated in `CardComponents.jsx` for the non-worker path — keep both in sync when changing filter operators.

`EMPTY_FILTERS` is exported from `CardComponents.jsx` — always spread it as defaults.

### Collection Folder Membership Sync

`src/pages/Collection.jsx` loads binder/deck membership in two phases:

1. Read `folders` + `folder_cards` + `deck_allocations` from IDB first and build `cardFolderMap` immediately.
2. React Query (`placementsQuery` with `fetchFolderPlacements`) full-fetches `folder_cards` + `deck_allocations` from Supabase on load and writes through to IDB. `staleTime` is 10 min; mutations call `queryClient.invalidateQueries(['folderPlacements', user.id])` to force a refetch.

Deletes are hard `.delete()` calls — full fetches see absent rows naturally, so soft-delete didn't buy us anything and just leaked dead tuples. If you change placement writes, preserve `updated_at` behavior on `folder_cards` and keep `deck_allocations` sync logic aligned or collection/deck badges will drift.

### Collection Ownership Rules

Owned collection cards cannot exist without at least one binder or collection-deck placement.

- `src/lib/collectionOwnership.js` holds the cleanup helpers.
- When removing cards from binders or collection decks, only delete the underlying `cards` row if no `folder_cards` or `deck_allocations` placement remains anywhere else.
- Deleting a non-empty binder or deck must offer transfer options so cards can be moved instead of being implicitly deleted.

### Deck Model

- `deck_cards` is the source of truth for intended deck contents in Builder.
- `deck_allocations` is the source of truth for owned cards assigned into collection decks.
- `folder_cards` is for binder/list placement and should not be used as deck-content truth.
- Collection deck sync and "Make Collection Deck" must operate on exact owned `cards.id` rows, not just card names.
- Foil and non-foil must be treated as different exact matches in allocation logic.

#### Linked Deck Pairs

A builder deck (`builder_deck`) and a collection deck (`deck`) can be linked as a pair. Linking is stored in each folder's description meta blob (managed by `parseDeckMeta` / `serializeDeckMeta` in `deckBuilderApi.js`):

- `linked_deck_id` — stored on the builder deck, points to the paired collection deck `folder.id`
- `linked_builder_id` — stored on the collection deck, points to the paired builder deck `folder.id`
- `sync_state` — `{ version, last_sync_at, last_sync_snapshot, unsynced_builder, unsynced_collection }` — tracks per-pair drift

Key helpers in `src/lib/deckSync.js`:
- `getLinkedDeckIds(folderOrMeta)` — extracts both IDs from either a folder row or a parsed meta object
- `getSyncState(folderOrMeta)` — returns current sync state with safe defaults
- `withLinkedPair(meta, { linkedDeckId, linkedBuilderId })` / `clearLinkedPair(meta, side)` — immutably update link fields
- `writeSyncState(meta, syncState)` — immutably update sync_state
- `normalizeBuilderCards(rows)` / `normalizeCollectionCards(rows)` — canonicalize cards for diff comparison

In `Builder.jsx`, clicking a collection deck that has `linked_builder_id` navigates to the builder version at `/builder/<linked_builder_id>` instead of the collection deck view.

Format legality and commander color identity checks are in `src/lib/deckLegality.js` via `getCardLegalityWarnings({ card, formatId, formatLabel, isEDH, commanderColorIdentity })`.

### Wishlist Rules

Wishlists are not part of owned collection inventory.

**Collaborative sharing:** wishlists share via the same `shared_folders` token as binders/decks (`components/ShareModal.jsx`, used by both Folders and Lists). On the public `/share/:token` page, a `list`-type folder renders the collaborative wishlist view: items + per-viewer claim flags come from the `get_shared_wishlist(token)` SECURITY DEFINER RPC, and viewers toggle "I'll get this" via `toggle_wishlist_claim(token, item_id, claimed)`. Both RPCs are authenticated-only (Share.jsx requires sign-in) and gated by the token resolving to the item's folder. `list_items.claimed_by`/`claimed_at` hold claims. The list **owner is shown no claim state** (preserves the gift surprise) and cannot claim their own list; claims never reveal the claimer's identity to other viewers.

**Auto-sync with collection** (`src/lib/wishlistSync.js`): `removeAcquiredFromWishlists()` drops a wishlist item when its exact print+foil is acquired (wired into AddCardModal + ImportModal collection saves, dispatches `av:wishlist-updated`); wishlist imports skip cards already owned by name (`findOwnedCardNames()`).

- Wishlist browsing should match binder/deck browsing for view toggles, selection styling, and bulk actions.
- Wishlist bulk move must only allow destinations of type `list`.
- Wishlist grid rendering should use the shared binder-style `CardGrid`, not a separate wishlist-only grid implementation.
- `list_items` access is folder-owned: inserts and policies should derive ownership from the parent folder, not rely on a caller-supplied `list_items.user_id`.

### Selection And Quantity Semantics

- Bulk selection counts should use selected copy count when `selectedQty` is available, not just distinct card rows.
- In quantity adjusters, pressing `-` at `1 of N` should deselect that card entirely.
- In collection, expanded per-folder tiles must use folder-specific quantity from `folder_cards.qty` for badges and selection totals instead of merged collection quantity.

### Routing

React Router v6. `BrowserRouter` in `src/App.jsx` uses the default basename (`/`) — the site is served from the root of `deckloom.app`.

**Public routes** (outside `PrivateApp`): `/legal`, `/terms`, `/privacy`, `/storage`, `/credits`, `/delete-account`, `/share/:token`, `/d/:id`, `/join/:code`, `/join-tournament/:code`.

**Private routes** (require auth): all others, wrapped in `PrivateApp`.

Full route map:
```
/                        → Home.jsx
/collection              → Collection.jsx
/decks                   → Folders.jsx (type=deck)
/binders                 → Folders.jsx (type=binder)
/lists                   → Lists.jsx
/trading                 → Trading.jsx
/stats                   → Stats.jsx
/life                    → LifeTracker.jsx
/tournaments             → Tournaments.jsx
/settings                → Settings.jsx
/help                    → Help.jsx
/rules                   → Rulebook.jsx
/admin                   → Admin.jsx  (admin_users only)
/builder                 → Builder.jsx
/builder/:id             → DeckBuilder.jsx
/builder/:id/playtest    → DeckGoldfish.jsx (deck playtester)
/scanner                 → Scanner.jsx
/profile/:username       → Profile.jsx (public)
/d/:id                   → DeckView.jsx (public deck shortlink)
/join/:code              → JoinGame.jsx (public)
/join-tournament/:code   → JoinTournament.jsx (public)
/share/:token            → Share.jsx (public)
```

A linked collection deck navigates to `/builder/<linked_builder_id>` rather than `/deck/<id>`.

### CORS-restricted third-party APIs

- **EDHREC** needs no proxy: `json.edhrec.com/pages/` sends `Access-Control-Allow-Origin: *` and is fetched directly in all environments.
- **Deck URL imports** (Archidekt, Moxfield, Goldfish) go through the Cloudflare Worker at `deckloom.app/api/import/<source>/<id>` in all environments (strict source/id validation in `cloudflare/og-worker/worker.js`). Archidekt and Moxfield work; **MTGGoldfish blocks server-side fetches** with a Cloudflare JS challenge — its import fails with a message steering users to paste the decklist.
- **Commander Spellbook combos**: dev uses the `/api/combos` Vite proxy (the only proxy left in `vite.config.js`); prod uses the `combo-proxy` Supabase Edge Function.

---

## Key Files

| File | Role |
|---|---|
| `src/icons/index.jsx` | **Unified icon system** — SVG icons; single source of truth for iconography |
| `src/lib/db.js` | IDB layer — all local reads/writes |
| `src/lib/scryfall.js` | Scryfall metadata/image cache + batch lookup helpers |
| `src/lib/sharedCardPrices.js` | Overlays shared Supabase daily prices onto cached Scryfall card data |
| `src/lib/filterWorker.js` | Web Worker: filter + sort logic |
| `src/lib/queryClient.js` | TanStack React Query client (staleTime 5m, gcTime 30m, offline-first) |
| `src/lib/collectionFetchers.js` | Supabase fetch helpers for cards/folders; `isGroupFolder()` |
| `src/lib/idbQueryBridge.js` | `hydrateCollectionQueriesFromIdb()` — seeds React Query cache from IDB at startup |
| `src/lib/deckData.js` | `fetchDeckCards()` from `deck_cards_view`; `mergeAllocationRows()` |
| `src/lib/deckAllocationPlanner.js` | Plans which owned card rows to assign when linking a builder deck |
| `src/lib/exportUtils.js` | `cardsToCSV()` — Manabox-compatible CSV export |
| `src/lib/admin.js` | `isCurrentUserAdmin()` — checks `admin_users` table |
| `src/lib/consent.js` | GDPR consent preferences (necessary/analytics/marketing/preferences) stored in localStorage |
| `src/lib/publicUrl.js` | `getPublicBaseUrl()`, `getPublicAppUrl(path)` — prod/dev URL helpers (Capacitor-aware; prod origin = `https://deckloom.app`) |
| `src/lib/nativeAuth.js` | Capacitor OAuth: `isNativeApp()`, `openNativeOAuth(provider)`, `registerNativeAuthDeepLinkHandler()`; PKCE flow via `deckloom://auth/callback` |
| `src/lib/tournament.js` | Tournament logic: formats, structures, standings, result recording |
| `src/lib/networkUtils.js` | `isNetworkLikeError()`, `createOfflineError()` |
| `src/scanner/DatabaseService.js` | Hash-pack orchestrator: manifest → IDB blob cache → same-origin fetch; feeds chunks to the match worker; sync fallback matcher |
| `src/scanner/hashPack.js` | Binary hash-pack format (encode/decode/`HashPackStore`); image URLs derived from scryfall id — shared with Node build script |
| `src/scanner/matchCore.js` | LSH band index + ranking over packed hash arrays — shared by worker and main-thread fallback |
| `src/scanner/packLoader.js` | Manifest/chunk fetch + IDB blob caching (`scanner_pack` store); native falls back to deckloom.app for post-APK chunks |
| `src/scanner/prefetch.js` | Idle-time warmup (app shell): pack chunks → IDB; gated on prior scanner use |
| `src/scanner/visionCore.js` | Pure-JS vision primitives (replaced OpenCV.js): Canny, contours, approxPolyDP, minAreaRect, perspective warp, INTER_AREA-equivalent resize |
| `src/scanner/ScannerEngine.js` | Card pipeline over visionCore: 3-pass quad detection + scoring, warp, art/reticle crops, 180° rotation, pHash variants — pure, canvas-free |
| `src/scanner/visionWorker.js` | Runs the whole vision pipeline off the main thread; holds the current warped card + collector strip between hash batches |
| `src/scanner/visionClient.js` | Main-thread handle on visionWorker (transferable frames); synchronous main-thread fallback |
| `src/scanner/collectorOcr.js` | Collector-line OCR (tesseract.js, self-hosted under `public/ocr/`): noise-tolerant parsing, set-candidate expansion; refines printing + language after a scan |
| `src/scanner/nameMatch.js` | Fuzzy card-name matching for title-OCR rescue: banded prefix-Levenshtein over all pack names, uniqueness-margin gated |
| `src/scanner/hashCore.js` | Pure-JS pHash core: precomputed DCT cosine table, CLAHE, percentileCap, Hamming distance — shared with seed script |
| `src/scanner/constants.js` | Shared card/art dimensions: `CARD_W=500, CARD_H=700, ART_X=38, ART_Y=66, ART_W=424, ART_H=248` |
| `src/scanner/CardScanner.jsx` | Full-screen scanner UI: camera, auto-scan loop, targeting reticle, stability buffer, settings panel, match basket |
| `src/pages/Scanner.jsx` | Route wrapper for `CardScanner` at `/scanner` |
| `scripts/generate-card-hashes.js` | Node.js seed script (pipeline v7): Scryfall bulk → hashes (art/color/full, incl. DFC back faces) → writes `public/scanner/hashpack/` directly. The pack is its own incremental state — no Supabase involved. Crash-safe checkpoints every 8k rows |
| `src/scanner/hashCard.js` | Seed-side hash computation from a perfect 500×700 card render — shares the exact 32×32 area-resize with the live scanner |
| `src/lib/fx.js` | EUR↔USD conversion via frankfurter.app (6 h IDB cache) |
| `src/lib/valueSnapshots.js` | Daily collection-value snapshots (`collection_value_snapshots`, 1 row/user/day): `recordCollectionValueSnapshot()`, `fetchValueHistory()`, `computeValueDelta()` — powers Stats "Value Over Time" |
| `src/lib/setCompletion.js` | Set-completion missing-cards view: `fetchSetCards()` (Scryfall, session cache), `computeMissingCards()`, `missingCostTotal()`, `addMissingToWishlist()` |
| `src/lib/deckBuilderApi.js` | Deck builder helpers + external API calls |
| `src/lib/deckSync.js` | Linked deck sync: `getLinkedDeckIds()`, `getSyncState()`, `withLinkedPair()`, `clearLinkedPair()`, `writeSyncState()`, `normalizeBuilderCards()` |
| `src/lib/deckLegality.js` | `getCardLegalityWarnings()` — format legality + commander color identity checks |
| `src/lib/commanderBracket.js` | Commander Bracket estimator: `analyzeBracket()` (Game Changers / MLD / extra turns / 2-card combos), `fetchGameChangerNames()` (Scryfall `is:gamechanger`, 7-day localStorage cache). UI: `components/BracketBadge.jsx` — clickable pill in the DeckStats pills row (popover with reasons, flagged cards, combo check, manual 1–5 override). `DeckStats` accepts `showBracket` + `combos` props; DeckBuilder passes `showBracket={isEDH}` |
| `src/lib/importFlow.js` | Import pipeline: `parseImportText()`, `resolveImportEntries()`, `summarizeImportRows()`, `aggregateResolvedRows()`, `fetchPaperPrintings()` |
| `src/lib/csvParser.js` | Manabox CSV → cards + folders |
| `src/components/CardComponents.jsx` | `FilterBar`, `CardDetail`, `CardGrid`, `EMPTY_FILTERS`, `applyFilterSort`, `BulkActionBar` |
| `src/components/VirtualCardGrid.jsx` | Virtualised card grid (@tanstack/react-virtual) |
| `src/components/UI.jsx` | Shared UI primitives: `Button`, `Input`, `Modal`, `SectionHeader`, `Select`, `Badge`, `EmptyState`, `ErrorBox`, `ProgressBar` |
| `src/components/ToastContext.jsx` | `ToastProvider` + `useToast()` — action toast notifications (success/error/info, auto-dismiss 3.2 s) |
| `src/components/SetupWizard.jsx` | `SetupWizardProvider` + `useSetupWizard()` — first-time setup flow (fires once, gated by `user_metadata.setup_completed`) |
| `src/components/Layout.jsx` | Main app shell: glass-pill floating navbar, desktop sidebar nav, mobile bottom tabs |
| `src/components/AddCardModal.jsx` | Add card modal: scan (OCR) or manual search + queue |
| `src/components/ImportModal.jsx` | Bulk import wizard: CSV / txt / paste, for binders/decks/wishlists |
| `src/components/ExportModal.jsx` | Export collection/deck/binder as Manabox-compatible CSV |
| `src/components/SettingsContext.jsx` | `SettingsProvider` + `useSettings()` + `THEMES` + `PREMIUM_THEMES` + `DEFAULT_BENTO_CONFIG` |
| `src/components/Auth.jsx` | `AuthProvider` + `useAuth()` + `LoginPage` |
| `src/pages/Collection.jsx` | Main collection browser (IDB-first, worker filter) |
| `src/pages/Home.jsx` | Dashboard — collection snapshot, card lookup, recently viewed, changelog news |
| `src/pages/Folders.jsx` | Binders index + `FolderBrowser` (inline grid/list view toggle, `BinderListView`) |
| `src/pages/Lists.jsx` | Wishlists index + `ListBrowser` (inline list/grid view toggle, `WishlistGrid`) |
| `src/pages/Builder.jsx` | Builder deck index — deck tiles with art backgrounds, linked-pair sync badges, select mode |
| `src/pages/DeckBuilder.jsx` | Full deck builder UI at `/builder/:id` — card list, boards, import, linked sync |
| `src/pages/DeckBuilder.module.css` | Styles for DeckBuilder — do not confuse with `DeckView.module.css` |
| `src/pages/DeckGoldfish.jsx` | Deck playtester at `/builder/:id/playtest` |
| `src/pages/DeckBrowser.jsx` | Card browser inside a deck — list/stacks/grid/text/table views |
| `src/pages/DeckView.jsx` | Shared deck view page (collection decks + builder decks); public shortlink at `/d/:id` |
| `src/pages/DeckView.module.css` | Styles for DeckView — do not confuse with `DeckBuilder.module.css` |
| `src/pages/Profile.jsx` | Public user profile at `/profile/:username` — bento-grid layout (bio, stats, deck showcase) |
| `src/pages/Admin.jsx` | Admin panel at `/admin` — feedback triage, users, premium grants, deletions, changelog editor; requires `admin_users` membership |
| `src/pages/Settings.jsx` | Dedicated settings page at `/settings` |
| `src/pages/Rulebook.jsx` | MTG comprehensive rulebook browser at `/rules` — category/section/rule search |
| `src/pages/Tournaments.jsx` | Tournament manager at `/tournaments` — multiple formats/structures, standings, stored in localStorage |
| `src/pages/Trading.jsx` | Trade value comparison at `/trading` — match collection cards against a want list |
| `src/pages/Stats.jsx` | Collection analytics |
| `src/pages/LifeTracker.jsx` | Multiplayer life tracker — pre-game setup, game screen, player-settings overlay, commander damage, lobby |
| `src/pages/LifeTracker.module.css` | Styles for LifeTracker |
| `src/pages/JoinGame.jsx` | Public route `/join/:code` — join a multiplayer lobby |
| `src/pages/JoinTournament.jsx` | Public route `/join-tournament/:code` — join a tournament |
| `src/pages/Share.jsx` | Public route `/share/:token` — view a shared deck/folder |
| `src/components/FeedbackModal.jsx` | Bug report / feature request modal |

---

## Patterns & Conventions

### CSS Modules

Every page and major component has a paired `.module.css`. Use CSS variables for theming:

```css
var(--gold)          /* #c9a84c — primary accent */
var(--bg)            /* page background */
var(--bg2)           /* card/panel background */
var(--bg3)           /* nested elements */
var(--border)        /* subtle border */
var(--border-hi)     /* highlighted border */
var(--text)          /* primary text */
var(--text-dim)      /* secondary text */
var(--text-faint)    /* placeholder / disabled text */
var(--green)         /* #5dba70 — positive/price colour */
var(--font-display)  /* Cinzel — headings, titles, fantasy flavour */

/* Surface overlay vars — auto-adapt dark ↔ light (prefer these over hardcoded rgba(255,255,255,...)) */
var(--s1)            /* lightest surface tint */
var(--s2)            /* card/panel background fill */
var(--s3)            /* interactive element fill (buttons) */
var(--s4)            /* hover/pressed fill */
var(--s-card)        /* card surface */
var(--s-subtle)      /* very subtle tint */
var(--s-medium)      /* medium tint — use for button hover backgrounds */
var(--s-border)      /* subtle border — use instead of rgba(255,255,255,0.07) */
var(--s-border2)     /* stronger border — use for interactive button outlines */
```

**Light theme critical rule:** Never use hardcoded `rgba(255,255,255,0.X)` for borders or backgrounds on interactive elements — they are invisible on light themes. Use `var(--s-border)` / `var(--s-border2)` / `var(--s-medium)` etc. instead.

#### Recurring visual patterns

**Dot-grid page background** — applied via `.page` on the root wrapper of index/browser pages:
```css
.page {
  background-image: radial-gradient(circle, rgba(201,168,76,0.04) 1px, transparent 1px);
  background-size: 28px 28px;
}
```

**Gold top-border card** — used on folder cards, stat cards, and list items:
```css
border-top: 2px solid rgba(201,168,76,0.35);
/* hover: */
border-top-color: rgba(201,168,76,0.65);
```

**View toggle pill** — grid/list switcher used in `FolderBrowser`, `ListBrowser`, and `DeckView`:
```jsx
<div className={styles.viewToggle}>
  <button className={`${styles.viewBtn} ${view==='grid' ? styles.viewActive : ''}`} onClick={() => setView('grid')}>⊞ Grid</button>
  <button className={`${styles.viewBtn} ${view==='list' ? styles.viewActive : ''}`} onClick={() => setView('list')}>≡ List</button>
</div>
```
```css
.viewToggle { display:flex; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:6px; overflow:hidden; }
.viewBtn    { padding:5px 14px; background:none; border:none; color:var(--text-dim); cursor:pointer; font-size:.8rem; }
.viewActive { background:rgba(201,168,76,0.15); color:var(--gold); }
```

**Section label with extending rule** — used for "BINDERS", "WISHLISTS", stat section headers:
```css
.sectionLabel { display:flex; align-items:center; gap:10px; font-family:var(--font-display); font-size:.65rem; letter-spacing:.12em; color:var(--text-faint); text-transform:uppercase; }
.sectionLabel::after { content:''; flex:1; height:1px; background:rgba(255,255,255,0.05); }
```

### Component Conventions

- Pages load their own data (IDB-first, Supabase fallback).
- Skeleton loaders use CSS shimmer animation (`@keyframes shimmer`).
- All monetary displays go through `formatPrice()` — never format manually.
- `CardDetail` locks `document.body.style.overflow = 'hidden'` while open and restores it on unmount — do not add a second scroll lock elsewhere.
- All top-level page wrappers use `<div className={styles.page}>` with the dot-grid background.

### Toast Notifications

`useToast()` from `src/components/ToastContext.jsx` provides `showToast(message, opts)`. Options: `tone` (`'success'` | `'error'` | `'info'`, default `'success'`), `duration` (ms, default 3200). Max 3 toasts shown simultaneously (oldest dropped). Use for user-facing feedback after mutations — do not use `alert()`.

### Shared UI Primitives (`UI.jsx`)

`src/components/UI.jsx` exports reusable primitives: `Button`, `Input`, `Modal`, `SectionHeader`, `Select`, `Badge`, `EmptyState`, `ErrorBox`, `ProgressBar`. Prefer these over one-off implementations in page files for consistent styling.

### Setup Wizard

`useSetupWizard().open()` triggers the first-time setup modal manually (e.g. from Settings). It auto-opens once per user on first login if `user.user_metadata.setup_completed` is falsy. Gated by localStorage key `arcanevault_setup_done`.

### Admin Access

The `/admin` route is only useful to users listed in `admin_users` with `active = true`. `isCurrentUserAdmin(userId)` in `src/lib/admin.js` performs this check. The `Admin.jsx` page does its own guard and shows nothing if the check fails.

### Profile Page

`Profile.jsx` renders public bento-grid profiles at `/profile/:username`. Blocks are defined by `BLOCK_DEFS` and ordered/toggled via `profile_config` in `user_settings`. Deck showcase block pulls from `shared_folders`/public decks. Edit mode is only available to the profile owner.

### Add Card Modal (`AddCardModal.jsx`)

- Cards must always be saved to a **deck, binder, or wishlist** — the "Collection" destination tab has been removed. `canSave` requires `selectedFolder != null`.
- `folderMode=true` (used from Folders/DeckBrowser) pre-selects folder type and uses a searchable dropdown. `folderMode=false` (used from Collection) shows tab buttons for deck/binder/wishlist.
- `initialCardName` prop auto-triggers `selectCard()` on mount — used by `Scanner.jsx` when tapping "+ Add to Collection".

### Import Modal (`ImportModal.jsx`)

- Auto-detects format: if first line contains a comma and matches `/\bname\b/i` → Manabox CSV; otherwise → plain decklist (`4 Lightning Bolt`).
- For `list` type: upserts into `list_items` with conflict on `folder_id,card_print_id,foil` (rows are hydrated with `card_print_id` via `requireCardPrintIds` first).
- For binder/deck: upserts into `cards` then `folder_cards`.

### Select Mode & Qty Adjuster

- `splitState: Map<cardId, selectedQty>` tracks how many copies of each card are selected.
- First click on a multi-copy card → selects it with qty **1** (not all copies).
- `onAdjustQty(id, delta, totalQty)` increments/decrements, clamped to `[1, totalQty]`. No DB write until bulk action.
- `BulkActionBar` receives `selectedQty` (sum of selected copies) to show accurate copy count.

### useLongPress Hook

Long-press (500 ms) on any card enters select mode. **Always** destructure `onMouseLeave` from the hook result and merge manually — never spread `{...longPress}` after an explicit `onMouseLeave`:

```jsx
const { onMouseLeave: lpLeave, ...lpRest } = longPress
// then in JSX:
onMouseLeave={e => { myOwnLeaveHandler(); lpLeave?.(e) }}
{...lpRest}
```

### Card Scanner (`src/scanner/`)

#### Pipeline overview

The vision engine is **pure JS** (`visionCore.js` primitives + `ScannerEngine.js` pipeline) — no OpenCV, no WASM, no canvas inside the pipeline. Everything below `captureFrame()` runs inside **visionWorker** (driven via `visionClient`, which falls back to main-thread execution if Workers fail); matching runs in **hashMatchWorker**. The main thread only captures frames (canvas/video access) and orchestrates. Frames are posted to the worker with their pixel buffers in the transfer list (zero copy — every capture makes fresh ImageData).

```
captureFrame()  [main thread]
  → getFullImageData() — fresh full-res ImageData per call (1280×720 web / native JPEG via createImageBitmap)
  → small ImageData (640×360, GPU canvas.drawImage)

visionClient.detect(smallImageData, { quick })   [visionWorker]
  → 3-pass: adaptive Canny → fixed lo=5/hi=40 → CLAHE(2.0, 8×8) contrast boost
  → quick=true runs pass 1 only (auto-scan probe)
  → corners in small-image coords; caller scales back to full-res (×2)

visionClient.loadWarped(fullImageData, corners)  → worker warps to 500×700, holds it as "current card"
visionClient.hashVariants(variants, { rot180 })  → art crops (ART 38,66,424×248) → usability check → 4 hash variants each

databaseService.findBestTwoWithStatsAsyncAll(queries)   ← match worker: LSH band index + Hamming distance

stability voting (up to STABILITY_SAMPLES=3 frames, SAMPLE_DELAY_MS=20)
```

**Auto-scan** runs a continuous cheap probe (`detect({ quick: true })`, ~10 Hz, `AUTOSCAN_PROBE_INTERVAL_MS`) and fires a full scan only after a card-like quad holds still for `AUTOSCAN_PROBE_STABLE` consecutive probes — an empty table never triggers 3-pass detection or hashing. There are no fixed miss/match cooldowns anymore; `AUTOSCAN_AFTER_SCAN_MS` paces attempts and the name+foil signature guard suppresses re-adding the card left in frame.

**Reticle fallback**: when no corners are found, `visionClient.loadReticle(fullImageData, vw, vh)` blind-crops the reticle region as the current card (manual scan only, not auto-scan).

**180° rotation fallback**: after each warp/reticle pass, if no decisive match, `rotateCard180(warpedCard)` is tried — catches cards held upside-down.

**Foil fallback**: when standard hash distance > `MATCH_THRESHOLD`, `computePHash256Foil(artCrop)` re-hashes with `percentileCap(0.92)` (aggressive glare suppression). Does not affect stored DB hashes.

#### Collector-line OCR (printing auto-correct)

After an accepted scan (`scanOcr` setting, default on), `refineScanWithOcr` OCRs the card's printed collector line (`0123/0281 R` / `SET • EN`, modern frames 2014+) and refines the basket entry. Same-art reprints are indistinguishable to the art hash — the printed set code is the only reliable signal.

- The strip is warped **from the full-res frame** at 3× card scale inside visionWorker (`extractCollectorStrip`; at 500×700 card scale the text is only ~17 px). The worker keeps it from the matched frame; `visionClient.getCollectorStrip()` hands it off once.
- `collectorOcr.js`: tesseract.js (lazy-loaded on first accepted scan) with **self-hosted assets** in `public/ocr/` — `worker.min.js`, the SIMD LSTM core, and `eng.traineddata.gz` (4.0.0_best_int, ~3 MB; `fast` reads noticeably worse). No CDN at runtime; non-SIMD browsers silently get OCR disabled. SW runtime-caches `/ocr/` CacheFirst, never precaches (`globIgnores`).
- Parsing is deliberately lenient (candidate lists for set + collector number, concatenated `MKMEN` splits, edit-distance-1 set recovery via `expandSetCandidates`) because validation happens downstream: `databaseService.lookupPrint(set, coll)` must hit the hash pack (exact or `p`-prefixed promo set), AND the resolved name must equal the matched card's name, AND the set family (set minus leading `p`) must differ from the match. Only then is the printing switched; within-family promo/showcase variants stay the hash's call. Language (`SET • DE` etc.) is applied whenever parsed.
- A misread can therefore only produce a no-op, never a wrong card. Old frames (no printed set code) and borderless cards parse to nothing — silent no-op.

#### Title-OCR rescue (name identification when hashing fails)

When a scan's hash result is rejected (glare, foils, low light) but a card was warped this scan (`cardLoaded` — a stale strip from a previous card is never used), `rescueByTitle` OCRs the **title bar** (extracted like the collector strip; works on every frame era, pre-2014 included) and fuzzy-matches the text against all pack names via `nameMatch.js`:

- `matchTitle`: banded prefix-Levenshtein (trailing mana-cost junk is free), length-scaled edit budgets, names <5 chars must match exactly (the card "X" exists and would otherwise match garbage), leading ≤2-char junk tokens dropped and retried, and a hit needs the runner-up name ≥2 edits worse. Harness: 13/24 hash-failure scenarios rescued, 0 wrong.
- Printing: the hash's best same-name observation wins; otherwise the newest printing of the identified name (pack order). Set locks are honored (`identifyByTitle({ allowedSets })`).
- Known no-op limitations: flavor-named crossover cards (Marvel/Godzilla print a different title), non-English cards (pack has English names only — the art hash covers those), heavily stylized borderless titles, old-frame basics.

#### Hash algorithm — must match seed script exactly

`computePHash256` pipeline v6 (client + `generate-card-hashes.js` must be identical):
1. `resize` art crop (424×248) to 32×32 — client uses `areaResizeRGBA` (exact INTER_AREA-equivalent pixel-area averaging), seed uses Sharp `mitchell`; no pre-blur (area-averaging low-passes inherently)
2. BT.709 grayscale (`rgbToGray32x32`) — weights: 0.2126 R, 0.7152 G, 0.0722 B
3. `percentileCap(0.98)` — glare suppression
4. `CLAHE(tileGrid=4×4, clipLimit=40)`
5. 2D-DCT via `dct2d()` with **precomputed cosine/norm tables** (built at module load in `hashCore.js` — do not add `Math.cos` calls back to the inner loop)
6. Top-left 16×16 DCT coefficients → median threshold → 256-bit hash

**If any step changes, run `generate-card-hashes.js --reseed`, bump `HASH_PIPELINE_VERSION` (seed script) and add the new version to `SUPPORTED_HASH_VERSIONS` (packLoader.js).** `computePHash256Foil` uses `percentileCap(0.92)` instead of 0.98 — client-side only, never changes stored hashes.

**Pipeline v7 second signal** (format-v2 packs): `phash_full_hex` — whole-card luma pHash (`computeFullCardHash` client-side, once per warped orientation). `matchCore` combines: art 0.45 + color 0.20 + full 0.35×`FULL_SCALE`(1.14, harness-calibrated so random ≈ art's 126); without a full hash it collapses to the exact v6 formula (0.65/0.35), so v1 packs behave identically. A second LSH band index over full hashes rescues candidates whose art hash was destroyed by glare. v2 packs also carry **DFC back-face rows** (same scryfall id, face=1) and **flavor names** (indexed by the title-OCR rescue — Marvel/Godzilla cards print the flavor name).

#### Hash database delivery — static hash pack

The hash pack (`public/scanner/hashpack/pack-v*-*.bin` + `manifest.json`, newest sets in chunk 0) deploys with the web app and ships inside the Android APK (Capacitor serves `public/` locally — native first run is offline). The client (`packLoader.js` → `DatabaseService.js`) caches chunks as single ArrayBuffer blobs in the IDB `scanner_pack` store and posts them to `hashMatchWorker.js`, which owns the band indexes. Scanning unlocks after the first chunk; the rest streams in the background. The client accepts hash versions 6 and 7 (`SUPPORTED_HASH_VERSIONS`) — v7 features degrade gracefully on a v6 pack.

- **Seeding workflow:** `node scripts/generate-card-hashes.js` → commit `public/scanner/hashpack/`. The pack is the script's own incremental state (Supabase is not involved); new cards produce delta chunks, checkpointed every 8k rows (an interrupted run resumes), and fragmented packs auto-consolidate. `--reseed` rebuilds everything (hash algorithm changes).
- Chunk filenames are content-hashed; `manifest.json` is the only mutable file.
- The service worker must never precache `scanner/**` (see `globIgnores` in `vite.config.js`).
- The old Supabase `card_hashes` table is retired; `supabase/migrations/20260703000000_drop_card_hashes.sql` reclaims its 75 MB — **apply only after a verified v7 pack is committed + deployed**.

### Life Tracker (`LifeTracker.jsx`)

#### Multiplayer Lobby

Host creates a session → others visit `/join/:code` on their own device → host starts game.

- `game_sessions` table: `id, code, status ('waiting'|'playing'), config, host_user_id`
- `game_players` table: `id, session_id, slot_index, user_id, display_name, color, deck_name`
- 6-char join code uses `CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'` (no ambiguous chars)
- Join URL built with `import.meta.env.BASE_URL` for correct dev/prod paths
- Realtime via Supabase `postgres_changes` subscriptions on both tables
- `JoinGame.jsx` is a **public route** (outside `PrivateApp`) at `/join/:code`

#### Unified Game Log

`gameLog: [{ts, type, playerName, playerColor, delta, total, key?, fromName?}]` — flat array (newest first, max 120 entries). Each event carries `playerName`/`playerColor` at the call site (not inside the callback) so there's no stale-closure issue.

**Removed:** `PlayerHistoryOverlay`, per-player 📜 button in `nameRow`, `playerHistory`/`historyPlayerId` state, `addHistoryEvent`. If you see any of these names they are stale.

---

## Supabase Table Notes

- `cards` — user's owned cards, RLS by `user_id`
- `folders` — type is `'binder' | 'deck' | 'list' | 'builder_deck'`; description JSON may include `isGroup: true` for group folders
- `folder_cards` — links `folder_id` + `card_id` + `qty` for binders/lists
- `deck_allocations` — links `deck_id` + `card_id` + `qty` for owned cards assigned into collection decks
- `deck_allocations_view` — view joining `deck_allocations` with card data
- `list_items` — wishlist items: `folder_id, name, set_code, collector_number, scryfall_id, foil, qty`
- `deck_cards` — builder deck cards (separate from collection ownership)
- `deck_cards_view` — view joining `deck_cards` with card/print data; queried by `fetchDeckCards()`
- `card_prints` — normalized print metadata shared across ownership, deck builder, prices, and scanner
- `user_settings` — single row per user; includes `nickname`, `anonymize_email`, `reduce_motion`, `higher_contrast`, `card_name_size`, `default_grouping`, `keep_screen_awake`, `show_sync_errors`, `premium`, `profile_config`
- `card_prices` — shared daily market prices keyed by `scryfall_id + snapshot_date`; app keeps only today and yesterday
- `collection_value_snapshots` — per-user daily collection value: `user_id, snapshot_date, total_eur, total_usd, card_count`; RLS owner-only. Written two ways: a pg_cron job (`daily-collection-value-snapshots`, 04:30 UTC, after the 03:20 price sync) runs `record_daily_value_snapshots()` with `ON CONFLICT DO NOTHING`, and Stats upserts on visit with manual price overrides applied (client value wins). The cron function is SECURITY DEFINER with EXECUTE revoked from anon/authenticated
- `game_sessions` — multiplayer life tracker sessions; `status`: `'waiting' | 'playing'`
- `game_players` — player slots per session; `user_id` is null until a player claims the slot
- `game_results` — deck win/loss history: `session_id, user_id, deck_id, deck_name, format, player_count, placement`
- `tracked_games` — historical game tracking records
- `deck_changes` — deck-level action history (printing optimize, visibility, bracket, import, commander); one row per action, capped at 100/deck via the `prune_deck_changes` trigger, RLS owner-only. Logged via `src/lib/deckHistory.js` (`logDeckChange`, `fetchDeckHistory`); shown in the DeckBuilder "Deck History" modal. NOT per-card diffs
- `feedback` — user bug reports & feature requests: `type ('bug'|'feature'), description, contact, user_id`
- `feedback_attachments` — optional screenshots linked to `feedback`; files live in the `assets` storage bucket
- `card_hashes` — **dropped 2026-07-04** (pipeline v7 reclaimed ~75 MB): clients consume the static hash pack, and the seed script uses the pack as its own state. The pack in `public/scanner/hashpack/` (+ git history) is the only copy of the computed hashes; a full re-hash via `generate-card-hashes.js --reseed` rebuilds it from Scryfall in a few hours
- `admin_users` — users with admin access: `user_id, active`; checked by `isCurrentUserAdmin()`
- `app_config` — key-value config store used by admin/home: keys include `changelog`, `feedback_resolved`
- `shared_folders` — shared deck/folder links for public share URLs
- `account_deletion_requests` — user account deletion requests
- `account_deletion_request_events` — audit trail for deletion request status changes
- `tournament_sessions` — tournament instances created in `Tournaments.jsx`
- `tournament_players` — player slots within a tournament session

---

## External APIs

| Service | Usage | Notes |
|---|---|---|
| Scryfall | Card data, search, autocomplete, catalog | Rate-limited: 75 cards/batch, 120 ms delay |
| Supabase | Auth, cloud sync | RLS enforced; never bypass with service key |
| frankfurter.app | EUR↔USD rates | Cached 6 h in IDB |
| EDHRec | Commander recommendations | Direct fetch — `json.edhrec.com/pages/` sends CORS `*` |
| deckloom-og worker | MTG RSS feeds | `deckloom.app/api/rss?feed=<url>` — allow-listed feeds only, edge-cached 15 min, CORS `*`. Adding a feed requires updating `RSS_ALLOWED_FEEDS` in `cloudflare/og-worker/worker.js` + redeploying |

### RSS Feed Parsing

MTGGoldfish uses **Atom** format (`<feed>/<entry>`, link via `getAttribute('href')`). EDHREC and MTGArenaZone use **RSS 2.0** (`<rss>/<item>`, link via `textContent`). Always detect with `doc.querySelector('feed')` before parsing.

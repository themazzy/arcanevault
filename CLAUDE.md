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

**ArcaneVault** is a personal Magic: The Gathering collection tracker hosted at **https://themazzy.github.io/arcanevault/**. Users catalog owned cards, organise them into binders/decks/wishlists, track prices and P&L, build decks, scan cards with camera OCR, and view collection analytics.

**Stack:** React 18 + Vite + Supabase + IndexedDB

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

Both variables are required at startup; the app will fail silently without them.

---

## Deployment — GitHub Pages

The app is deployed to **https://themazzy.github.io/arcanevault/** via GitHub Actions (`.github/workflows/deploy.yml`).

### Critical GitHub Pages files — do not remove or modify without care:

| File | Purpose |
|---|---|
| `public/404.html` | Catches 404s from direct URL access; encodes the path as a query param and redirects to `index.html` |
| `index.html` (redirect script) | Decodes the query param from `404.html` and restores the correct route via `history.replaceState` |
| `src/App.jsx` | `BrowserRouter` has `basename="/arcanevault"` — required for all routes to resolve correctly under the GitHub Pages subdirectory |

This is the standard `spa-github-pages` pattern. If you touch routing, always verify it still works at `https://themazzy.github.io/arcanevault/`.

### Email links

`src/components/Auth.jsx` passes `emailRedirectTo: 'https://themazzy.github.io/arcanevault/'` in `signUp()` to ensure Supabase confirmation emails link to prod, not localhost.

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

**Key gotcha:** Never use Supabase's nested `select('folder_cards(cards(*))')` — it requires FK relationships configured in PostgREST and silently returns empty. Always do flat queries and join in memory.

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

Important settings: `theme`, `oled_mode`, `higher_contrast`, `reduce_motion`, `font_size`, `font_weight`, `card_name_size`, `price_source`, `grid_density`, `show_price`, `cache_ttl_h`, `default_grouping`, `nickname`, `anonymize_email`, `keep_screen_awake`, `show_sync_errors`.

Always read these values from `useSettings()` instead of hardcoding defaults.

### Filtering & Sorting

Heavy filtering runs in a **Web Worker** (`src/lib/filterWorker.js`). The worker receives `{ id, cards, sfMap, search, sort, filters, priceSource, cardFolderMap }` and posts back sorted results. `matchNumeric(valStr, op, minStr, maxStr)` handles `= | < | <= | > | >= | between | in`.

The same filter logic is duplicated in `CardComponents.jsx` for the non-worker path — keep both in sync when changing filter operators.

`EMPTY_FILTERS` is exported from `CardComponents.jsx` — always spread it as defaults.

### Collection Folder Membership Sync

`src/pages/Collection.jsx` loads binder/deck membership in two phases:

1. Read `folders` + `folder_cards` + `deck_allocations` from IDB first and build `cardFolderMap` immediately.
2. Sync `folders` from Supabase on every online load.
3. Sync `folder_cards` incrementally using `folder_cards.updated_at`.
4. Sync `deck_allocations` alongside folder placements.
5. Run a full `folder_cards` reconcile every 10 minutes to catch remote deletes.

Delta sync state in IDB `meta`: `folder_cards_full_sync_<userId>` / `folder_cards_delta_sync_<userId>`.

If you change placement writes, preserve `updated_at` behavior on `folder_cards` and keep `deck_allocations` sync logic aligned or collection/deck badges will drift.

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

- Wishlist browsing should match binder/deck browsing for view toggles, selection styling, and bulk actions.
- Wishlist bulk move must only allow destinations of type `list`.
- Wishlist grid rendering should use the shared binder-style `CardGrid`, not a separate wishlist-only grid implementation.
- `list_items` access is folder-owned: inserts and policies should derive ownership from the parent folder, not rely on a caller-supplied `list_items.user_id`.

### Selection And Quantity Semantics

- Bulk selection counts should use selected copy count when `selectedQty` is available, not just distinct card rows.
- In quantity adjusters, pressing `-` at `1 of N` should deselect that card entirely.
- In collection, expanded per-folder tiles must use folder-specific quantity from `folder_cards.qty` for badges and selection totals instead of merged collection quantity.

### Routing

React Router v6. `BrowserRouter` in `src/App.jsx` uses `basename="/arcanevault"` for GitHub Pages compatibility. Public routes: `/login`, `/share/:token`, `/join/:code`. All other routes require auth and are wrapped in `PrivateApp`.

Builder routes: `/builder` → `Builder.jsx` (deck index); `/builder/:id` → `DeckBuilder.jsx` (deck editor). A linked collection deck navigates to `/builder/<linked_builder_id>` rather than `/deck/<id>`.

### Vite Proxies (dev only)

```
/api/edhrec    → json.edhrec.com
/api/archidekt → archidekt.com
/api/moxfield  → api.moxfield.com
/api/goldfish  → mtggoldfish.com
```

These are only active during `npm run dev`. Production deploys on GitHub Pages cannot use these — CORS-restricted APIs will fail in prod.

---

## Key Files

| File | Role |
|---|---|
| `src/icons/index.jsx` | **Unified icon system** — all 56 SVG icons; single source of truth for iconography |
| `src/lib/db.js` | IDB layer — all local reads/writes |
| `src/lib/scryfall.js` | Scryfall metadata/image cache + batch lookup helpers |
| `src/lib/sharedCardPrices.js` | Overlays shared Supabase daily prices onto cached Scryfall card data |
| `src/lib/filterWorker.js` | Web Worker: filter + sort logic |
| `src/scanner/DatabaseService.js` | pHash DB: SQLite (native) + Supabase fallback (web); LSH band index, IDB pre-parsed cache |
| `src/scanner/ScannerEngine.js` | OpenCV.js card detection (multi-pass Canny), perspective warp, art crop, reticle crop, 180° rotation, pHash |
| `src/scanner/hashCore.js` | Pure-JS pHash core: precomputed DCT cosine table, CLAHE, percentileCap, Hamming distance — shared with seed script |
| `src/scanner/constants.js` | Shared card/art dimensions: `CARD_W=500, CARD_H=700, ART_X=38, ART_Y=66, ART_W=424, ART_H=248` |
| `src/scanner/CardScanner.jsx` | Full-screen scanner UI: camera, auto-scan loop, targeting reticle, stability buffer, settings panel, match basket |
| `src/pages/Scanner.jsx` | Route wrapper for `CardScanner` at `/scanner` |
| `scripts/generate-card-hashes.js` | Node.js seed script: downloads Scryfall art crops, computes pHashes, uploads to Supabase |
| `src/lib/fx.js` | EUR↔USD conversion via frankfurter.app (6 h IDB cache) |
| `src/lib/deckBuilderApi.js` | Deck builder helpers + external API calls |
| `src/lib/deckSync.js` | Linked deck sync: `getLinkedDeckIds()`, `getSyncState()`, `withLinkedPair()`, `clearLinkedPair()`, `writeSyncState()`, `normalizeBuilderCards()` |
| `src/lib/deckLegality.js` | `getCardLegalityWarnings()` — format legality + commander color identity checks |
| `src/lib/importFlow.js` | Import pipeline: `parseImportText()`, `resolveImportEntries()`, `summarizeImportRows()`, `aggregateResolvedRows()`, `fetchPaperPrintings()` |
| `src/lib/csvParser.js` | Manabox CSV → cards + folders |
| `src/components/CardComponents.jsx` | `FilterBar`, `CardDetail`, `CardGrid`, `EMPTY_FILTERS`, `applyFilterSort`, `BulkActionBar` |
| `src/components/VirtualCardGrid.jsx` | Virtualised card grid (@tanstack/react-virtual) |
| `src/components/AddCardModal.jsx` | Add card modal: scan (OCR) or manual search + queue |
| `src/components/ImportModal.jsx` | Bulk import wizard: CSV / txt / paste, for binders/decks/wishlists |
| `src/components/SettingsContext.jsx` | `SettingsProvider` + `useSettings()` |
| `src/components/Auth.jsx` | `AuthProvider` + `useAuth()` + `LoginPage` |
| `src/pages/Collection.jsx` | Main collection browser (IDB-first, worker filter) |
| `src/pages/Home.jsx` | Dashboard — collection snapshot, card lookup, recently viewed, news |
| `src/pages/Folders.jsx` | Binders index + `FolderBrowser` (inline grid/list view toggle, `BinderListView`) |
| `src/pages/Lists.jsx` | Wishlists index + `ListBrowser` (inline list/grid view toggle, `WishlistGrid`) |
| `src/pages/Builder.jsx` | Builder deck index — deck tiles with art backgrounds, linked-pair sync badges, select mode |
| `src/pages/DeckBuilder.jsx` | Full deck builder UI at `/builder/:id` — card list, boards, import, linked sync |
| `src/pages/DeckBuilder.module.css` | Styles for DeckBuilder — do not confuse with `DeckView.module.css` |
| `src/pages/DeckBrowser.jsx` | Card browser inside a deck — list/stacks/grid/text/table views |
| `src/pages/DeckView.jsx` | Shared deck view page (collection decks + builder decks) |
| `src/pages/DeckView.module.css` | Styles for DeckView — do not confuse with `DeckBuilder.module.css` |
| `src/pages/Stats.jsx` | Collection analytics |
| `src/pages/LifeTracker.jsx` | Multiplayer life tracker — pre-game setup, game screen, player-settings overlay, commander damage, lobby |
| `src/pages/LifeTracker.module.css` | Styles for LifeTracker |
| `src/pages/JoinGame.jsx` | Public route `/join/:code` — join a multiplayer lobby |
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

### Add Card Modal (`AddCardModal.jsx`)

- Cards must always be saved to a **deck, binder, or wishlist** — the "Collection" destination tab has been removed. `canSave` requires `selectedFolder != null`.
- `folderMode=true` (used from Folders/DeckBrowser) pre-selects folder type and uses a searchable dropdown. `folderMode=false` (used from Collection) shows tab buttons for deck/binder/wishlist.
- `initialCardName` prop auto-triggers `selectCard()` on mount — used by `Scanner.jsx` when tapping "+ Add to Collection".

### Import Modal (`ImportModal.jsx`)

- Auto-detects format: if first line contains a comma and matches `/\bname\b/i` → Manabox CSV; otherwise → plain decklist (`4 Lightning Bolt`).
- For `list` type: upserts into `list_items` with conflict on `folder_id,set_code,collector_number,foil`.
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

```
captureFrame()
  → full-res ImageData (1280×720 web / native JPEG)   ← for warpCard
  → small ImageData (640×360, GPU canvas.drawImage)   ← for detectCardCorners

detectCardCorners(smallImageData, sw, sh)
  → 3-pass: adaptive Canny → fixed lo=5/hi=40 → equalizeHist
  → corners in small-image coords; caller scales back to full-res (×2)

warpCard(imageData, scaledCorners)  →  500×700 ImageData

cropArtRegion(warpedCard)           →  art crop (ART_X=38, ART_Y=66, ART_W=424, ART_H=248)

computePHash256(artCrop)            →  Uint32Array(8) — 256-bit pHash

databaseService.findBestTwoWithStats(hash)   ← LSH band index + Hamming distance

stability voting (up to STABILITY_SAMPLES=3 frames, SAMPLE_DELAY_MS=40)
```

**Reticle fallback**: when no corners are found, `cropCardFromReticle(srcCanvas, w, h, vw, vh)` crops the reticle region directly from the camera canvas — pass `srcCanvas` (HTMLCanvasElement) to skip the expensive `putImageData` copy.

**180° rotation fallback**: after each warp/reticle pass, if no decisive match, `rotateCard180(warpedCard)` is tried — catches cards held upside-down.

**Foil fallback**: when standard hash distance > `MATCH_THRESHOLD`, `computePHash256Foil(artCrop)` re-hashes with `percentileCap(0.92)` (aggressive glare suppression). Does not affect stored DB hashes.

#### Hash algorithm — must match seed script exactly

`computePHash256` pipeline (client + `generate-card-hashes.js` must be identical):
1. `GaussianBlur` σ=1.0 on art crop (424×248)
2. `resize` to 32×32 with INTER_LANCZOS4
3. BT.601 grayscale (`rgbToGray32x32`) — weights: 0.299 R, 0.587 G, 0.114 B
4. `percentileCap(0.98)` — glare suppression
5. `CLAHE(tileGrid=4×4, clipLimit=40)`
6. 2D-DCT via `dct2d()` with **precomputed cosine/norm tables** (built at module load in `hashCore.js` — do not add `Math.cos` calls back to the inner loop)
7. Top-left 16×16 DCT coefficients → median threshold → 256-bit hash

**If any step changes, truncate `card_hashes` and re-seed.** `computePHash256Foil` uses `percentileCap(0.92)` instead of 0.98 — client-side only, never changes stored hashes.

**BigInt precision**: Supabase BIGINT returned as JS Number loses bits >53. Read `phash_hex TEXT` (64 hex chars) exclusively.

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
- `folders` — type is `'binder' | 'deck' | 'list' | 'builder_deck'`
- `folder_cards` — links `folder_id` + `card_id` + `qty` for binders/lists
- `deck_allocations` — links `deck_id` + `card_id` + `qty` for owned cards assigned into collection decks
- `list_items` — wishlist items: `folder_id, name, set_code, collector_number, scryfall_id, foil, qty`
- `deck_cards` — builder deck cards (separate from collection ownership)
- `card_prints` — normalized print metadata shared across ownership, deck builder, prices, and scanner
- `user_settings` — single row per user; includes `nickname`, `anonymize_email`, `reduce_motion`, `higher_contrast`, `card_name_size`, `default_grouping`, `keep_screen_awake`, `show_sync_errors`
- `card_prices` — shared daily market prices keyed by `scryfall_id + snapshot_date`; app keeps only today and yesterday
- `game_sessions` — multiplayer life tracker sessions; `status`: `'waiting' | 'playing'`
- `game_players` — player slots per session; `user_id` is null until a player claims the slot
- `game_results` — deck win/loss history: `session_id, user_id, deck_id, deck_name, format, player_count, placement`
- `feedback` — user bug reports & feature requests: `type ('bug'|'feature'), description, contact, user_id`
- `feedback_attachments` — optional screenshots linked to `feedback`; files live in the `assets` storage bucket
- `card_hashes` — pHash records for scanner: `scryfall_id, name, set_code, collector_number, image_uri, hash_part_1..4 (bigint), phash_hex (text)`; read-only RLS for all users

---

## External APIs

| Service | Usage | Notes |
|---|---|---|
| Scryfall | Card data, search, autocomplete, catalog | Rate-limited: 75 cards/batch, 120 ms delay |
| Supabase | Auth, cloud sync | RLS enforced; never bypass with service key |
| frankfurter.app | EUR↔USD rates | Cached 6 h in IDB |
| EDHRec | Commander recommendations | Via Vite proxy `/api/edhrec` (dev only) |
| codetabs.com proxy | MTG RSS feeds | `api.codetabs.com/v1/proxy?quest=<url>` returns raw XML |

### RSS Feed Parsing

MTGGoldfish uses **Atom** format (`<feed>/<entry>`, link via `getAttribute('href')`). EDHREC and MTGArenaZone use **RSS 2.0** (`<rss>/<item>`, link via `textContent`). Always detect with `doc.querySelector('feed')` before parsing.

# AGENTS.md

This file provides guidance to coding agents working in this repository.

---

## Do Not Overuse Subagents

Only spawn subagents when necessary for this project. Prefer doing research, searches, and edits directly in the main conversation. Subagents waste tokens.

---

## Handling Ambiguous Instructions

This is the highest-priority rule in this file.

When a prompt contains requirements that could be interpreted in more than one meaningful way, stop immediately and ask the user to choose before writing any code. Present ambiguous points as a numbered list with brief trade-off notes for each option.

Do not:
- Guess or pick the "most likely" interpretation
- Start coding and ask mid-way through
- Assume you understand scope without confirming

Do:
- Ask up front, before any code is written
- Present concrete options, not open-ended questions
- Include trade-offs so the user can make an informed choice

The cost of a 30-second clarification is always lower than building the wrong thing. When in doubt, ask.

---

## Project Overview

DeckLoom is a personal Magic: The Gathering collection tracker hosted at `https://themazzy.github.io/arcanevault/`. Users catalog owned cards, organize them into binders, decks, and wishlists, track prices and P&L, build decks, scan cards with camera OCR, and view collection analytics.

Stack: React 18 + Vite + Supabase + IndexedDB

---

## Commands

```bash
npm run dev
npm run build
npm run preview
```

- `npm run dev`: start Vite dev server on `http://localhost:5173` with API proxies
- `npm run build`: production build to `dist/`
- `npm run preview`: preview production build locally

There is no test runner configured. There are no lint scripts. Vite dev server surfaces JSX and import errors on save.

---

## Environment

Copy `.env.example` to `.env` and fill in:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

Both variables are required at startup. App can fail silently without them.

---

## Deployment

App deploys to GitHub Pages at `https://themazzy.github.io/arcanevault/` via `.github/workflows/deploy.yml`.

Critical GitHub Pages files. Do not remove or modify without care:

| File | Purpose |
| --- | --- |
| `public/404.html` | Catches direct URL 404s, encodes path as query param, redirects to `index.html` |
| `index.html` | Decodes query param from `404.html` and restores route via `history.replaceState` |
| `src/App.jsx` | `BrowserRouter` uses `basename="/arcanevault"` so routes resolve under GitHub Pages subdirectory |

This uses standard `spa-github-pages` pattern. If routing changes, verify it still works at production URL.

### Email Links

`src/components/Auth.jsx` passes `emailRedirectTo: 'https://themazzy.github.io/arcanevault/'` in `signUp()` so Supabase confirmation emails point to production, not localhost.

---

## Architecture

### Data Flow

Most important architectural principle: IDB is primary data store. Supabase is sync backend.

```text
User action
  -> write to Supabase
  -> sync pulled into IDB on next load
  -> all reads come from IDB
```

- `src/lib/db.js`: all IndexedDB access. Use `getLocalCards(userId)`, `getLocalFolders(userId)`, `getAllLocalFolderCards(folderIds)` for reads. Use `replaceLocalFolderCards(folderIds, rows)` for bulk reconcile. Do not bypass IDB for performance-critical pages.
- `src/lib/supabase.js`: exports `sb` singleton. Use for auth and cloud sync fallback only.
- `src/lib/scryfall.js`: Scryfall metadata and art cache. `getInstantCache()` returns in-memory map or `null` if cold. Always guard with `sfMap || {}`.

Key gotcha: never use Supabase nested `select('folder_cards(cards(*))')`. It depends on PostgREST FK relationships and can silently return empty. Use flat queries and join in memory.

### Pricing

- Shared market prices live in Supabase `card_prices` with `today` and `yesterday` retention.
- Collection-value pages should load prices through `src/lib/sharedCardPrices.js`.
- `getPrice(sfCard, foil, { price_source })` returns numeric value.
- `formatPrice(value, priceSourceId)` returns formatted currency string.
- `getPriceWithMeta(sfCard, foil, opts)` returns `{ value, symbol, isFallback, pct }`.
- Manual overrides live in `localStorage` as `arcanevault_manual_prices`.
- Price source comes from `useSettings().price_source`. Always pass it down. Never hardcode.

### Settings

`useSettings()` returns user preferences plus `save(patch)`, `syncNow()`, sync status, and last sync error. Settings write to `localStorage` immediately and debounce Supabase upsert by 800 ms.

Important settings:
- `theme`
- `oled_mode`
- `higher_contrast`
- `reduce_motion`
- `font_size`
- `font_weight`
- `card_name_size`
- `price_source`
- `grid_density`
- `show_price`
- `cache_ttl_h`
- `default_grouping`
- `nickname`
- `anonymize_email`
- `keep_screen_awake`
- `show_sync_errors`

Always read these from `useSettings()`. Do not hardcode defaults.

### Filtering and Sorting

Heavy filtering runs in web worker `src/lib/filterWorker.js`. Worker receives `{ id, cards, sfMap, search, sort, filters, priceSource, cardFolderMap }` and posts back sorted results. `matchNumeric(valStr, op, minStr, maxStr)` handles `= | < | <= | > | >= | between | in`.

Same filter logic is duplicated in `src/components/CardComponents.jsx` for non-worker path. Keep both in sync when changing filter operators.

`EMPTY_FILTERS` is exported from `src/components/CardComponents.jsx`. Always spread it as defaults.

### Collection Folder Membership Sync

`src/pages/Collection.jsx` loads binder and deck membership in two phases:

1. Read `folders`, `folder_cards`, and `deck_allocations` from IDB first and build `cardFolderMap`.
2. Sync `folders` from Supabase on every online load.
3. Sync `folder_cards` incrementally using `folder_cards.updated_at`.
4. Sync `deck_allocations` alongside folder placements.
5. Run full `folder_cards` reconcile every 10 minutes to catch remote deletes.

Delta sync state lives in IDB `meta`:
- `folder_cards_full_sync_<userId>`
- `folder_cards_delta_sync_<userId>`

If placement writes change, preserve `updated_at` behavior on `folder_cards` and keep `deck_allocations` sync logic aligned or collection and deck badges will drift.

### Collection Ownership Rules

Owned collection cards cannot exist without at least one binder or collection-deck placement.

- `src/lib/collectionOwnership.js` holds cleanup helpers.
- When removing cards from binders or collection decks, only delete underlying `cards` row if no `folder_cards` or `deck_allocations` placement remains anywhere else.
- Deleting non-empty binder or deck must offer transfer options so cards can move instead of being implicitly deleted.

### Deck Model

- `deck_cards` is source of truth for intended deck contents in Builder.
- `deck_allocations` is source of truth for owned cards assigned into collection decks.
- `folder_cards` is for binder and list placement, not deck-content truth.
- Collection deck sync and "Make Collection Deck" must operate on exact owned `cards.id` rows, not card names.
- Foil and non-foil are different exact matches in allocation logic.

### Wishlist Rules

Wishlists are not part of owned collection inventory.

- Wishlist browsing should match binder and deck browsing for view toggles, selection styling, and bulk actions.
- Wishlist bulk move must only allow destinations of type `list`.
- Wishlist grid rendering should use shared binder-style `CardGrid`, not separate wishlist-only grid implementation.
- `list_items` access is folder-owned: inserts and policies should derive ownership from parent folder, not caller-supplied `list_items.user_id`.

### Selection and Quantity Semantics

- Bulk selection counts should use selected copy count when `selectedQty` is available, not only distinct card rows.
- In quantity adjusters, pressing `-` at `1 of N` should deselect card entirely.
- In collection, expanded per-folder tiles must use folder-specific quantity from `folder_cards.qty` for badges and selection totals instead of merged collection quantity.

### Routing

React Router v6. `src/App.jsx` uses `BrowserRouter` with `basename="/arcanevault"` for GitHub Pages compatibility. Public routes:
- `/login`
- `/share/:token`
- `/join/:code`

All other routes require auth and are wrapped in `PrivateApp`.

### Vite Proxies

Development only:

```text
/api/edhrec    -> json.edhrec.com
/api/archidekt -> archidekt.com
/api/moxfield  -> api.moxfield.com
/api/goldfish  -> mtggoldfish.com
```

These only exist during `npm run dev`. Production deploy on GitHub Pages cannot use them. CORS-restricted APIs will fail in production.

---

## Key Files

| File | Role |
| --- | --- |
| `src/lib/db.js` | IDB layer for all local reads and writes |
| `src/lib/scryfall.js` | Scryfall metadata and image cache plus batch lookup helpers |
| `src/lib/sharedCardPrices.js` | Applies shared Supabase daily prices onto cached Scryfall card data |
| `src/lib/filterWorker.js` | Web worker for filtering and sorting |
| `src/scanner/DatabaseService.js` | pHash DB: SQLite native plus Supabase fallback on web, LSH band index, IDB pre-parsed cache |
| `src/scanner/ScannerEngine.js` | OpenCV.js card detection, perspective warp, art crop, reticle crop, 180-degree rotation, pHash |
| `src/scanner/hashCore.js` | Pure JS pHash core with precomputed DCT cosine table, CLAHE, percentileCap, Hamming distance |
| `src/scanner/constants.js` | Shared card and art dimensions |
| `src/scanner/CardScanner.jsx` | Full-screen scanner UI |
| `src/pages/Scanner.jsx` | Route wrapper for `CardScanner` at `/scanner` |
| `scripts/generate-card-hashes.js` | Seed script that downloads Scryfall art crops, computes pHashes, uploads to Supabase |
| `src/lib/fx.js` | EUR to USD conversion via frankfurter.app with 6-hour IDB cache |
| `src/lib/deckBuilderApi.js` | Deck builder helpers plus external API calls |
| `src/lib/csvParser.js` | Manabox CSV to cards and folders |
| `src/components/CardComponents.jsx` | `FilterBar`, `CardDetail`, `CardGrid`, `EMPTY_FILTERS`, `applyFilterSort`, `BulkActionBar` |
| `src/components/VirtualCardGrid.jsx` | Virtualized card grid with `@tanstack/react-virtual` |
| `src/components/AddCardModal.jsx` | Add card modal for OCR or manual search |
| `src/components/ImportModal.jsx` | Bulk import wizard |
| `src/components/SettingsContext.jsx` | `SettingsProvider` and `useSettings()` |
| `src/components/Auth.jsx` | `AuthProvider`, `useAuth()`, and `LoginPage` |
| `src/pages/Collection.jsx` | Main collection browser |
| `src/pages/Home.jsx` | Dashboard |
| `src/pages/Folders.jsx` | Binders index plus `FolderBrowser` |
| `src/pages/Lists.jsx` | Wishlists index plus `ListBrowser` |
| `src/pages/DeckBrowser.jsx` | Card browser inside deck |
| `src/pages/DeckView.jsx` | Shared deck view page |
| `src/pages/DeckView.module.css` | Styles for DeckView |
| `src/pages/Stats.jsx` | Collection analytics |
| `src/pages/LifeTracker.jsx` | Multiplayer life tracker |
| `src/pages/LifeTracker.module.css` | Styles for LifeTracker |
| `src/pages/JoinGame.jsx` | Public route at `/join/:code` |
| `src/components/FeedbackModal.jsx` | Bug report and feature request modal |

---

## Patterns and Conventions

### CSS Modules

Every page and major component has paired `.module.css`. Use CSS variables for theming:

```css
var(--gold)
var(--bg)
var(--bg2)
var(--bg3)
var(--border)
var(--border-hi)
var(--text)
var(--text-dim)
var(--text-faint)
var(--green)
var(--font-display)
var(--s1)
var(--s2)
var(--s3)
var(--s4)
var(--s-card)
var(--s-subtle)
var(--s-medium)
var(--s-border)
var(--s-border2)
```

Light theme critical rule: never use hardcoded `rgba(255,255,255,0.X)` for interactive borders or backgrounds. Use surface variables like `var(--s-border)`, `var(--s-border2)`, and `var(--s-medium)`.

Recurring patterns:

- Dot-grid page background on `.page`
- Gold top-border cards on folder cards, stat cards, and list items
- View toggle pill in `FolderBrowser`, `ListBrowser`, and `DeckView`
- Section label with extending rule for binder, wishlist, and stat section headers

### Component Conventions

- Pages load their own data, IDB-first with Supabase fallback.
- Skeleton loaders use CSS shimmer animation.
- All monetary displays go through `formatPrice()`.
- `CardDetail` locks `document.body.style.overflow = 'hidden'` while open and restores it on unmount. Do not add second scroll lock elsewhere.
- Top-level page wrappers use `<div className={styles.page}>` with dot-grid background.

### Add Card Modal

- Cards must always save to deck, binder, or wishlist. "Collection" destination tab is removed. `canSave` requires `selectedFolder != null`.
- `folderMode=true` pre-selects folder type and uses searchable dropdown.
- `folderMode=false` shows tab buttons for deck, binder, and wishlist.
- `initialCardName` auto-triggers `selectCard()` on mount. Scanner uses this for "+ Add to Collection".

### Import Modal

- If first line contains comma and matches `/\bname\b/i`, treat as Manabox CSV.
- Otherwise treat as plain decklist like `4 Lightning Bolt`.
- For `list` type: upsert into `list_items` with conflict on `folder_id,set_code,collector_number,foil`.
- For binder and deck: upsert into `cards` then `folder_cards`.

### Select Mode and Qty Adjuster

- `splitState: Map<cardId, selectedQty>` tracks selected copies.
- First click on multi-copy card selects qty `1`, not all copies.
- `onAdjustQty(id, delta, totalQty)` clamps to `[1, totalQty]`. No DB write until bulk action.
- `BulkActionBar` receives `selectedQty` so copy count stays accurate.

### useLongPress Hook

Long-press at 500 ms enters select mode. Always destructure `onMouseLeave` from hook result and merge manually. Do not spread long-press props after explicit `onMouseLeave`.

### Card Scanner

Pipeline overview:

```text
captureFrame()
  -> full-res ImageData for warpCard
  -> small ImageData for detectCardCorners

detectCardCorners()
  -> 3-pass corner detection

warpCard()
  -> 500x700 ImageData

cropArtRegion()
  -> art crop

computePHash256()
  -> Uint32Array(8)

databaseService.findBestTwoWithStats(hash)

stability voting
```

Reticle fallback: when no corners found, `cropCardFromReticle(srcCanvas, w, h, vw, vh)` crops from camera canvas directly. Pass `srcCanvas` to skip expensive `putImageData` copy.

180-degree rotation fallback: after each warp or reticle pass, if no decisive match, run `rotateCard180(warpedCard)`.

Foil fallback: if standard hash distance exceeds `MATCH_THRESHOLD`, `computePHash256Foil(artCrop)` re-hashes with stronger glare suppression. Stored DB hashes do not change.

Hash algorithm must match seed script exactly:
1. `GaussianBlur` sigma `1.0` on art crop
2. Resize to `32x32` with `INTER_LANCZOS4`
3. BT.709 grayscale via `rgbToGray32x32`
4. `percentileCap(0.98)`
5. `CLAHE(tileGrid=4x4, clipLimit=40)`
6. 2D DCT via `dct2d()` with precomputed cosine and norm tables
7. Top-left `16x16` DCT coefficients, median threshold, 256-bit hash

If any step changes, truncate `card_hashes` and re-seed.

Supabase `BIGINT` precision note: do not read hash parts as JS numbers. Read `phash_hex TEXT` only.

### Life Tracker

Host creates session, others visit `/join/:code`, host starts game.

- `game_sessions`: `id, code, status ('waiting'|'playing'), config, host_user_id`
- `game_players`: `id, session_id, slot_index, user_id, display_name, color, deck_name`
- 6-char join code uses `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
- Join URL uses `import.meta.env.BASE_URL`
- Realtime uses Supabase `postgres_changes` subscriptions
- `JoinGame.jsx` is public route outside `PrivateApp`

Unified game log:

`gameLog: [{ts, type, playerName, playerColor, delta, total, key?, fromName?}]`

New entries go first. Max 120. Each event must carry `playerName` and `playerColor` at call site to avoid stale closures.

Removed and stale names:
- `PlayerHistoryOverlay`
- per-player history button in `nameRow`
- `playerHistory`
- `historyPlayerId`
- `addHistoryEvent`

---

## Supabase Table Notes

- `cards`: owned cards, RLS by `user_id`
- `folders`: type is `'binder' | 'deck' | 'list' | 'builder_deck'`
- `folder_cards`: `folder_id + card_id + qty` for binders and lists
- `deck_allocations`: `deck_id + card_id + qty` for owned cards assigned into collection decks
- `list_items`: wishlist items
- `deck_cards`: builder deck cards
- `card_prints`: normalized print metadata shared across ownership, deck builder, prices, and scanner
- `user_settings`: one row per user
- `card_prices`: shared daily market prices keyed by `scryfall_id + snapshot_date`
- `game_sessions`: multiplayer life tracker sessions
- `game_players`: player slots per session
- `game_results`: deck win and loss history
- `feedback`: bug reports and feature requests
- `feedback_attachments`: optional screenshots stored in `assets` bucket
- `card_hashes`: scanner pHash records; read-only RLS for all users

---

## External APIs

| Service | Usage | Notes |
| --- | --- | --- |
| Scryfall | Card data, search, autocomplete, catalog | Rate-limited: 75 cards per batch, 120 ms delay |
| Supabase | Auth and cloud sync | RLS enforced, never bypass with service key |
| frankfurter.app | EUR to USD rates | Cached 6 hours in IDB |
| EDHRec | Commander recommendations | Via Vite proxy `/api/edhrec` in dev only |
| codetabs.com proxy | MTG RSS feeds | `api.codetabs.com/v1/proxy?quest=<url>` returns raw XML |

RSS parsing rule:

- MTGGoldfish uses Atom: `<feed>/<entry>`, link from `href` attribute
- EDHREC and MTGArenaZone use RSS 2.0: `<rss>/<item>`, link from `textContent`
- Detect Atom first with `doc.querySelector('feed')`

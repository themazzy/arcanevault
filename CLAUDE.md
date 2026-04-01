# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## ⚠️ Do Not Use Subagents

**Never** spawn subagents (Agent tool) for any task in this project. Perform all research, searches, and edits directly in the main conversation. Subagents waste tokens.

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

`src/components/Auth.jsx` passes `emailRedirectTo: 'https://themazzy.github.io/arcanevault/'` in `signUp()` to ensure Supabase confirmation emails link to prod, not localhost. Also configure **Site URL** and **Redirect URLs** in the Supabase Dashboard → Auth → URL Configuration to match.

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

- `src/lib/db.js` — All IndexedDB access. Use `getLocalCards(userId)`, `getLocalFolders(userId)`, `getAllLocalFolderCards(folderIds)` for reads. `replaceLocalFolderCards(folderIds, rows)` is the bulk-reconcile helper for collection folder membership sync. Never bypass IDB for performance-critical pages.
- `src/lib/supabase.js` — Exports the `sb` singleton. Used for auth + cloud sync fallback only.
- `src/lib/scryfall.js` — Scryfall data fetched in batches of 75, merged into IDB. `getInstantCache()` returns in-memory map (null if cold); always guard with `sfMap || {}`.

**Key gotcha:** Never use Supabase's nested `select('folder_cards(cards(*))')` — it requires FK relationships configured in PostgREST and silently returns empty. Always do flat queries and join in memory.

### IDB Schema (v3)

| Store | Key | Description |
|---|---|---|
| `scryfall` | `${set_code}-${collector_number}` | Card metadata + prices |
| `cards` | `id` | User's owned cards |
| `folders` | `id` | Binders, decks, wishlists, builder decks |
| `folder_cards` | `id` | Cards ↔ folders join (`qty`, `updated_at` used for incremental sync) |
| `deck_cards` | `id` | Deck builder cards (independent of collection) |
| `meta` | string key | Sync timestamps, cache versions |

### Pricing

- `getPrice(sfCard, foil, { price_source })` → numeric value
- `formatPrice(value, priceSourceId)` → `"€1.23"` or `"$1.23"`
- `getPriceWithMeta(sfCard, foil, opts)` → `{ value, symbol, isFallback, pct }`
- Manual overrides stored in `localStorage` as `arcanevault_manual_prices`
- Price source from `useSettings().price_source` — always pass it down; never hardcode.

### Settings

`useSettings()` returns all user preferences plus `save(patch)`, `syncNow()`, sync status, and the last sync error. Settings write to `localStorage` immediately and debounce a Supabase upsert (800 ms).

Important settings now include:
- display: `theme`, `oled_mode`, `higher_contrast`, `reduce_motion`
- text/accessibility: `font_size`, `font_weight`, `card_name_size`
- browsing: `price_source`, `grid_density`, `show_price`, `cache_ttl_h`, `default_grouping`
- profile/app: `nickname`, `anonymize_email`, `keep_screen_awake`, `show_sync_errors`

Always read these values from `useSettings()` instead of hardcoding defaults in feature code.

### Filtering & Sorting

Heavy filtering runs in a **Web Worker** (`src/lib/filterWorker.js`) off the main thread. The worker receives a message `{ id, cards, sfMap, search, sort, filters, priceSource, cardFolderMap }` and posts back sorted results. `matchNumeric(valStr, op, minStr, maxStr)` handles `= | < | <= | > | >= | between | in`.

The same filter logic is duplicated in `CardComponents.jsx` for the non-worker path — keep both in sync when changing filter operators.

`EMPTY_FILTERS` is exported from `CardComponents.jsx` — always spread it as defaults.

### Collection Folder Membership Sync

`src/pages/Collection.jsx` loads binder/deck membership in two phases:

1. Read `folders` + `folder_cards` from IDB first and build `cardFolderMap` immediately.
2. Sync `folders` from Supabase on every online load.
3. Sync `folder_cards` incrementally using `folder_cards.updated_at`.
4. Run a full `folder_cards` reconcile every 10 minutes to catch remote deletes that delta sync cannot see.

Delta sync state is stored in IDB `meta` with:
- `folder_cards_full_sync_<userId>`
- `folder_cards_delta_sync_<userId>`

Required DB pieces:
- `folder_cards.updated_at`
- index `folder_cards_updated_at_idx`
- trigger `folder_cards_updated_at` using `update_updated_at()`

If you change folder membership writes, preserve `updated_at` behavior or collection load performance will regress. Remote folder deletions are handled by syncing `folders` every load and pruning missing local folders; remote `folder_cards` deletions are caught on the periodic full reconcile.

### Collection Ownership Rules

Owned collection cards cannot exist without at least one binder or collection-deck placement.

- `src/lib/collectionOwnership.js` holds the cleanup helpers for this rule.
- When removing cards from binders or collection decks, only delete the underlying `cards` row if no `folder_cards` placement remains anywhere else.
- Deleting a non-empty binder or deck must offer transfer options so cards can be moved instead of being implicitly deleted.

### Wishlist Rules

Wishlists are not part of owned collection inventory.

- Wishlist browsing should match binder/deck browsing for view toggles, selection styling, and bulk actions.
- Wishlist bulk move must only allow destinations of type `list`.
- Wishlist grid rendering should use the shared binder-style `CardGrid`, not a separate wishlist-only grid implementation.
- "View All Cards" should behave like the binder/deck all-cards browser, including mixed-folder context labels where needed.
- `list_items` access is folder-owned: inserts and policies should derive ownership from the parent folder, not rely on a caller-supplied `list_items.user_id`.

### Selection And Quantity Semantics

- Bulk selection counts should use selected copy count when `selectedQty` is available, not just distinct card rows.
- In quantity adjusters, pressing `-` at `1 of N` should deselect that card entirely.
- In collection, expanded per-folder tiles must use folder-specific quantity from `folder_cards.qty` for badges and selection totals instead of merged collection quantity.

### Routing

React Router v6. `BrowserRouter` in `src/App.jsx` uses `basename="/arcanevault"` for GitHub Pages compatibility. Public routes: `/login`, `/share/:token`, `/join/:code`. All other routes require auth and are wrapped in `PrivateApp`.

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
| `src/lib/db.js` | IDB layer — all local reads/writes |
| `src/lib/scryfall.js` | Scryfall API client + price cache |
| `src/lib/filterWorker.js` | Web Worker: filter + sort logic |
| `src/lib/scanner.js` | Legacy OCR pipeline (Tesseract + dHash) — superseded by `src/scanner/` |
| `src/scanner/DatabaseService.js` | pHash DB: SQLite (native) + Supabase fallback (web); sync + in-memory search |
| `src/scanner/ScannerEngine.js` | OpenCV.js card detection, perspective warp, art crop, 256-bit pHash |
| `src/scanner/CardScanner.jsx` | Full-screen scanner UI: camera, targeting reticle, stability buffer, match panel |
| `src/pages/Scanner.jsx` | Route wrapper for `CardScanner` at `/scanner` |
| `scripts/generate-card-hashes.js` | Node.js seed script: downloads Scryfall art crops, computes pHashes, uploads to Supabase |
| `src/lib/fx.js` | EUR↔USD conversion via frankfurter.app (6 h IDB cache) |
| `src/lib/deckBuilderApi.js` | Deck builder helpers + external API calls |
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
| `src/pages/DeckBrowser.jsx` | Card browser inside a deck — list/stacks/grid/text/table views |
| `src/pages/DeckView.jsx` | Shared deck view page (collection decks + builder decks) — sticky topbar, ManaText, card detail |
| `src/pages/DeckView.module.css` | Styles for DeckView — dot-grid page, sticky header, mana symbol colours |
| `src/pages/Stats.jsx` | Collection analytics — value distribution, format legality, gainers/losers, age spread |
| `src/pages/LifeTracker.jsx` | Multiplayer life tracker — pre-game setup, game screen, player-settings overlay, commander damage, lobby, JoinGame route |
| `src/pages/LifeTracker.module.css` | Styles for LifeTracker — grid layouts, rotations, fullscreen, compact active-game controls, player-settings overlay, lobby breakpoints |
| `src/pages/JoinGame.jsx` | Public route `/join/:code` — join a multiplayer lobby, pick deck/name/colour |
| `src/pages/JoinGame.module.css` | Styles for JoinGame page |
| `src/components/FeedbackModal.jsx` | Bug report / feature request modal — type toggle, description, optional contact, optional screenshot upload |
| `src/components/FeedbackModal.module.css` | Styles for FeedbackModal |

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

**Light theme critical rule:** Never use hardcoded `rgba(255,255,255,0.X)` for borders or backgrounds on interactive elements — they are invisible on light themes. Use `var(--s-border)` / `var(--s-border2)` / `var(--s-medium)` etc. instead. The `[data-theme-mode="light"]` block in `index.css` now also overrides `--text`, `--text-dim`, `--text-faint`, `--gold`, `--gold-dim`, `--green`, `--red`, `--purple`, `--border`, `--border-hi` to dark values for WCAG contrast on near-white backgrounds.

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

**View toggle pill** — grid/list switcher pattern used in `FolderBrowser`, `ListBrowser`, and `DeckView`:
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
- Horizontal scroll strips use `.hScroll` with `overflow-x: auto` + thin scrollbars.
- All monetary displays go through `formatPrice()` — never format manually.
- `addRecentlyViewed(card)` in `Home.jsx` persists to localStorage and fires `window.dispatchEvent(new CustomEvent('av:viewed'))` for live updates.
- `CardDetail` locks `document.body.style.overflow = 'hidden'` while open and restores it on unmount — do not add a second scroll lock elsewhere.
- All top-level page wrappers use `<div className={styles.page}>` with the dot-grid background (see CSS Modules → Recurring visual patterns above).

### Add Card Modal (`AddCardModal.jsx`)

- Cards must always be saved to a **deck, binder, or wishlist** — the "Collection" destination tab has been removed. `canSave` requires `selectedFolder != null`.
- The queue supports per-item qty adjustment via `+`/`−` buttons (`updateQueueQty`).
- `folderMode=true` (used from Folders/DeckBrowser) pre-selects folder type and uses a searchable dropdown. `folderMode=false` (used from Collection) shows tab buttons for deck/binder/wishlist.

### Import Modal (`ImportModal.jsx`)

- Unified bulk import for all folder types. Props: `{ userId, folderType, folders, defaultFolderId, onClose, onSaved }`.
- Auto-detects format: if first line contains a comma and matches `/\bname\b/i` → Manabox CSV; otherwise → plain decklist (`4 Lightning Bolt`).
- Uses `parseTextDecklist` + `parseManaboxCSV` + `fetchCardsByNames` (Scryfall batch lookup).
- For `list` type: upserts into `list_items` with conflict on `folder_id,set_code,collector_number,foil`.
- For binder/deck: upserts into `cards` then `folder_cards`.

### Folder Browser (Binders — `Folders.jsx`)

`FolderBrowser` is the inline binder card viewer (rendered below the binders list when a binder is selected). It supports:
- **Grid view** — uses `CardGrid` from `CardComponents.jsx`
- **List view** — uses `BinderListView` (defined in `Folders.jsx`), a 5-column table (`1fr 180px 48px 78px 78px`): thumbnail + name/foil, set name, qty, unit price, total price
- View is toggled via the `.viewToggle` pill; default is `'grid'`
- `FilterBar` and `BulkActionBar` are always rendered regardless of view
- Header row shows binder name, total card count, total value, and an "+ Add Cards" button

`FoldersPage` wraps in `<div className={styles.page}>` for the dot-grid background.

### List Browser (Wishlists — `Lists.jsx`)

`ListBrowser` is the inline wishlist viewer. It supports:
- **List view** — tabular rows with qty, name, set, foil badge, price, delete button
- **Grid view** — uses the shared `CardGrid` / binder-style grid, not a custom wishlist grid
- View is toggled via the `.viewToggle` pill (imported from `Folders.module.css` via shared `styles`); default is `'grid'`
- Bulk move is supported, but wishlist cards may only move to other wishlists

`ListsPage` wraps in `<div className={styles.page}>` for the dot-grid background.

### Life Tracker Compact Landscape

`src/pages/LifeTracker.module.css` includes a compact profile for short phone-height active games.

- Treat `max-height: 500px` as the tight-phone breakpoint.
- Do not rely on large fixed `min-height` values for active-game player cells in that mode.
- Fullscreen landscape uses an extra-dense variant with reduced page padding, smaller player controls, and a tighter floating controls pill.
- Keep the quick life row visible in compact active-game layouts; use four dense buttons (`-10`, `-5`, `+5`, `+10`) instead of hiding the row.
- Keep commander damage status visible in compact layouts by tightening and wrapping `.cmdBar` badges rather than switching to overlay-only access.
- Player-specific color / art / partner controls now belong in a page-level settings overlay instead of expanding inline inside the player panel.

### DeckView (`DeckView.jsx`)

Shared deck-view page for both collection decks and builder decks. Key features:
- Sticky topbar with deck name (Cinzel), format badge, card count, total value, and action buttons
- ManaText renderer that converts `{W}{U}{B}{R}{G}{C}` symbols to coloured inline spans
- Card detail modal (click any card to open)
- Imports styles from `DeckView.module.css` (new file — do not confuse with `DeckBuilder.module.css`)

### Stats Page (`Stats.jsx`)

Redesigned analytics page. Sections include:
- **Value Over Time** — line chart of `price_snapshots`
- **Value Distribution** — histogram buckets (< $1, $1–5, $5–20, $20–50, $50+)
- **Format Legality** — bar chart of how many cards are legal in Standard, Pioneer, Modern, Legacy, Commander
- **Biggest Gainers / Losers** — top movers by % change since last snapshot
- **Collection Age Spread** — cards grouped by release year
- All sections use the dot-grid `.page` wrapper and gold top-border stat cards

### Life Tracker (`LifeTracker.jsx`)

A full-screen multiplayer life counter supporting Standard, Commander, and custom modes.

#### Layouts

`LAYOUTS[playerCount]` is an array of layout objects. Each object has:
- `id` — unique string
- `cols` — CSS grid column count
- `label` — display name
- `rotations` — `{ [playerIndex]: degrees }` — 0 (default), 90, −90, or 180

Current layouts for 4 players: `4-2x2` (2×2 grid, bottom players rotated 180°), `4-sides` (2×2 grid, all players rotated ±90° to face the sides), `4-row` (single row).

#### Grid & Rotation

Each player is wrapped in a `.gridCell` (`position: relative; overflow: hidden`). Rotated panels use `position: absolute; inset: 0` so they fill their cell before rotating — the cell clips any overflow. Without the `gridCell` wrapper, rotated panels bleed into adjacent cells.

`.grid` requires an explicit `height` for `grid-auto-rows: 1fr` to distribute rows equally.

#### Fullscreen Mode

`isFullscreen` state adds `.pageFullscreen` to the page root:
- `.pageFullscreen .topBar { display: none }` — hides the topbar entirely
- `.pageFullscreen .grid { height: 100dvh !important }` — grid fills the whole screen
- The central floating settings button remains visible, but its action list is now a modal action sheet instead of a small dropdown so it never overlaps commander/settings overlays

Use `100dvh` (dynamic viewport height) in fullscreen — not `100svh` — so Android Chrome's collapsing address bar is tracked correctly.

**Gear menu ref gotcha:** The topbar and `fsControls` each render a gear wrap. Use **two separate refs** (`gearMenuRef` for the topbar, `gearMenuFsRef` for fsControls) and check both in the `pointerdown` outside-click handler. If both share one ref, React nullifies it when `fsControls` unmounts, causing the menu to close instantly after exiting fullscreen.

#### Landscape phone breakpoints

- `@media (max-width: 900px)` — rotations and grid height applied (`calc(100svh - 192px)`)
- `@media (max-height: 500px)` — compact phone-height active game mode; shrinks panel elements aggressively but keeps the quick life row and commander damage bar visible so core actions are still available on small displays.

#### Active Player Controls

- `PlayerPanel` keeps the central life total narrow and lets the large side `-` / `+` buttons expand toward the panel edges, increasing tap area on small screens.
- The quick life row is intentionally limited to `-10`, `-5`, `+5`, `+10`; the single-step `-` / `+` actions belong only on the large side buttons.
- Player settings open a page-level `PlayerSettingsOverlay` from the cog button; that overlay owns color selection, background art, and the partner-commanders toggle.

#### Seat Selection (`SeatLayoutGrid`)

Tap-to-swap component used in both `PreGameSetup` (local) and `LobbyScreen` (shared). Mirrors the actual game grid — same `position: absolute; inset: 0; transform: rotate()` within `overflow: hidden` cells. Selected seat highlighted with gold border; tapping two seats swaps them. In local lobby uses `swapConfigs(i,j)`; in lobby uses `seatOrder` array applied at game start.

#### Host Setup Screen (`HostSetupScreen`)

After creating a shared lobby, host is taken to `HostSetupScreen` (screen `'host-setup'`) before the lobby is visible. Same name/color/deck/art form as JoinGame — writes to Supabase `game_players` slot 0 with `claimed_at`. On submit → `setScreen('lobby')`.

#### Unified Game Log

`gameLog: [{ts, type, playerName, playerColor, delta, total, key?, fromName?}]` — flat array (newest first, max 120 entries) replacing the old per-player `playerHistory` keyed object. Updated via `addGameLogEvent(event)` from `onLifeChange`, `onCounterChange`, and `onCmdDmgChange`. Each event carries `playerName`/`playerColor` at the call site (not inside the callback) so there's no stale-closure issue.

`GameLogOverlay` — renders the flat log in a `.cmdOverlayPanel` modal. Accessed via ⚙ gear menu → "📜 Game Log" (appears in both topbar and fsControls menus). State: `showGameLog` boolean. Cleared in `handleNewGame` and `resetGame`.

In fullscreen, the center ⚙ button opens a dedicated modal action sheet. Keep it below higher-priority overlays and close it whenever another life-tracker overlay opens.

**Removed:** `PlayerHistoryOverlay` (per-player log), per-player 📜 button in `nameRow`, `playerHistory`/`historyPlayerId` state, `addHistoryEvent`. If you see any of these names they are stale.

#### Low-life Animations

Applied to `PlayerPanel` based on `player.life` (not applied when `isDead`):
- `isLow = !isDead && life <= 10 && life > 5` → `.playerLifeLow` — slow amber border pulse (`lifeLowPulse`, 2.8 s)
- `isCrit = !isDead && life <= 5 && life > 0` → `.playerLifeCrit` — fast red border pulse (`lifeCritPulse`, 1.3 s)

Both animate `border-top-color` and `box-shadow` only, leaving layout/opacity untouched.

#### Death Messages

`DEATH_TEXTS` — constant array of 55+ MTG-flavoured death strings (e.g. "Phyrexian Compleatified", "Mulliganned into the shadow realm"). `PlayerPanel` holds `deathText` state: set to a random entry when `isDead` first becomes `true`, cleared when the player is revived. Rendered as an `position: absolute; inset: 0` overlay (`.deathOverlay`) with a 💀 icon + text — only visible when both `isDead && deathText` are truthy. `pointer-events: none` so the panel remains interactive underneath.

#### Counter Tab UI

Tabs are now **column flex** (icon stacked above text label). New classes:
- `.counterTabIcon` — `font-size: 0.9rem`
- `.counterTabLabel` — `font-size: 0.5rem; text-transform: uppercase; letter-spacing: 0.05em`

Counter section background uses `var(--s2)` (not hardcoded `rgba(0,0,0,0.22)`) so it renders correctly on light themes.

#### Deck Win/Loss Stats

`deckStatsMap: { [deck_id]: { wins, losses, games, win_pct } }` — fetched from `game_results` table on mount, refreshed after each `handleSaveGame`. Passed to `PlayerConfig` which renders e.g. `3W–1L (75%)` next to the deck dropdown. Only ArcaneVault decks (with a `deck_id`) are tracked. For shared lobbies, host inserts results for all players.

#### Preferred Nickname

`useSettings().nickname` — saved in `DEFAULTS`, synced to Supabase `user_settings`. Passed as prop to `PreGameSetup` (fills `configs[0].name`) and `HostSetupScreen` (fills default name input). Editable in Settings → Profile section.

#### Local Lobby Deck Selection

`PlayerConfig` receives `decks={i === 0 ? decks : []}` — deck dropdown only shown for Player 1 (the logged-in user). Other local players have no deck tracking since we don't know their account.

#### Multiplayer Lobby (shared-device, Option A)

Host creates a session → others visit `/join/:code` on their own device to pick name/colour/deck → host starts game on the host device.

- `game_sessions` table: `id, code, status ('waiting'|'playing'), config, host_user_id, created_at`
- `game_players` table: `id, session_id, slot_index, user_id, display_name, color, deck_name`
- 6-char join code uses `CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'` (no ambiguous chars)
- Join URL built with `import.meta.env.BASE_URL` for correct dev/prod paths
- Realtime via Supabase `postgres_changes` subscriptions on both tables
- `JoinGame.jsx` is a **public route** (outside `PrivateApp`) at `/join/:code`

#### Supabase tables required

```sql
-- Run once in Supabase SQL editor
create table game_sessions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  status text not null default 'waiting',
  config jsonb,
  host_user_id uuid references auth.users,
  created_at timestamptz default now()
);
create table game_players (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references game_sessions on delete cascade,
  slot_index int not null,
  user_id uuid references auth.users,
  display_name text,
  color text,
  deck_name text
);
-- Enable RLS + policies (select/insert/update by authenticated users)
alter table game_sessions enable row level security;
alter table game_players  enable row level security;
create policy "read sessions"  on game_sessions for select using (true);
create policy "insert sessions" on game_sessions for insert with check (auth.uid() = host_user_id);
create policy "update sessions" on game_sessions for update using (auth.uid() = host_user_id);
create policy "read players"   on game_players  for select using (true);
create policy "insert players" on game_players  for insert with check (auth.role() = 'authenticated');
create policy "claim slot"     on game_players  for update using (user_id is null or user_id = auth.uid());
```

Also enable Realtime on both tables: Supabase Dashboard → Database → Replication → `supabase_realtime` publication → toggle on `game_sessions` and `game_players`.

```sql
-- Game results (deck win/loss tracking)
create table game_results (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references game_sessions,
  user_id uuid references auth.users,
  deck_id uuid references folders,
  deck_name text,
  format text,
  player_count int,
  placement int,
  played_at timestamptz default now()
);
alter table game_results enable row level security;
create policy "read own results" on game_results for select using (auth.uid() = user_id);
create policy "insert results" on game_results for insert with check (
  auth.uid() = user_id
  or exists (select 1 from game_sessions where id = session_id and host_user_id = auth.uid())
);

-- Feedback (bug reports & feature requests)
create table feedback (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('bug', 'feature')),
  description text not null,
  contact text,
  user_id uuid references auth.users,
  user_email text,
  created_at timestamptz default now()
);
alter table feedback enable row level security;
create policy "insert feedback" on feedback for insert with check (true);
create policy "read own feedback" on feedback for select using (auth.uid() = user_id);

-- Screenshot uploads for feedback
create table feedback_attachments (
  id uuid primary key default gen_random_uuid(),
  feedback_id uuid not null references feedback(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  user_email text,
  file_key text not null,
  file_name text,
  mime_type text,
  file_size bigint,
  created_at timestamptz default now()
);

-- Newer user_settings columns
alter table user_settings
  add column if not exists nickname text default '',
  add column if not exists anonymize_email boolean default false,
  add column if not exists reduce_motion boolean default false,
  add column if not exists higher_contrast boolean default false,
  add column if not exists card_name_size text default 'default',
  add column if not exists default_grouping text default 'type',
  add column if not exists keep_screen_awake boolean default false,
  add column if not exists show_sync_errors boolean default false;
```

### Select Mode & Qty Adjuster

Cards in Collection, Binders, Decks, and Wishlists can be selected for bulk move/delete. Multi-copy cards show an in-card quantity adjuster when selected:

- `splitState: Map<cardId, selectedQty>` tracks how many copies of each card are selected
- First click on a multi-copy card → selects it with qty **1** (not all copies)
- When selected and `qty > 1`: a `+`/`−` overlay appears on the card image with `N of M` label — `+` at top, `−` at bottom
- `onAdjustQty(id, delta, totalQty)` increments/decrements, clamped to `[1, totalQty]`
- No DB write until bulk action (`handleBulkDelete` / `handleMoveToFolder`) — those use `splitState.get(id) ?? 1`
- Grid/stacks views: full-image overlay with `+`/`−` buttons. List view (DeckBrowser): inline `−`/`N/M`/`+` buttons in the qty column
- `BulkActionBar` receives `selectedQty` (sum of selected copies) to show accurate copy count
- Implemented consistently across: `VirtualCardGrid` (Collection), `CardGrid` (Binders), `DeckCardGrid`/`StacksView`/`DeckListGroup` (Decks), `WishlistGrid` (Wishlists)

### Move To Dialog

`BulkActionBar` has a "Move to…" button that opens `MoveToDialog` (defined in `CardComponents.jsx`):
- Uses `Modal` from `UI.jsx`
- Toggle between Binder / Deck destination types
- Searchable list of existing folders
- "Create new" inline form that calls `onCreateFolder(type, name)` and moves immediately
- Works from Collection, DeckBrowser, and FolderBrowser (Binders)

### useLongPress Hook

Long-press (500 ms) on any card in select-capable views enters select mode. **Always** destructure `onMouseLeave` from the hook result and merge manually — never spread `{...longPress}` after an explicit `onMouseLeave`:

```jsx
const { onMouseLeave: lpLeave, ...lpRest } = longPress
// then in JSX:
onMouseLeave={e => { myOwnLeaveHandler(); lpLeave?.(e) }}
{...lpRest}
```

### Scryfall Queries

Use Scryfall syntax when building search queries:
- Types: `t:Creature`, `t:"Legendary Creature"`
- Colors: `c:RG` (includes), `c>=RG` (at least), `c=RG` (exact), `id:RG` (identity)
- Numerics: `cmc=3`, `pow>=2`, `tou<4`
- Rarity: `r:rare`, `r:mythic`
- Oracle: `o:"draw a card"`
- Format: `f:commander`, `f:modern`

### Card Scanner (`src/scanner/`)

Replaced the old OCR pipeline with a **pHash + OpenCV** approach. New pipeline:

1. **Camera capture** — `@capacitor-community/camera-preview` (native, renders behind transparent WebView) or `getUserMedia` (web fallback). Camera starts immediately on mount, no button required. Web fallback applies continuous autofocus/exposure via `applyConstraints`.
2. **Card detection** — `ScannerEngine.detectCardCorners()`: grayscale → GaussianBlur → adaptive Canny (thresholds derived from image median brightness) → dilate → findContours → approxPolyDP (4 vertices) → aspect ratio filter (0.65–0.77, tight MTG card window) → largest area.
3. **Perspective warp** — `warpCard()`: normalise card to 500×700 ImageData.
4. **Art crop** — `cropArtRegion(cardImageData, yOffset)`: ROI `{x:25, y:55, w:450, h:275}` on warped card. Accepts `yOffset` for multi-crop hashing.
5. **Multi-crop hashing** — 3 y-offsets `[0, -10, 10]` tried per frame; best result (lowest distance) used to compensate for warp residuals.
6. **256-bit pHash** — `computePHash256()`: Gaussian blur 5×5 σ=1.0 (reduces camera sensor noise, matches `sharp().blur(1.0)`) → resize to 32×32 with `INTER_LANCZOS4` → manual BT.709 grayscale (`0.2126R+0.7152G+0.0722B`) → CLAHE (`cv.createCLAHE(40.0, Size(4,4))`, local contrast normalisation, 8×8-pixel tiles on 32×32, actualClip=10 per bin) → pure-JS 2D DCT (identical to seed script) → top-left 16×16 coefficients → 256 bits packed as 4 × BigInt64.
7. **DB lookup + gap check** — `DatabaseService.findBestTwo()`: XOR + popcount Hamming distance on all hashes; match confirmed only if `best.distance ≤ MATCH_THRESHOLD (110)` AND `gap = second.distance − best.distance ≥ MIN_GAP (15)`.
8. **Stability buffer** — requires 2 consecutive frames with same card ID before confirming; haptic feedback on confirm.
9. **Scan history + add flow** — confirmed matches accumulate in a horizontal history strip; tap any card to open an overlay with "+ Add to Collection" → opens `AddCardModal` pre-filled with the card name.

#### Key implementation notes

- **BigInt precision**: Supabase BIGINT returned as JS Number loses bits >53. Store `phash_hex TEXT` (64 hex chars) and read that column exclusively; parse with `BigInt('0x' + chunk)`.
- **Hash algorithm must match exactly**: Client (`ScannerEngine.computePHash256`) and seed script (`generate-card-hashes.js`) must use identical: Gaussian blur σ=1.0, Lanczos resize, BT.709 grayscale, CLAHE (tileGrid=4×4, clipLimit=40), pure-JS `dct2d()`. If any step changes, **truncate `card_hashes` and re-seed**.
- **OpenCV.js**: Loaded via async CDN `<script>` tag (not bundled). Check `window.cv` readiness via polling (`waitForOpenCV()`).
- **DB loading**: PostgREST caps `.range()` at 1000 rows per request. Web path loads page 0 synchronously (so scanner works immediately), then continues in background 8 pages at a time in parallel (`_continueWebLoad`). 100k+ cards take ~5–10 s to fully load.
- **SQLite web fallback**: `@capacitor-community/sqlite` doesn't work in browsers. Web path fetches from Supabase directly.
- **`AddCardModal` `initialCardName` prop**: Pass a card name to auto-trigger `selectCard()` on mount, jumping straight to the configure view. Used by `Scanner.jsx` when user taps "+ Add to Collection".
- **Scanner route UX**: the scanner is a first-class nav destination (`/scanner`), not a hidden utility. Treat scan history and direct add-card flow as part of the primary collection workflow.
- **Transparent WebView**: `this.bridge.getWebView().setBackgroundColor(Color.TRANSPARENT)` in `MainActivity.java` makes the native camera visible behind the overlay.
- **Android back button**: `onBackPressed()` in `MainActivity.java` calls `webView.goBack()` when `canGoBack()` is true (React Router's pushState history). When at the root (no history), requires a **double-tap within 2 s** to exit — first tap shows a `Toast` ("Press back again to exit"), second tap within the window calls `super.onBackPressed()`. Do not install `@capacitor/app` just for this — the WebView history approach is sufficient for a SPA.
- **DEBUG flag**: `CardScanner.jsx` has `const DEBUG = true` at the top — set to `false` once scanner accuracy is confirmed. Shows live hash count, CV/DB ready, stage, best candidate name, and stability counter.

#### Supabase `card_hashes` table (run once)

```sql
create table card_hashes (
  id            uuid primary key default gen_random_uuid(),
  scryfall_id   text not null unique,
  name          text,
  set_code      text,
  collector_number text,
  image_uri     text,
  hash_part_1   bigint, hash_part_2 bigint, hash_part_3 bigint, hash_part_4 bigint,
  phash_hex     text,
  updated_at    timestamptz default now()
);
alter table card_hashes enable row level security;
create policy "read card_hashes" on card_hashes for select using (true);
```

#### Seeding hashes

```bash
cd scripts
npm install node-fetch sharp @supabase/supabase-js dotenv
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node generate-card-hashes.js
```

Processes ~30k+ cards. Downloads `art_crop` images from Scryfall, skips rows already in DB. Run once after creating the table.

### Supabase Table Notes

- `cards` — user's owned cards, RLS by `user_id`
- `folders` — type is `'binder' | 'deck' | 'list' | 'builder_deck'`
- `folder_cards` — links `folder_id` + `card_id` + `qty`
- `list_items` — wishlist items: `folder_id, name, set_code, collector_number, scryfall_id, foil, qty`
- `feedback_attachments` — optional screenshots linked to `feedback`; files live in the `assets` storage bucket
- `deck_cards` — builder deck cards (separate from collection ownership)
- `user_settings` — single row per user, upserted via `SettingsContext`
- `price_snapshots` — historical price points for Stats page
- `game_sessions` — multiplayer life tracker sessions; `status`: `'waiting' | 'playing'`
- `game_players` — player slots per session; `user_id` is null until a player claims the slot
- `game_results` — deck win/loss history: `session_id, user_id, deck_id, deck_name, format, player_count, placement, played_at`
- `feedback` — user bug reports & feature requests: `type ('bug'|'feature'), description, contact, user_id, user_email, created_at`
- `card_hashes` — pHash records for scanner: `scryfall_id, name, set_code, collector_number, image_uri, hash_part_1..4 (bigint), phash_hex (text)`; read-only RLS for all users
- `user_settings` — includes `nickname`, `anonymize_email`, `reduce_motion`, `higher_contrast`, `card_name_size`, `default_grouping`, `keep_screen_awake`, `show_sync_errors`; synced via `useSettings()`

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

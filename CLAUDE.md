# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

- `src/lib/db.js` — All IndexedDB access. Use `getLocalCards(userId)`, `getLocalFolders(userId)`, `getAllLocalFolderCards(folderIds)` for reads. Never bypass IDB for performance-critical pages.
- `src/lib/supabase.js` — Exports the `sb` singleton. Used for auth + cloud sync fallback only.
- `src/lib/scryfall.js` — Scryfall data fetched in batches of 75, merged into IDB. `getInstantCache()` returns in-memory map (null if cold); always guard with `sfMap || {}`.

**Key gotcha:** Never use Supabase's nested `select('folder_cards(cards(*))')` — it requires FK relationships configured in PostgREST and silently returns empty. Always do flat queries and join in memory.

### IDB Schema (v2)

| Store | Key | Description |
|---|---|---|
| `scryfall` | `${set_code}-${collector_number}` | Card metadata + prices |
| `cards` | `id` | User's owned cards |
| `folders` | `id` | Binders, decks, wishlists, builder decks |
| `folder_cards` | `id` | Cards ↔ folders join |
| `deck_cards` | `id` | Deck builder cards (independent of collection) |
| `meta` | string key | Sync timestamps, cache versions |

### Pricing

- `getPrice(sfCard, foil, { price_source })` → numeric value
- `formatPrice(value, priceSourceId)` → `"€1.23"` or `"$1.23"`
- `getPriceWithMeta(sfCard, foil, opts)` → `{ value, symbol, isFallback, pct }`
- Manual overrides stored in `localStorage` as `arcanevault_manual_prices`
- Price source from `useSettings().price_source` — always pass it down; never hardcode.

### Settings

`useSettings()` returns all user preferences and a `save(patch)` function. Settings write to `localStorage` immediately and debounce a Supabase upsert (800 ms). Always use `useSettings()` for `price_source`, `grid_density`, `show_price`, `cache_ttl_h`.

### Filtering & Sorting

Heavy filtering runs in a **Web Worker** (`src/lib/filterWorker.js`) off the main thread. The worker receives a message `{ id, cards, sfMap, search, sort, filters, priceSource, cardFolderMap }` and posts back sorted results. `matchNumeric(valStr, op, minStr, maxStr)` handles `= | < | <= | > | >= | between | in`.

The same filter logic is duplicated in `CardComponents.jsx` for the non-worker path — keep both in sync when changing filter operators.

`EMPTY_FILTERS` is exported from `CardComponents.jsx` — always spread it as defaults.

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
| `src/lib/scanner.js` | Camera OCR pipeline (Tesseract + dHash) |
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
| `src/pages/LifeTracker.jsx` | Multiplayer life tracker — pre-game setup, game screen, lobby, JoinGame route |
| `src/pages/LifeTracker.module.css` | Styles for LifeTracker — grid layouts, rotations, fullscreen, lobby, landscape breakpoints |
| `src/pages/JoinGame.jsx` | Public route `/join/:code` — join a multiplayer lobby, pick deck/name/colour |
| `src/pages/JoinGame.module.css` | Styles for JoinGame page |
| `src/components/FeedbackModal.jsx` | Bug report / feature request modal — type toggle, description, optional Discord/email contact |
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
```

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
- **List view** — tabular rows with checkbox select, qty, name, set, foil badge, price, delete button
- **Grid view** — uses `WishlistGrid` (defined in `Lists.jsx`), card-image tiles with `aspect-ratio: 5/7`, qty badge top-right, foil badge (✦), hover-reveal delete button, and gold top-border
- View is toggled via the `.viewToggle` pill (imported from `Folders.module.css` via shared `styles`); default is `'list'`
- `WishlistGrid` uses `sf?.image_uris?.normal || sf?.image_uris?.small || sf?.card_faces?.[0]?.image_uris?.normal` for images

`ListsPage` wraps in `<div className={styles.page}>` for the dot-grid background.

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
- A floating `.fsControls` pill (`position: fixed; top: 8px; right: 8px; z-index: 910`) overlays exit, gear, and end-game buttons without consuming layout space

Use `100dvh` (dynamic viewport height) in fullscreen — not `100svh` — so Android Chrome's collapsing address bar is tracked correctly.

**Gear menu ref gotcha:** The topbar and `fsControls` each render a gear wrap. Use **two separate refs** (`gearMenuRef` for the topbar, `gearMenuFsRef` for fsControls) and check both in the `pointerdown` outside-click handler. If both share one ref, React nullifies it when `fsControls` unmounts, causing the menu to close instantly after exiting fullscreen.

#### Landscape phone breakpoints

- `@media (max-width: 900px)` — rotations and grid height applied (`calc(100svh - 192px)`)
- `@media (max-height: 500px)` — landscape phone (e.g. Pixel 7, S24 at 412px height); hides `.colorRow` and `.quickRow`, shrinks all panel elements so content fits within ~106px per row; does **not** override fullscreen grid height (already `100dvh`)

#### Seat Selection (`SeatLayoutGrid`)

Tap-to-swap component used in both `PreGameSetup` (local) and `LobbyScreen` (shared). Mirrors the actual game grid — same `position: absolute; inset: 0; transform: rotate()` within `overflow: hidden` cells. Selected seat highlighted with gold border; tapping two seats swaps them. In local lobby uses `swapConfigs(i,j)`; in lobby uses `seatOrder` array applied at game start.

#### Host Setup Screen (`HostSetupScreen`)

After creating a shared lobby, host is taken to `HostSetupScreen` (screen `'host-setup'`) before the lobby is visible. Same name/color/deck/art form as JoinGame — writes to Supabase `game_players` slot 0 with `claimed_at`. On submit → `setScreen('lobby')`.

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

-- Nickname column on user_settings
alter table user_settings add column if not exists nickname text default '';
```

### Select Mode & Visual Split (DeckBrowser)

Cards in a binder/deck can be selected for bulk move/delete. Multi-copy cards (e.g. ×4 Forest) split visually on first click:

- `splitState: Map<cardId, selectedQty>` tracks how many copies of each card are "virtually selected"
- First click on an unselected multi-copy card → selects 1, shows remainder as a dimmed row/card
- Clicking the dimmed remainder → increments selected qty
- No DB write until bulk action (`handleBulkDelete` / `handleMoveToFolder`) — those use `splitState` to determine actual qty to move/delete
- This split logic is implemented in: `DeckListGroup` (list view), `StacksView` (stacks view), `DeckCardGrid` (grid view)
- `BulkActionBar` receives `selectedQty` (sum of copies, not row count) to show accurate copy count

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

### Card Scanner

`src/lib/scanner.js` pipeline:
1. `getCardRect(videoEl)` — accounts for `object-fit: cover` cropping (portrait phone ≠ full stream dimensions). Uses `videoEl.clientWidth/clientHeight`, not `videoWidth/videoHeight`.
2. `preprocessNameStrip()` — Otsu adaptive thresholding → binarise → invert if dark background.
3. Tesseract OCR (single-line PSM) → stability buffer (2 consecutive matches required).
4. dHash of art region → compare against all printings → filter by hash distance ≤ 8.

### Supabase Table Notes

- `cards` — user's owned cards, RLS by `user_id`
- `folders` — type is `'binder' | 'deck' | 'list' | 'builder_deck'`
- `folder_cards` — links `folder_id` + `card_id` + `qty`
- `list_items` — wishlist items: `folder_id, name, set_code, collector_number, scryfall_id, foil, qty`
- `deck_cards` — builder deck cards (separate from collection ownership)
- `user_settings` — single row per user, upserted via `SettingsContext`
- `price_snapshots` — historical price points for Stats page
- `game_sessions` — multiplayer life tracker sessions; `status`: `'waiting' | 'playing'`
- `game_players` — player slots per session; `user_id` is null until a player claims the slot
- `game_results` — deck win/loss history: `session_id, user_id, deck_id, deck_name, format, player_count, placement, played_at`
- `feedback` — user bug reports & feature requests: `type ('bug'|'feature'), description, contact, user_id, user_email, created_at`
- `user_settings` — includes `nickname text default ''` (added); synced via `useSettings()`

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

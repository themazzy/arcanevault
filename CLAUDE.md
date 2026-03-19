# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project Overview

**ArcaneVault** is a personal Magic: The Gathering collection tracker. Users catalog owned cards, organise them into binders/decks/wishlists, track prices and P&L, build decks, scan cards with camera OCR, and view collection analytics. The stack is **React 18 + Vite + Supabase + IndexedDB**.

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

React Router v6. Public routes: `/login`, `/share/:token`. All other routes require auth and are wrapped in `PrivateApp` inside `App.jsx`. Auth state comes from `useAuth()` (from `src/components/Auth.jsx`).

### Vite Proxies (dev only)

```
/api/edhrec    → json.edhrec.com
/api/archidekt → archidekt.com
/api/moxfield  → api.moxfield.com
/api/goldfish  → mtggoldfish.com
```

These are only active during `npm run dev`. Production deploys need a separate reverse proxy or serverless functions for CORS-restricted APIs.

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
| `src/components/CardComponents.jsx` | `FilterBar`, `CardDetail`, `CardGrid`, `EMPTY_FILTERS`, `applyFilterSort` |
| `src/components/VirtualCardGrid.jsx` | Virtualised card grid (@tanstack/react-virtual) |
| `src/components/AddCardModal.jsx` | Add card modal: scan (OCR) or manual search |
| `src/components/SettingsContext.jsx` | `SettingsProvider` + `useSettings()` |
| `src/components/Auth.jsx` | `AuthProvider` + `useAuth()` + `LoginPage` |
| `src/pages/Collection.jsx` | Main collection browser (IDB-first, worker filter) |
| `src/pages/Home.jsx` | Dashboard — collection snapshot, news, card lookup |

---

## Patterns & Conventions

### CSS Modules

Every page and major component has a paired `.module.css`. Use CSS variables for theming:

```css
var(--gold)        /* #c9a84c — primary accent */
var(--bg)          /* page background */
var(--bg2)         /* card/panel background */
var(--bg3)         /* nested elements */
var(--border)      /* subtle border */
var(--border-hi)   /* highlighted border */
var(--text)        /* primary text */
var(--text-dim)    /* secondary text */
var(--text-faint)  /* placeholder / disabled text */
```

### Component Conventions

- Pages load their own data (IDB-first, Supabase fallback).
- Skeleton loaders use CSS shimmer animation (`@keyframes shimmer`).
- Horizontal scroll strips use `.hScroll` with `overflow-x: auto` + thin scrollbars.
- All monetary displays go through `formatPrice()` — never format manually.
- `addRecentlyViewed(card)` in `Home.jsx` persists to localStorage and fires `window.dispatchEvent(new CustomEvent('av:viewed'))` for live updates.

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
- `deck_cards` — builder deck cards (separate from collection ownership)
- `user_settings` — single row per user, upserted via `SettingsContext`
- `price_snapshots` — historical price points for Stats page

---

## External APIs

| Service | Usage | Notes |
|---|---|---|
| Scryfall | Card data, search, autocomplete, catalog | Rate-limited: 75 cards/batch, 120 ms delay |
| Supabase | Auth, cloud sync | RLS enforced; never bypass with service key |
| frankfurter.app | EUR↔USD rates | Cached 6 h in IDB |
| EDHRec | Commander recommendations | Via Vite proxy `/api/edhrec` |
| codetabs.com proxy | MTG RSS feeds | `api.codetabs.com/v1/proxy?quest=<url>` returns raw XML |

### RSS Feed Parsing

MTGGoldfish uses **Atom** format (`<feed>/<entry>`, link via `getAttribute('href')`). EDHREC and MTGArenaZone use **RSS 2.0** (`<rss>/<item>`, link via `textContent`). Always detect with `doc.querySelector('feed')` before parsing.

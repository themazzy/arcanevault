# DeckBuilder Code Review — Fix Plan

Reviewed: 2026-04-25  
Files: `src/pages/DeckBuilder.jsx` (~5300 lines), `src/pages/DeckBuilder.module.css` (~3250 lines)  
All fixes are self-contained. No new dependencies required. Do not change behaviour.

---

## P0-001 — Timer refs never cleared on unmount (memory leak)

**File:** `src/pages/DeckBuilder.jsx`

Three `setTimeout` handles are stored in refs but never cancelled when the component unmounts:
- `saveMetaTimer` (used in `saveMeta`)
- `addFeedbackTimer` (used in `addCardToDeck` / flash feedback)
- `qtyTimers` (a `Map` of per-card debounce handles in `changeQty`)

**Fix:** Add a single cleanup effect near the other top-level effects (after the existing Supabase subscription effects):

```js
useEffect(() => {
  return () => {
    clearTimeout(saveMetaTimer.current)
    clearTimeout(addFeedbackTimer.current)
    for (const t of qtyTimers.current.values()) clearTimeout(t)
  }
}, [])
```

---

## P0-002 — MakeDeckModal / SyncModal stale-closure effect deps

**File:** `src/pages/DeckBuilder.jsx`

Both `MakeDeckModal` (around line 905) and `SyncModal` (around line 1083) contain:

```js
useEffect(() => { load() }, [])
```

…where `load` closes over props/state (`deckCards`, `deckMeta`, `userId`, `deckId`, etc.) that could change. Because the modals are freshly mounted each time they open, the practical risk is narrow, but the omission is silent and confusing to future maintainers.

**Fix:** Add an explicit comment so the intent is clear rather than accidental:

```js
// Intentional: modal mounts fresh on each open — one-shot load from current props snapshot.
// eslint-disable-next-line react-hooks/exhaustive-deps
useEffect(() => { load() }, [])
```

Do this in both modals.

---

## P0-003 — `_comboImgCache` module-level object grows unbounded

**File:** `src/pages/DeckBuilder.jsx`

Around line 498:
```js
const _comboImgCache = {}
```

This object persists for the entire browser session across all decks, is never pruned, and survives HMR in dev (causing stale null entries on re-mount).

**Fix:** Move the cache inside the `useComboCardImage` hook as a `useRef`, so it is scoped to the component lifetime:

```js
function useComboCardImage(card) {
  const cache = useRef({})
  // replace all _comboImgCache references with cache.current
  ...
}
```

---

## P1-001 — Dead component: `DeckCardRow` (original)

**File:** `src/pages/DeckBuilder.jsx`

The original `DeckCardRow` function (around line 424, ~31 lines) is defined but never called anywhere. The list view exclusively uses `DeckCardRowV2`. This is leftover from a refactor.

**Fix:** Delete the entire `DeckCardRow` function definition.

---

## P1-002 — Dead helper: `getResolutionSummary`

**File:** `src/pages/DeckBuilder.jsx`

Around line 723, `getResolutionSummary` (~22 lines) is defined but has no call sites. `getDecisionPreview` (around line 752) is the live equivalent and is called at line ~1311.

**Fix:** Delete the entire `getResolutionSummary` function.

---

## P1-003 — `ownedCount` and `partnerCard` computed but never read

**File:** `src/pages/DeckBuilder.jsx`

```js
const partnerCard = commanderCards[1] ?? null           // never referenced below
const ownedCount  = useMemo(() => deckCards.filter(... // result never used
```

`ownedCount` re-runs on every `deckCards`, `ownedMap`, or `ownedNameMap` change — i.e. on every card add/remove/qty edit — for zero benefit.

**Fix:** Delete both declarations entirely.

---

## P1-004 — Dead imports: `nameToSlug` and `pruneUnplacedCards`

**File:** `src/pages/DeckBuilder.jsx`

Two symbols are imported but never called anywhere in the file:

- `nameToSlug` — destructured from `'../lib/deckBuilderApi'` (line ~9)
- `pruneUnplacedCards` — imported from `'../lib/collectionOwnership'` (line ~25)

**Fix:** Remove `nameToSlug` from its destructured import line and remove the entire `pruneUnplacedCards` import line.

---

## P1-005 — `deckRowProps(dc)` factory recreated inside render path

**File:** `src/pages/DeckBuilder.jsx`

Around line 4665, an inline function `deckRowProps(dc)` is defined inside the render IIFE and called once per card row via `{...deckRowProps(dc)}`. It is redefined on every parent render. Inside it calls `allocationSetHas(inOtherDeckSet, dc)` and `allocationSetHas(collDeckSfSet, dc)`, each of which iterates `deckAllocationKeys(dc)` — 200 set lookups per render on a 100-card deck.

The same ownership props are also manually inlined in the grid, stacks, and compact view branches (lines ~4699–4834), causing drift.

**Fix:** Extract a stable `useCallback`-wrapped helper outside the render path:

```js
const getCardOwnershipProps = useCallback((dc) => ({
  ownedQty:     ownedFoilMap.get(`${dc.scryfall_id}|${dc.foil ? '1' : '0'}`) ?? 0,
  ownedFoilAlt: ownedFoilMap.get(`${dc.scryfall_id}|${dc.foil ? '0' : '1'}`) ?? 0,
  ownedAlt:     ownedNameMap.get((dc.name || '').toLowerCase()) ?? 0,
  ownedInDeck:  allocationSetHas(inOtherDeckSet, dc),
  inCollDeck:   allocationSetHas(collDeckSfSet, dc),
}), [ownedFoilMap, ownedNameMap, inOtherDeckSet, collDeckSfSet])
```

Replace all five inline ownership-props sites with `{...getCardOwnershipProps(dc)}`.

---

## P1-006 — Sync status effect debounce too short, fires on every card mutation

**File:** `src/pages/DeckBuilder.jsx`

The `useEffect` computing `syncStatus` has `[deckCards, deckMeta, deckId, isCollectionDeck, user?.id]` as deps. Every card add/remove/qty change triggers the effect. The debounce (find `setTimeout` inside the sync status effect) is currently **300 ms**, meaning rapid qty clicks queue multiple back-to-back Supabase `fetchDeckAllocations` calls.

**Fix:** Increase the debounce inside the sync status effect from 300 ms to **1200 ms**. The sync badge is not user-visible until the modal opens, so there is no perceptible latency difference.

---

## P1-007 — Inline arrow functions on search result rows cause re-renders on every `mousemove`

**File:** `src/pages/DeckBuilder.jsx`

In the search results `map` (around line 4290), `onHoverEnter`, `onHoverMove`, and `onHoverLeave` are created as new arrow functions per render. `onHoverMove` calls `setHoverPos` on every mouse pixel, causing a state update → parent re-render → all visible search rows get new function refs → all rows re-render.

**Fix (two parts):**

1. Wrap `SearchResultRow` (or the inner row component) with `React.memo` so it bails out when props are reference-equal.

2. Stabilize the hover handlers with `useCallback`:

```js
const handleSearchRowHoverMove = useCallback(e => {
  setHoverPos({ x: e.clientX, y: e.clientY })
}, [])
```

Pass this stable reference to every row instead of an inline arrow.

---

## P2-001 — Hardcoded `rgba(255,255,255,...)` on interactive elements in CSS (light theme breakage)

**File:** `src/pages/DeckBuilder.module.css`

The project's CLAUDE.md rule: *"Never use hardcoded `rgba(255,255,255,0.X)` for borders or backgrounds on interactive elements — they are invisible on light themes."*

Audit and replace the following interactive-element violations with surface overlay vars:

| Approx line | Selector / context | Current value | Replace with |
|---|---|---|---
| ~162 | `.toolbarGroup` border | `rgba(255,255,255,0.07)` | `var(--s-border)` |
| ~967 | `.cmdArtPane` border | `rgba(255,255,255,0.12)` | `var(--s-border2)` |
| ~1098 | `.colorPip` border | `rgba(255,255,255,0.3)` | `var(--s-border2)` |
| ~1593 | `.qtyBtn:hover` background | `rgba(255,255,255,0.08)` | `var(--s-medium)` |
| ~1633 | `.removeBtn:hover` background | `rgba(255,255,255,0.08)` | `var(--s-medium)` |
| ~2904 | `.stackControlBtn` border | `rgba(255,255,255,0.15)` | `var(--s-border2)` |
| ~2952 | `.stackCardControls::before` border | `rgba(255,255,255,0.08)` (if present) | `var(--s-border)` |

Decorative uses (blurred art backgrounds, dark-panel overlays, box-shadow alpha) are acceptable to leave as-is — only borders and backgrounds on tappable/hoverable elements need changing.

---

## P2-002 — Delete commented-out JSX block (~50 lines)

**File:** `src/pages/DeckBuilder.jsx`

Around lines 345–394 there is a large block commented with `/* return ( <ResponsiveMenu ...` — the previous implementation of `EditMenu`. It is dead code that obscures the current `DeckCardActionsMenuBody` / `EditMenu` pattern.

**Fix:** Delete the entire comment block.

---

## P2-003 — O(n²) in `applyCollectionSelectionsToBuilder`

**File:** `src/pages/DeckBuilder.jsx`

Around line 3851:

```js
for (let i = nextDeckCards.length - 1; i >= 0; i -= 1) {
  if (deletes.includes(nextDeckCards[i].id)) { ... }  // O(n) inside O(n) loop
```

**Fix:** Convert `deletes` to a `Set` before the loop:

```js
const deletesSet = new Set(deletes)
for (let i = nextDeckCards.length - 1; i >= 0; i -= 1) {
  if (deletesSet.has(nextDeckCards[i].id)) { ... }
}
```

---

## Execution order

Apply in this sequence to keep each commit clean and independently reviewable:

1. **P1-001, P1-002, P1-003, P1-004, P2-002** — pure deletions, zero risk
2. **P0-001** — add unmount cleanup effect
3. **P0-002** — add eslint-disable comments in both modals
4. **P2-003** — swap `includes` for `Set.has`
5. **P0-003** — move `_comboImgCache` into `useRef`
6. **P1-005** — extract `getCardOwnershipProps` useCallback
7. **P1-006** — increase sync debounce to 1200 ms
8. **P1-007** — `React.memo` on `SearchResultRow` + stable `useCallback` for hover handlers
9. **P2-001** — CSS `rgba` → surface vars sweep

# React Query Migration Plan - Collection Page

**Goal:** instant re-navigation through in-memory cache, fast first load through IDB hydration, offline read support through IDB snapshots, and background Supabase sync.

---

## Decisions

- **Delta sync:** Remove only after full placement queries are working. Replace with paginated full placement fetches using `staleTime: FOLDER_CARDS_FULL_SYNC_MS`, `refetchOnWindowFocus: true`, and `refetchOnReconnect: true`.
- **Query keys:** Hydration and reads must use the same keys: `['cards', userId]`, `['folders', userId]`, `['folderPlacements', userId]`, and `['sfMap', userId]`.
- **Offline fetchers:** Throw a network-like/offline error instead of returning `undefined`, so stale IDB-hydrated cache is not overwritten by empty query results.
- **sfMap key:** Use `['sfMap', userId]`. Invalidate from mutations; do not include a hash in the key.
- **After import:** Invalidate `['cards', userId]`, `['folders', userId]`, `['folderPlacements', userId]`, and `['sfMap', userId]`.
- **`canSeedFilteredRef`:** Remove after cards are query-driven. IDB hydration makes it unnecessary.

---

## Step 1 - Install + QueryClient

```bash
npm install @tanstack/react-query
```

Create `src/lib/queryClient.js`:

```js
import { QueryClient } from '@tanstack/react-query'
import { isNetworkLikeError } from './networkUtils'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      networkMode: 'offlineFirst',
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: (count, error) => count < 2 && !isNetworkLikeError(error),
    },
  },
})
```

Wrap `PrivateApp` with `QueryClientProvider` inside `AuthProvider` in `src/App.jsx`.

---

## Step 2 - Network Utility

Create `src/lib/networkUtils.js` and move `isNetworkLikeError` there. Import it back into `Collection.jsx` and into fetcher/query-client files.

---

## Step 3 - IDB Hydration Bridge

Create `src/lib/idbQueryBridge.js`:

```js
import {
  getLocalCards,
  getLocalFolders,
  getAllLocalFolderCards,
  getAllDeckAllocationsForUser,
} from './db'

export async function hydrateCollectionQueriesFromIdb(queryClient, userId) {
  const [localCards, localFolders] = await Promise.all([
    getLocalCards(userId),
    getLocalFolders(userId),
  ])

  if (localCards.length) {
    queryClient.setQueryData(['cards', userId], localCards, { updatedAt: 0 })
  }

  if (localFolders.length) {
    queryClient.setQueryData(['folders', userId], localFolders, { updatedAt: 0 })

    const placementFolders = localFolders.filter(folder => !isGroupFolder(folder))
    const binderIds = placementFolders.filter(f => f.type !== 'deck' && f.type !== 'builder_deck').map(f => f.id)
    const [folderCards, deckAllocations] = await Promise.all([
      getAllLocalFolderCards(binderIds),
      getAllDeckAllocationsForUser(userId),
    ])

    queryClient.setQueryData(
      ['folderPlacements', userId],
      { folderCards, deckAllocations },
      { updatedAt: 0 }
    )
  }
}
```

Use a shared `isGroupFolder()` helper or duplicate the tiny safe JSON check in the bridge.

Call this once from `Collection.jsx` before the queries are enabled:

```js
const hydrated = useRef(false)
useEffect(() => {
  if (!user?.id || hydrated.current) return
  hydrated.current = true
  hydrateCollectionQueriesFromIdb(queryClient, user.id)
}, [user?.id])
```

`updatedAt: 0` makes the query immediately stale, so UI renders cached data first and React Query refetches in the background.

---

## Step 4 - Supabase Fetchers

Create `src/lib/collectionFetchers.js`. Fetchers must be async, throw on errors, and avoid React state writes.

### `fetchCollectionCards(userId)`

Extract the paginated `cards` loop from `loadCards()`. Preserve stable ordering by `name` then `id`.

Behavior:
- If offline, throw an offline/network-like error.
- Return `[]` for a successful empty collection.
- Throw for Supabase errors.

### `fetchFolders(userId)`

Fetch `id,name,type,description,updated_at` from `folders`, ordered by `name`. Return only non-group placement folders to match the current Collection behavior, but write all fetched folders to IDB if group metadata still matters elsewhere.

### `fetchFolderPlacements({ queryKey })`

Use key `['folderPlacements', userId]`, not folder-id arrays. This keeps hydration and reads aligned.

Implementation requirements:
- Fetch folders or accept already-fetched folders through a helper used by both folder and placement queries.
- Preserve paginated fetches for `folder_cards` and `deck_allocations`.
- Do not use one unpaginated `.select('*').in(...)`.
- Check every Supabase response for `error`.
- Return `{ folderCards, deckAllocations }`.

### `fetchSfMap(cards, cacheTtlMs, onProgress)`

Wrap `loadCardMapWithSharedPrices(cards, { onProgress, cacheTtlMs })`. The progress callback may update local cosmetic progress state.

---

## Step 5 - Cards Query First

Add:

```js
const cardsQuery = useQuery({
  queryKey: ['cards', user.id],
  queryFn: () => fetchCollectionCards(user.id),
  staleTime: LOCAL_COLLECTION_FRESH_MS,
  enabled: !!user?.id,
})

const cards = cardsQuery.data || []
const loading = cardsQuery.isFetching
```

Remove `cards`/`setCards`, `loading`/`setLoading`, `cardsLoadSeq`, `canSeedFilteredRef`, the `loadCards()` callback, and the effect that calls it.

Add write-back/prune effects:
- When a successful cards query returns rows, `putCards(cards)` and set `cards_synced_<userId>`.
- When it returns `[]`, clear local cards and set the sync meta.
- Compare successful Supabase rows with IDB rows and delete stale IDB rows.

Smoke test here before moving placements.

---

## Step 6 - Folders + Placements Queries

Add:

```js
const foldersQuery = useQuery({
  queryKey: ['folders', user.id],
  queryFn: () => fetchFolders(user.id),
  staleTime: LOCAL_COLLECTION_FRESH_MS,
  enabled: !!user?.id,
})

const placementsQuery = useQuery({
  queryKey: ['folderPlacements', user.id],
  queryFn: fetchFolderPlacements,
  staleTime: FOLDER_CARDS_FULL_SYNC_MS,
  enabled: !!user?.id,
})
```

Then derive:

```js
const folders = foldersQuery.data || []
const placements = placementsQuery.data || { folderCards: [], deckAllocations: [] }
const folderMembershipLoading = placementsQuery.isFetching
const folderMembershipSynced = placementsQuery.isSuccess
const cardFolderMap = useMemo(
  () => buildCardFolderMap(folders, [...placements.folderCards, ...placements.deckAllocations]),
  [folders, placements]
)
```

Remove `setFolders`, `setCardFolderMap`, `setFolderMembershipLoading`, `setFolderMembershipSynced`, `folderMembershipReloadKey`, delta sync metadata logic, and the 10-minute full-sync timer logic only after all placement mutations invalidate/update the placement query.

IDB write-back:
- `putFolders(foldersData)` after successful folders query.
- `replaceLocalFolderCards(binderIds, folderCards)` and `replaceDeckAllocations(deckIds, deckAllocations)` after successful placements query.
- Clear removed folders from IDB when remote folders no longer contain them.

---

## Step 7 - sfMap Query + Worker Payload

Add:

```js
const sfMapQuery = useQuery({
  queryKey: ['sfMap', user.id],
  queryFn: () => fetchSfMap(cards, ttlMsRef.current, (pct, lbl) => {
    setProgress(pct)
    setProgLabel(lbl)
  }),
  staleTime: ttlMsRef.current,
  enabled: cards.length > 0,
  placeholderData: () => getInstantCache(ttlMsRef.current) || {},
})

const sfMap = sfMapQuery.data || {}
const enriching = sfMapQuery.isFetching
```

Remove `sfMap`/`setSfMap`, `enriching`/`setEnriching`, `enrichingRef`, `startEnrichment`, and the `getInstantCache` prefill effect.

Pass a trimmed map to the worker:

```js
const sfMapForWorker = useMemo(() => {
  if (!cards.length || !sfMap) return {}
  const result = {}
  for (const card of cards) {
    const key = `${card.set_code}-${card.collector_number}`
    if (sfMap[key]) result[key] = sfMap[key]
  }
  return result
}, [cards, sfMap])
```

Use `sfMapForWorker` in `worker.postMessage`.

---

## Step 8 - Mutations and Invalidation

For every mutation, keep the existing Supabase logic first, then update or invalidate affected queries.

Minimum invalidation rules:
- Card changes: invalidate `['cards', userId]` and `['sfMap', userId]`.
- Placement changes: invalidate `['folderPlacements', userId]`.
- Folder creation/deletion/rename: invalidate `['folders', userId]` and `['folderPlacements', userId]`.
- Import: invalidate all four Collection queries.

Apply to:
- `handleCardSave`
- `handleBulkDelete`
- `handleMoveToFolder`
- `handleDelete`
- Add-card `onSaved`
- Import `onSaved`
- Orphan modal `onAssigned` and `onDeleted`
- Bulk create folder from `BulkActionBar`

After `cardFolderMap` is derived, remove direct `setCardFolderMap` calls. After `cards` is query data, replace direct `setCards` calls with `queryClient.setQueryData` or invalidation.

---

## Step 9 - Orphan Detection

Replace manual sync flags with query state:

```js
const bothSynced =
  cardsQuery.isSuccess &&
  placementsQuery.isSuccess &&
  !cardsQuery.isFetching &&
  !placementsQuery.isFetching
```

Run orphan detection only when `bothSynced`, online, cards exist, and `orphanCheckDone.current` is false.

---

## Step 10 - ConnectionStatusBadge

Map props from query state:
- `loading`: `cardsQuery.isFetching`
- `folderMembershipLoading`: `placementsQuery.isFetching`
- `enriching`: `sfMapQuery.isFetching`

No internal badge changes needed.

---

## Step 11 - Cleanup

Remove old state/effects only after their query replacements are active:

- `cards` / `setCards`
- `loading` / `setLoading`
- `folders` / `setFolders`
- `cardFolderMap` / `setCardFolderMap`
- `folderMembershipLoading` / `setFolderMembershipLoading`
- `folderMembershipSynced` / `setFolderMembershipSynced`
- `folderMembershipReloadKey` / `setFolderMembershipReloadKey`
- `sfMap` / `setSfMap`
- `enriching` / `setEnriching`
- `canSeedFilteredRef`
- `cardsLoadSeq`
- `loadCards()` trigger effect
- `loadFolderMembership()` effect and delta sync branches
- `startEnrichment` callback and `enrichingRef`
- `getInstantCache` prefill effect

---

## What Does Not Change

| What | Why |
|---|---|
| `filterWorker.js` | Worker logic can stay unchanged |
| `db.js` | Existing helpers are reused |
| `scryfall.js` | Called through fetcher wrapper |
| `sharedCardPrices.js` | Called through fetcher wrapper |
| Worker module-scope construction | Keep existing worker lifecycle |
| `ConnectionStatusBadge` internals | Only props change |
| `OrphanModal` internals | Callbacks handle query invalidation |

---

## New Files

| File | Purpose |
|---|---|
| `src/lib/queryClient.js` | QueryClient singleton |
| `src/lib/networkUtils.js` | Network/offline error helper |
| `src/lib/idbQueryBridge.js` | Hydrate query cache from IDB |
| `src/lib/collectionFetchers.js` | Supabase fetchers for Collection |

---

## Safe Implementation Order

1. Install React Query, provider, query client, and network utility.
2. Add IDB hydration bridge and fetchers without wiring them.
3. Migrate cards query and smoke test.
4. Migrate folders and placements together, preserving pagination.
5. Migrate sfMap query and worker payload.
6. Convert mutation callbacks and invalidations one at a time.
7. Remove old state/effects.
8. Run `npm run build`.

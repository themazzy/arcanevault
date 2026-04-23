# Linked Deck Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate builder decks from collection decks, add baseline-aware unsynced detection, and replace automatic sync side effects with an explicit review-and-apply sync flow.

**Architecture:** Introduce a dedicated `deckSync` helper that owns linked-deck metadata, baseline snapshots, diff generation, and apply semantics. Convert `Make Collection Deck` from an in-place type flip to a paired-record creation flow, then update Builder, DeckBuilder, DeckBrowser, and folder deletion flows to use the linked-pair model and unsynced indicators.

**Tech Stack:** React 18, Vite, Supabase, existing folder metadata JSON in `folders.description`, existing `deck_cards` and `deck_allocations` tables, local IndexedDB cache helpers.

---

## File Structure

**Create**

- `src/lib/deckSync.js`
  - linked-deck metadata helpers
  - snapshot read/write helpers
  - state normalization
  - discrepancy generation
  - apply helpers for builder-to-collection and collection-to-builder
- `docs/superpowers/specs/2026-04-23-linked-deck-sync-design.md`
  - approved design reference
- `docs/superpowers/plans/2026-04-23-linked-deck-sync.md`
  - this implementation plan

**Modify**

- `src/pages/DeckBuilder.jsx`
  - stop in-place collection conversion
  - read linked pair + unsynced status via `deckSync`
  - replace current sync diff/count logic
  - replace sync modal behavior with discrepancy review/apply
- `src/pages/Builder.jsx`
  - show unsynced indicators on linked tiles
  - keep builder-vs-collection delete semantics correct
- `src/pages/DeckBrowser.jsx`
  - show unsynced indicators and `Review Sync` entry for collection decks
  - route `Edit in Builder` through the linked builder deck
- `src/pages/Folders.jsx`
  - unlink on linked deck deletion instead of semantic cross-delete
  - update delete confirmations
- `src/pages/DeckView.jsx`
  - ensure deck-view actions prefer linked builder deck where appropriate
- `src/lib/deckBuilderApi.js`
  - metadata shape comments/helpers only if needed for consistent JSON handling
- `src/lib/db.js`
  - only if local cache helpers need small additions for linked-folder metadata refresh

**Verification**

- `npm run build`
- Manual linked-deck scenarios described in the design spec

---

### Task 1: Add linked-deck sync primitives

**Files:**
- Create: `src/lib/deckSync.js`
- Modify: `src/lib/deckBuilderApi.js` (only if helper reuse is needed)
- Test: manual verification in Builder and DeckBuilder

- [ ] **Step 1: Create linked metadata and snapshot helper module**

Add `src/lib/deckSync.js` with:

```js
import { parseDeckMeta, serializeDeckMeta } from './deckBuilderApi'

export function getLinkedDeckIds(folder) {
  const meta = parseDeckMeta(folder?.description)
  return {
    linkedDeckId: meta.linked_deck_id || null,
    linkedBuilderId: meta.linked_builder_id || null,
  }
}

export function getSyncState(metaLike) {
  const meta = metaLike?.sync_state ? metaLike : parseDeckMeta(metaLike?.description)
  return meta.sync_state || {
    version: 1,
    last_sync_at: null,
    last_sync_snapshot: null,
    unsynced_builder: false,
    unsynced_collection: false,
  }
}

export function writeSyncState(meta, syncState) {
  return {
    ...meta,
    sync_state: {
      version: 1,
      last_sync_at: syncState?.last_sync_at || null,
      last_sync_snapshot: syncState?.last_sync_snapshot || null,
      unsynced_builder: !!syncState?.unsynced_builder,
      unsynced_collection: !!syncState?.unsynced_collection,
    },
  }
}

export function withLinkedPair(meta, links) {
  return {
    ...meta,
    linked_deck_id: links?.linkedDeckId || null,
    linked_builder_id: links?.linkedBuilderId || null,
  }
}

export function clearLinkedPair(meta, side) {
  const next = { ...meta }
  if (side === 'builder') delete next.linked_builder_id
  if (side === 'collection') delete next.linked_deck_id
  delete next.sync_state
  return next
}
```

- [ ] **Step 2: Add normalization helpers**

In `src/lib/deckSync.js`, add:

```js
function normalizeName(name) {
  return String(name || '').trim().toLowerCase()
}

export function getLogicalKey(row) {
  const foil = row?.foil ? '1' : '0'
  const board = row?.board || 'main'
  if (row?.scryfall_id) return `sf:${row.scryfall_id}|${foil}|${board}`
  return `name:${normalizeName(row?.name)}|${foil}|${board}`
}

export function normalizeBuilderCards(rows) {
  const map = new Map()
  for (const row of rows || []) {
    const key = getLogicalKey(row)
    const current = map.get(key) || {
      key,
      source: 'builder',
      name: row.name,
      scryfall_id: row.scryfall_id || null,
      set_code: row.set_code || null,
      collector_number: row.collector_number || null,
      foil: !!row.foil,
      board: row.board || 'main',
      qty: 0,
    }
    current.qty += row.qty || 0
    map.set(key, current)
  }
  return [...map.values()]
}

export function normalizeCollectionAllocations(rows) {
  const map = new Map()
  for (const row of rows || []) {
    const key = getLogicalKey({ ...row, board: row.board || 'main' })
    const current = map.get(key) || {
      key,
      source: 'collection',
      name: row.name,
      scryfall_id: row.scryfall_id || null,
      set_code: row.set_code || null,
      collector_number: row.collector_number || null,
      foil: !!row.foil,
      board: row.board || 'main',
      qty: 0,
      allocations: [],
    }
    current.qty += row.qty || 0
    current.allocations.push(row)
    map.set(key, current)
  }
  return [...map.values()]
}
```

- [ ] **Step 3: Add baseline comparison helpers**

In `src/lib/deckSync.js`, add:

```js
function toMap(rows) {
  return new Map((rows || []).map(row => [row.key, row]))
}

export function buildSyncSnapshot({ builderCards, collectionCards }) {
  return {
    builder_cards: normalizeBuilderCards(builderCards),
    collection_cards: normalizeCollectionAllocations(collectionCards).map(({ allocations, ...rest }) => rest),
  }
}

export function buildSyncDiff({ baseline, builderCards, collectionCards }) {
  const baseBuilder = toMap(baseline?.builder_cards || [])
  const baseCollection = toMap(baseline?.collection_cards || [])
  const currentBuilder = toMap(normalizeBuilderCards(builderCards))
  const currentCollection = toMap(normalizeCollectionAllocations(collectionCards))

  const allKeys = new Set([
    ...baseBuilder.keys(),
    ...baseCollection.keys(),
    ...currentBuilder.keys(),
    ...currentCollection.keys(),
  ])

  const builderOnly = []
  const collectionOnly = []
  const conflicts = []

  for (const key of allKeys) {
    const baseB = baseBuilder.get(key)?.qty || 0
    const baseC = baseCollection.get(key)?.qty || 0
    const currB = currentBuilder.get(key)?.qty || 0
    const currC = currentCollection.get(key)?.qty || 0

    const builderChanged = currB !== baseB
    const collectionChanged = currC !== baseC
    if (!builderChanged && !collectionChanged) continue
    if (builderChanged && !collectionChanged) {
      builderOnly.push({ key, baselineQty: baseB, builderQty: currB, collectionQty: currC, builder: currentBuilder.get(key) || null, collection: currentCollection.get(key) || null })
      continue
    }
    if (!builderChanged && collectionChanged) {
      collectionOnly.push({ key, baselineQty: baseC, builderQty: currB, collectionQty: currC, builder: currentBuilder.get(key) || null, collection: currentCollection.get(key) || null })
      continue
    }
    if (currB === currC) continue
    conflicts.push({ key, baselineBuilderQty: baseB, baselineCollectionQty: baseC, builderQty: currB, collectionQty: currC, builder: currentBuilder.get(key) || null, collection: currentCollection.get(key) || null })
  }

  return { builderOnly, collectionOnly, conflicts }
}
```

- [ ] **Step 4: Verify import/build integrity**

Run: `npm run build`

Expected: PASS, with no unresolved import or syntax errors from `deckSync.js`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/deckSync.js src/lib/deckBuilderApi.js
git commit -m "feat(sync): add linked deck sync primitives"
```

---

### Task 2: Convert Make Collection Deck into linked-pair creation

**Files:**
- Modify: `src/pages/DeckBuilder.jsx:3273-3346`
- Modify: `src/pages/Builder.jsx:40-90, 227-290`
- Test: manual collection-deck creation flow

- [ ] **Step 1: Replace in-place type conversion in `handleMakeDeck()`**

In `src/pages/DeckBuilder.jsx`, remove:

```js
const { error: typeErr } = await sb.from('folders').update({ type: 'deck' }).eq('id', deckId)
if (typeErr) throw typeErr
```

Replace with:

```js
const builderMeta = parseDeckMeta(deck.description)
const { data: newCollectionDeck, error: createDeckErr } = await sb
  .from('folders')
  .insert({
    user_id: user.id,
    type: 'deck',
    name: deck.name,
    description: serializeDeckMeta({ format: builderMeta.format || 'commander' }),
  })
  .select()
  .single()
if (createDeckErr || !newCollectionDeck) throw createDeckErr || new Error('Failed to create linked collection deck.')
```

- [ ] **Step 2: Link both records**

Immediately after creating the collection deck, update both folder records:

```js
const nextBuilderMeta = withLinkedPair(builderMeta, { linkedDeckId: newCollectionDeck.id })
const nextCollectionMeta = withLinkedPair(parseDeckMeta(newCollectionDeck.description), { linkedBuilderId: deckId })

await Promise.all([
  sb.from('folders').update({ description: serializeDeckMeta(nextBuilderMeta) }).eq('id', deckId),
  sb.from('folders').update({ description: serializeDeckMeta(nextCollectionMeta) }).eq('id', newCollectionDeck.id),
])
setDeckMeta(nextBuilderMeta)
```

- [ ] **Step 3: Allocate owned cards into the new collection deck**

Update all `upsertDeckAllocations(...)`, `refreshAllocationIndicators(...)`, and follow-up calls inside `handleMakeDeck()` to target `newCollectionDeck.id` instead of `deckId`.

Concrete replacements:

```js
await upsertDeckAllocations(newCollectionDeck.id, user.id, allocationRows)
await reassignPlacementsToDeck(newCollectionDeck.id, allocationRows)
await refreshAllocationIndicators(newCollectionDeck.id)
setSyncStatus({ loading: false, dirty: false, count: 0, unavailable: false })
```

- [ ] **Step 4: Write the initial sync snapshot**

At the end of `handleMakeDeck()`, add:

```js
const allocationRows = await fetchDeckAllocations(newCollectionDeck.id)
const initialSnapshot = buildSyncSnapshot({
  builderCards: deckCardsRef.current,
  collectionCards: allocationRows || [],
})

const syncedBuilderMeta = writeSyncState(nextBuilderMeta, {
  last_sync_at: new Date().toISOString(),
  last_sync_snapshot: initialSnapshot,
  unsynced_builder: false,
  unsynced_collection: false,
})
const syncedCollectionMeta = writeSyncState(nextCollectionMeta, {
  last_sync_at: new Date().toISOString(),
  last_sync_snapshot: initialSnapshot,
  unsynced_builder: false,
  unsynced_collection: false,
})

await Promise.all([
  sb.from('folders').update({ description: serializeDeckMeta(syncedBuilderMeta) }).eq('id', deckId),
  sb.from('folders').update({ description: serializeDeckMeta(syncedCollectionMeta) }).eq('id', newCollectionDeck.id),
])
setDeckMeta(syncedBuilderMeta)
```

- [ ] **Step 5: Verify the builder list still treats collection decks as linked companions**

In `src/pages/Builder.jsx`, keep:

```js
const effectiveId = (deck.type === 'deck' && meta.linked_builder_id) ? meta.linked_builder_id : deck.id
```

Then adjust delete copy to stop implying the collection deck is the builder deck itself.

- [ ] **Step 6: Run build**

Run: `npm run build`

Expected: PASS, and `Make Collection Deck` still compiles with the new linked-pair helpers.

- [ ] **Step 7: Commit**

```bash
git add src/pages/DeckBuilder.jsx src/pages/Builder.jsx
git commit -m "feat(sync): create linked collection decks without converting builder decks"
```

---

### Task 3: Replace live sync count with baseline-aware unsynced state

**Files:**
- Modify: `src/pages/DeckBuilder.jsx:2888-2953, 3468-3472`
- Modify: `src/pages/DeckBrowser.jsx`
- Modify: `src/pages/Builder.jsx`
- Test: manual dirty-state scenarios

- [ ] **Step 1: Replace current `syncStatus` effect in DeckBuilder**

Remove the effect that reads `deck_allocations_view` and compares current totals directly.

Replace it with a helper that:

```js
async function refreshLinkedSyncStatus(explicitDeckId = null, explicitBuilderMeta = null) {
  const targetDeckId = explicitDeckId || getAllocationDeckId()
  const effectiveMeta = explicitBuilderMeta || deckMeta
  if (!targetDeckId || !effectiveMeta?.sync_state?.last_sync_snapshot) {
    setSyncStatus({ loading: false, dirty: false, count: 0, unavailable: !targetDeckId })
    return
  }

  setSyncStatus(prev => ({ ...prev, loading: true, unavailable: false }))
  const currentAllocations = await fetchDeckAllocations(targetDeckId)
  const diff = buildSyncDiff({
    baseline: effectiveMeta.sync_state.last_sync_snapshot,
    builderCards: deckCardsRef.current,
    collectionCards: currentAllocations || [],
  })
  const count = diff.builderOnly.length + diff.collectionOnly.length + diff.conflicts.length
  setSyncStatus({ loading: false, dirty: count > 0, count, unavailable: false, diff })
}
```

- [ ] **Step 2: Trigger refresh after builder edits and deck load**

Call `refreshLinkedSyncStatus(...)` after:

- initial deck load
- quantity changes
- remove card
- move board
- toggle foil
- collection sync apply

Use the existing local optimistic state and then recompute from server-backed allocations.

- [ ] **Step 3: Show compact unsynced labeling in DeckBuilder**

Change the header button label logic to:

```jsx
<span className={styles.btnLabel}>
  {syncRunning ? 'Applying...' : syncStatus.dirty ? 'Unsynced' : 'Synced'}
</span>
<span className={styles.btnLabelMobile}>
  {syncRunning ? 'Applying' : syncStatus.dirty ? 'Unsynced' : 'Synced'}
</span>
```

Keep the button present whenever the deck is linked.

- [ ] **Step 4: Add collection-side unsynced indicators**

In `src/pages/DeckBrowser.jsx`, after loading the folder metadata, parse `sync_state` and `linked_builder_id`.

Render a compact badge near the header actions:

```jsx
{deckMeta?.linked_builder_id && deckMeta?.sync_state && (
  <span className={styles.unsyncedBadge}>
    {deckMeta.sync_state.unsynced_collection ? 'Unsynced' : 'Synced'}
  </span>
)}
```

Add the same badge to the Builder tile in `src/pages/Builder.jsx` using folder metadata.

- [ ] **Step 5: Run build**

Run: `npm run build`

Expected: PASS, and all linked deck surfaces compile with the new `sync_state` reads.

- [ ] **Step 6: Commit**

```bash
git add src/pages/DeckBuilder.jsx src/pages/DeckBrowser.jsx src/pages/Builder.jsx
git commit -m "feat(sync): add baseline-aware unsynced indicators"
```

---

### Task 4: Replace sync modal with review-and-apply actions

**Files:**
- Modify: `src/pages/DeckBuilder.jsx:900-1165, 3349-3410, 4360-4405`
- Test: manual sync discrepancy resolution

- [ ] **Step 1: Rework sync modal inputs**

Change the sync modal props to consume the baseline-aware diff shape:

```js
{
  diff: {
    builderOnly: [],
    collectionOnly: [],
    conflicts: [],
  },
  onConfirm,
}
```

Add local modal state:

```js
const [resolutions, setResolutions] = useState(() => new Map())
const [defaultMoveTargetId, setDefaultMoveTargetId] = useState('')
```

Each discrepancy row gets a direction select:

```js
const initialResolution = section === 'builderOnly'
  ? 'builder'
  : section === 'collectionOnly'
    ? 'collection'
    : 'keep'
```

- [ ] **Step 2: Render three sections**

Inside the modal, replace add/remove summary sections with:

```jsx
<div style={secLabel}>Builder only ({diff.builderOnly.length})</div>
<div style={secLabel}>Collection only ({diff.collectionOnly.length})</div>
<div style={secLabel}>Conflicts ({diff.conflicts.length})</div>
```

Each row should show:

- card name
- builder quantity
- collection quantity
- select with `Use builder`, `Use collection`, `Keep for now`

- [ ] **Step 3: Compute apply payload from resolutions**

Add a helper in `DeckBuilder.jsx`:

```js
function buildResolvedSyncActions(diff, resolutions) {
  const actions = { useBuilder: [], useCollection: [], kept: [] }
  for (const row of [...diff.builderOnly, ...diff.collectionOnly, ...diff.conflicts]) {
    const resolution = resolutions.get(row.key) || 'keep'
    if (resolution === 'builder') actions.useBuilder.push(row)
    else if (resolution === 'collection') actions.useCollection.push(row)
    else actions.kept.push(row)
  }
  return actions
}
```

- [ ] **Step 4: Replace `handleSync()` implementation**

Stop using the current `added`, `changed`, `removed` auto-sync flow.

Replace `handleSync()` with:

```js
async function handleSync({ diff, resolutions, defaultMoveTargetId, rowMoveTargets }) {
  if (syncRunning) return
  setSyncRunning(true)
  setShowSync(false)
  try {
    const targetDeckId = getAllocationDeckId()
    if (!targetDeckId) throw new Error('No linked collection deck to sync.')

    const actions = buildResolvedSyncActions(diff, resolutions)
    await applyBuilderSelectionsToCollection({
      targetDeckId,
      userId: user.id,
      rows: actions.useBuilder,
      defaultMoveTargetId,
      rowMoveTargets,
    })
    await applyCollectionSelectionsToBuilder({
      deckId,
      rows: actions.useCollection,
    })

    const currentAllocations = await fetchDeckAllocations(targetDeckId)
    const snapshot = buildSyncSnapshot({
      builderCards: deckCardsRef.current,
      collectionCards: currentAllocations || [],
    })
    await persistLinkedSyncSnapshot({ builderDeckId: deckId, collectionDeckId: targetDeckId, snapshot, hasUnresolved: actions.kept.length > 0 })
    await refreshAllocationIndicators(targetDeckId)
    await refreshLinkedSyncStatus(targetDeckId)
    setSyncMsg(actions.kept.length > 0 ? 'Sync applied. Some differences were kept.' : 'Sync complete')
    setSyncDone(true)
  } catch (err) {
    console.error('[Sync]', err)
    setSyncMsg('Sync failed. Try again.')
    setSyncDone(true)
  }
  setSyncRunning(false)
}
```

- [ ] **Step 5: Run build**

Run: `npm run build`

Expected: PASS, with the sync modal now driven by discrepancy rows instead of automatic add/remove logic.

- [ ] **Step 6: Commit**

```bash
git add src/pages/DeckBuilder.jsx
git commit -m "feat(sync): add review-and-apply sync flow"
```

---

### Task 5: Add apply helpers for both directions

**Files:**
- Modify: `src/lib/deckSync.js`
- Modify: `src/pages/DeckBuilder.jsx`
- Test: manual builder-to-collection and collection-to-builder apply

- [ ] **Step 1: Add collection-apply helper to `deckSync.js`**

Implement:

```js
export async function applyBuilderSelectionsToCollection({
  targetDeckId,
  userId,
  rows,
  defaultMoveTargetId,
  rowMoveTargets,
  sb,
  fetchDeckAllocations,
  reassignPlacementsToDeck,
  moveOwnedCopiesOutOfDeck,
}) {
  const currentAllocations = await fetchDeckAllocations(targetDeckId)
  // reconcile each selected row so collection logical qty matches builder logical qty
}
```

Behavior:

- if builder qty > collection qty:
  - add missing owned allocations where available
  - reassign placements to target deck as needed
- if builder qty < collection qty:
  - remove excess allocations from target deck
  - move freed owned copies using row/default move target

- [ ] **Step 2: Add builder-apply helper to `deckSync.js`**

Implement:

```js
export function buildDeckCardPatchPlan(existingDeckCards, row) {
  return {
    creates: [],
    updates: [],
    deletes: [],
  }
}
```

Use it in:

```js
export async function applyCollectionSelectionsToBuilder({
  deckId,
  rows,
  existingDeckCards,
  sb,
}) {
  // reconcile each selected row so builder logical qty matches collection logical qty
}
```

This helper only touches `deck_cards`.

- [ ] **Step 3: Add snapshot persistence helper**

In `src/lib/deckSync.js`, add:

```js
export async function persistLinkedSyncSnapshot({
  builderDeckId,
  collectionDeckId,
  builderMeta,
  collectionMeta,
  snapshot,
  hasUnresolved,
  sb,
}) {
  const now = new Date().toISOString()
  const builderNext = writeSyncState(builderMeta, {
    last_sync_at: now,
    last_sync_snapshot: snapshot,
    unsynced_builder: hasUnresolved,
    unsynced_collection: hasUnresolved,
  })
  const collectionNext = writeSyncState(collectionMeta, {
    last_sync_at: now,
    last_sync_snapshot: snapshot,
    unsynced_builder: hasUnresolved,
    unsynced_collection: hasUnresolved,
  })
  await Promise.all([
    sb.from('folders').update({ description: serializeDeckMeta(builderNext) }).eq('id', builderDeckId),
    sb.from('folders').update({ description: serializeDeckMeta(collectionNext) }).eq('id', collectionDeckId),
  ])
  return { builderNext, collectionNext }
}
```

- [ ] **Step 4: Wire helpers into DeckBuilder**

Replace in-file sync mutation logic with calls into `deckSync.js`. Keep existing printing-selection helper paths only where still needed for exact-print reconciliation.

- [ ] **Step 5: Run build**

Run: `npm run build`

Expected: PASS, with `DeckBuilder.jsx` slimmer and sync behavior delegated into `deckSync.js`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/deckSync.js src/pages/DeckBuilder.jsx
git commit -m "refactor(sync): move linked sync apply logic into helper module"
```

---

### Task 6: Protect linked deck deletion and unlink behavior

**Files:**
- Modify: `src/pages/Folders.jsx:931-1170`
- Modify: `src/pages/Builder.jsx:237-290`
- Modify: `src/pages/DeckBrowser.jsx` (if delete actions exist there)
- Test: manual linked deletion scenarios

- [ ] **Step 1: Add unlink helper**

In `src/lib/deckSync.js`, add:

```js
export async function unlinkPairedDeck({
  folder,
  counterpart,
  sb,
}) {
  if (!counterpart) return
  const counterMeta = parseDeckMeta(counterpart.description)
  const cleared = clearLinkedPair(counterMeta, counterpart.type === 'deck' ? 'collection' : 'builder')
  await sb.from('folders').update({ description: serializeDeckMeta(cleared) }).eq('id', counterpart.id)
}
```

- [ ] **Step 2: Update single delete flow in `Folders.jsx`**

Before deleting a linked `deck` folder, load its linked builder deck using `linked_builder_id`, unlink that builder deck, then proceed with deletion of only the collection deck.

Replace generic delete copy with linked-aware copy:

```js
Cards in linked decks stay safe. Deleting this collection deck will unlink its builder deck and keep that builder deck with its stats.
```

- [ ] **Step 3: Update bulk delete flow**

In `BulkDeleteModal`, when deleting selected linked collection decks, unlink each counterpart before deleting folder rows.

- [ ] **Step 4: Keep Builder page semantics aligned**

In `src/pages/Builder.jsx`, retain the current "hide collection deck from builder list" behavior, but ensure builder-deck deletion unlinks any linked collection deck first.

- [ ] **Step 5: Run build**

Run: `npm run build`

Expected: PASS, and all delete flows compile with linked deck unlink handling.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Folders.jsx src/pages/Builder.jsx src/lib/deckSync.js
git commit -m "fix(sync): unlink linked decks on delete"
```

---

### Task 7: Final verification pass

**Files:**
- Modify: any touched files above as needed
- Test: manual and build verification

- [ ] **Step 1: Verify builder-only drift**

Manual:

1. Create or open a linked deck pair.
2. Remove a card in Builder.
3. Confirm collection deck remains unchanged.
4. Confirm Builder and collection deck both show `Unsynced`.

- [ ] **Step 2: Verify collection-only drift**

Manual:

1. Open the linked collection deck.
2. Remove or move an owned copy.
3. Confirm builder list remains unchanged.
4. Confirm both sides show `Unsynced`.

- [ ] **Step 3: Verify review-and-apply**

Manual:

1. Open `Review Sync`.
2. Choose `Use builder` for one discrepancy.
3. Choose `Use collection` for another.
4. Leave one as `Keep for now`.
5. Apply and verify selected rows changed while unresolved rows remain unsynced.

- [ ] **Step 4: Verify linked deletion**

Manual:

1. Delete a linked collection deck.
2. Confirm builder deck survives and is unlinked.
3. Delete a linked builder deck.
4. Confirm collection deck survives and is unlinked.

- [ ] **Step 5: Run final build**

Run: `npm run build`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/deckSync.js src/pages/DeckBuilder.jsx src/pages/Builder.jsx src/pages/DeckBrowser.jsx src/pages/Folders.jsx src/pages/DeckView.jsx docs/superpowers/specs/2026-04-23-linked-deck-sync-design.md docs/superpowers/plans/2026-04-23-linked-deck-sync.md
git commit -m "feat(sync): decouple builder and collection deck reconciliation"
```

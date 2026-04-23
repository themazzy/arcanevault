# Linked Deck Sync Design

## Goal

Redesign the relationship between DeckBuilder decks and collection decks so they behave as two independent records with explicit reconciliation. Builder edits must not immediately move owned cards. Collection-deck edits must not immediately rewrite the builder list. Sync becomes a review-and-apply workflow where the user chooses direction per discrepancy.

## Current Problems

- The current model mixes two concepts:
  - `deck_cards` as intended deck contents in Builder
  - `deck_allocations` as owned copies assigned into a collection deck
- `handleSync()` in [src/pages/DeckBuilder.jsx](C:/Users/Jan/Desktop/arcanevault/arcanevault/src/pages/DeckBuilder.jsx:3350) immediately relocates removed or decreased owned copies to another destination, which makes batch edits hostile.
- `handleMakeDeck()` in [src/pages/DeckBuilder.jsx](C:/Users/Jan/Desktop/arcanevault/arcanevault/src/pages/DeckBuilder.jsx:3274) currently converts a builder deck in place to `type: 'deck'`, so there is not a durable pair of linked records.
- Collection deck deletion flows in [src/pages/Folders.jsx](C:/Users/Jan/Desktop/arcanevault/arcanevault/src/pages/Folders.jsx:972) and nearby code still delete the folder row outright, which conflicts with preserving the linked builder deck and its stats/history.

## Product Decision

Linked decks are two separate records:

- `builder_deck`:
  - source of truth for intended list
  - owns deck stats, recommendations, combos, game history, and public sharing behavior
- `deck`:
  - source of truth for owned-copy placement in collection
  - owns `deck_allocations` and collection inventory semantics

Neither side mutates the other during normal editing. The only place cross-record updates happen is the sync review and apply flow.

## User Experience

### Builder Deck

- Builder edits update only `deck_cards`.
- Removing a card from Builder does not move owned copies out of the linked collection deck.
- Moving a card between main, side, and maybe in Builder does not immediately alter `deck_allocations`.
- If the linked collection deck differs from the last synced state, Builder shows a compact `Unsynced` indicator and a `Review Sync` action.

### Collection Deck

- Collection deck edits update only `deck_allocations`.
- Removing or moving owned copies in the collection deck does not rewrite `deck_cards`.
- If the linked builder deck differs from the last synced state, collection-deck surfaces show a compact `Unsynced` indicator and the same `Review Sync` action.

### Sync Flow

Sync is a review screen, not an immediate operation.

It presents three discrepancy groups:

- `Builder only`
- `Collection only`
- `Conflicts`

Each discrepancy row supports explicit resolution:

- `Use builder`
- `Use collection`
- `Keep for now`

Bulk actions are supported by section.

If applying a collection-side removal would orphan owned copies from the collection deck, the sync flow asks for a destination for those owned cards as part of the apply step. This destination choice is scoped only to affected rows, with a convenient global default and per-row override.

## Data Model

### Linked Pair

Both folder records store reciprocal links inside `folders.description` metadata:

- builder meta:
  - `linked_deck_id`
- collection meta:
  - `linked_builder_id`

Additional sync metadata is stored on both sides:

- `sync_state.version`
- `sync_state.last_sync_at`
- `sync_state.last_sync_snapshot`
- `sync_state.unsynced_builder`
- `sync_state.unsynced_collection`

The first implementation stores sync state inside folder metadata JSON. A dedicated table is unnecessary for initial rollout.

### Snapshot Shape

Persist one shared logical baseline snapshot after each successful sync. The snapshot needs enough detail to detect which side drifted and to rebuild the review UI.

Snapshot sections:

- `builder_cards`
  - normalized card identity
  - quantity
  - board
  - foil
  - printing identity when known
- `collection_cards`
  - normalized logical totals for comparison UI
  - exact allocation references for apply operations when needed

Normalized identity rule:

- primary: `scryfall_id + foil + board`
- fallback: `normalized name + foil + board`

This keeps UX comparison list-level first, while preserving exact allocation rows for collection-side application.

## Lifecycle Rules

### Creating a Linked Collection Deck

`Make Collection Deck` must stop converting the builder deck in place.

New behavior:

1. Keep the current `builder_deck` record.
2. Create a new `deck` folder record.
3. Link them via metadata on both records.
4. Populate `deck_allocations` for the new collection deck based on the user's chosen owned cards.
5. Write initial sync snapshot to both records.

This preserves stats and history on the builder side and gives the collection side an independent lifecycle.

### Deleting One Side

Deletion never cascades to the linked counterpart.

- deleting a builder deck:
  - deletes only the builder deck and its `deck_cards`
  - clears `linked_builder_id` and sync metadata from the collection deck
- deleting a collection deck:
  - deletes only the collection deck and its `deck_allocations`
  - clears `linked_deck_id` and sync metadata from the builder deck

All delete confirmations for linked pairs must say the other side will be preserved and unlinked.

### Legacy Linked Decks

Some existing records were produced by in-place type conversion and do not have a real linked pair.

Migration behavior:

- if a deck has no reciprocal linked record, treat it as unlinked
- `Make Collection Deck` on such records creates a new proper pair from that point forward
- no one-time destructive migration is required

## Sync Engine

Create a dedicated helper module, likely `src/lib/deckSync.js`, with these responsibilities:

- read linked metadata
- normalize builder rows from `deck_cards`
- normalize collection rows from `deck_allocations`
- read and write sync snapshot metadata
- compare current states against baseline snapshot
- produce discrepancies:
  - `builderOnly`
  - `collectionOnly`
  - `conflicts`
- apply selected resolutions

### Comparison Semantics

The sync engine compares current builder state and current collection state against the stored last-sync snapshot.

Rules:

- only Builder changed since baseline:
  - row is `builderOnly`
- only collection changed since baseline:
  - row is `collectionOnly`
- both sides changed differently since baseline:
  - row is `conflict`
- both sides changed to the same new logical state:
  - no discrepancy

This must be computed from baseline-aware deltas, not from raw current-state diff alone.

## Apply Semantics

### Use Builder

Applying `Use builder` mutates only collection-side state:

- creates, updates, or deletes `deck_allocations`
- reassigns owned copies into or out of the linked collection deck as required
- never rewrites `deck_cards`

### Use Collection

Applying `Use collection` mutates only builder-side state:

- creates, updates, or deletes `deck_cards`
- preserves builder deck metadata, stats, and identity
- never rewrites `deck_allocations` except when the user explicitly chose builder direction for a different row

### Keep for Now

Leaves the discrepancy unresolved. The linked pair remains marked unsynced.

### Snapshot Refresh

After apply succeeds, write a fresh baseline snapshot representing the new mutually accepted state. If some rows were kept unresolved, the new snapshot must retain unresolved diffs correctly; the simplest initial behavior is to refresh snapshot only for fully applied rows and recompute dirty flags afterward.

## UI Surfaces

### Builder

In [src/pages/DeckBuilder.jsx](C:/Users/Jan/Desktop/arcanevault/arcanevault/src/pages/DeckBuilder.jsx):

- replace current dirty-count logic with baseline-aware unsynced state
- rename the current sync action to `Review Sync`
- convert current sync modal from auto-apply assistant to discrepancy review screen

### Collection Deck

In [src/pages/DeckBrowser.jsx](C:/Users/Jan/Desktop/arcanevault/arcanevault/src/pages/DeckBrowser.jsx) and related deck list surfaces:

- show `Unsynced` badge for linked collection decks with pending discrepancies
- add `Review Sync` entry next to `Edit in Builder`

### Deck Lists

In [src/pages/Builder.jsx](C:/Users/Jan/Desktop/arcanevault/arcanevault/src/pages/Builder.jsx) and deck listing surfaces:

- show compact unsynced badge or dot on linked deck tiles
- keep wording short; avoid noisy diff counts unless a count is clearly useful

## Error Handling

- If a linked counterpart is missing, degrade gracefully:
  - show `Unlinked`
  - disable sync review
- If snapshot metadata is missing or corrupt:
  - rebuild from current state only when the user explicitly relinks or accepts a reset
  - do not silently claim decks are synced
- If apply partially fails:
  - show failure summary
  - do not write new baseline snapshot
  - refresh both current states from server before allowing retry

## Testing Strategy

There is no automated test runner configured, so implementation verification must be command-driven and scenario-focused.

Manual scenarios to cover:

1. Builder removes a card from a linked deck:
   - Builder changes only
   - collection deck remains unchanged
   - both sides show unsynced
2. Collection deck removes an owned copy:
   - collection changes only
   - builder list remains unchanged
   - both sides show unsynced
3. Review sync:
   - choose builder for one row
   - choose collection for another
   - leave one unresolved
   - verify only selected rows apply
4. Delete linked collection deck:
   - builder deck survives
   - stats and history are preserved
   - builder becomes unlinked
5. Delete linked builder deck:
   - collection deck survives
   - allocations are preserved
   - collection deck becomes unlinked
6. Create new collection deck from builder:
   - builder remains `builder_deck`
   - new `deck` record is created
   - reciprocal links are written
   - initial snapshot is written

Build verification remains required via:

```bash
npm run build
```

## Scope Boundaries

This design does not add:

- automatic background sync application
- multi-user conflict handling
- a dedicated database table for sync snapshots
- deep version-history UI

Those can be revisited later if the baseline-aware linked-pair model proves stable.

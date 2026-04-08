# Trading Review Plan

## Scope

This plan covers the issues identified in `src/pages/Trading.jsx` during code review and defines the work needed before the trading flow is safe to ship.

Business rule clarification:
- Cash-only settlement is allowed.
- At least one side of the trade must include one or more cards.

## Goals

- Keep owned-card quantities consistent with binder, list, and collection-deck placements.
- Require explicit source selection when trading away cards that exist in more than one placement.
- Prevent partial trades from being persisted when any write in the flow fails.
- Fix wanted-card identity so foil and non-foil selections behave predictably.
- Keep IndexedDB mirrors in sync with remote changes after trades.
- Handle Scryfall search failures without leaving the page stuck in a loading state.

## Workstreams

### 1. Redesign trade persistence around placement-aware ownership

Problem:
- The current save path decrements or deletes rows in `cards` directly.
- It does not reduce `folder_cards` quantities for partial trades.
- It does not account for `deck_allocations` at all.
- This can leave placements claiming copies that no longer exist.
- If the same owned card exists in multiple binders/decks, the app must not guess which source loses copies.

Required changes:
- Add explicit source selection to the trading UI so each offered row is tied to a concrete binder, list, or collection deck placement.
- Define the exact ownership behavior for trading away cards that are currently placed in binders, lists, and collection decks.
- Reject invalid trades when the selected offered quantity cannot be satisfied by removable placements.
- Replace direct `cards.qty` mutation with a placement-aware reduction flow.
- Update `folder_cards` quantities when offered copies are removed from binders or lists.
- Update `deck_allocations` quantities when offered copies are removed from collection decks.
- Only prune a `cards` row after verifying that no `folder_cards` or `deck_allocations` placements remain, reusing the ownership rules in `src/lib/collectionOwnership.js`.

Implementation direction:
- Extract trading persistence into a dedicated helper instead of keeping all mutation logic inline in `src/pages/Trading.jsx`.
- Prefer a backend RPC or other single-operation server-side flow that can validate placements and apply all related writes together.
- If a backend RPC is not used, implement explicit placement reconciliation first and call `pruneUnplacedCards()` only after placement updates succeed.

Acceptance criteria:
- A card present in multiple placements cannot be traded away without a concrete source choice.
- Trading away part of a card stack correctly reduces placements and keeps remaining owned quantity aligned.
- Trading away the last placed copy removes the card only when no placements remain anywhere.
- Collection deck allocations remain accurate after a trade.
- Binder/list quantities remain accurate after a trade.

### 2. Make the save flow atomic

Problem:
- The current implementation performs many sequential writes across `folders`, `cards`, and `folder_cards`.
- Any failure in the middle can leave the trade partially saved.

Required changes:
- Move the full trade mutation into a single atomic unit.
- Avoid client-side orchestration of multiple independent remote writes for a single trade commit.
- Return a structured result that includes all affected rows needed to refresh local state.

Implementation direction:
- Preferred: add a Supabase Postgres function/RPC that:
  - Ensures the "Recently Traded" binder exists.
  - Validates the offer side against current placements.
  - Applies all offer-side removals.
  - Applies all receive-side inserts or qty updates.
  - Upserts `folder_cards` rows for received cards into the "Recently Traded" binder.
  - Commits or rolls back as one transaction.
- Fallback: if RPC is deferred, add compensating rollback logic, but this should be treated as temporary and higher risk.

Acceptance criteria:
- Simulated failures do not leave half-completed trades in remote data.
- The client receives a success result only when the full trade is committed.

### 3. Fix wanted-card identity and foil toggling

Problem:
- Wanted rows are keyed with an id derived from foil state, but the row id is not updated when foil is toggled.
- This allows a visually foil row to keep a non-foil identity and merge incorrectly with later additions.

Required changes:
- Treat foil and non-foil as distinct wanted items at all times.
- Recompute the wanted item id when foil state changes.
- Merge rows when toggling foil into an already-existing row for the same print and finish.
- Keep quantity adjustments and remove actions stable after the identity change.

Implementation direction:
- Centralize wanted-item key generation and use it in add, toggle, merge, and update paths.
- Make `onToggleFoil` transform the item into the correct keyed entry instead of mutating only the `foil` boolean.

Acceptance criteria:
- Adding a print twice, then toggling one row to foil, produces correct row separation or merge behavior.
- Quantities remain correct after toggling.
- Save logic receives the correct foil state and identity.

### 4. Keep IndexedDB mirrors consistent after trade mutations

Problem:
- Local `cards` rows are updated, but local `folder_cards` rows can be left behind when offered cards are deleted.
- Offline views can temporarily show dangling placement data.

Required changes:
- Update local IDB for every remote trade mutation that affects `cards`, `folder_cards`, and `deck_allocations`.
- Add local deletion handling for removed `folder_cards` rows.
- Add local deletion or replacement handling for removed `deck_allocations` rows if the trade flow touches collection decks.

Implementation direction:
- Extend `src/lib/db.js` with any missing local delete helpers needed by trading.
- Prefer replacing all affected local rows from the authoritative result returned by the final trade commit rather than piecemeal local mutation.
- Ensure the "Recently Traded" binder and its folder links are mirrored locally after success.

Acceptance criteria:
- After a successful trade, reloading offline shows the same state as online.
- No dangling local folder membership remains for cards removed by a trade.

### 5. Harden wanted search error handling

Problem:
- Failed Scryfall requests can leave the wanted side stuck in loading state.

Required changes:
- Wrap the wanted search effect in `try/catch`.
- Always clear `wantedLoading` in success and error cases.
- Surface a user-visible error or empty-state message when search fails.
- Avoid race conditions so stale responses do not overwrite newer queries.

Acceptance criteria:
- A failed wanted-card search does not leave the UI stuck on loading.
- Typing a new query after an error recovers normally.

### 6. Enforce the clarified trade rules in the UI

Problem:
- The reviewed code currently allows saving as long as at least one side has any cards.
- The business rule is narrower: cash-only is fine, but at least one side must contribute a card.

Required changes:
- Validate before save that the offer side or the receive side contains at least one card item.
- Preserve support for:
  - cards-for-cards
  - cards-plus-cash
  - cards-only one-sided trades
- Reject pure cash settlement with no cards on either side.

Implementation direction:
- Update the pre-save guard and settlement messaging to reflect the actual rule.
- If cash amount entry is added later, keep this validation in the final trade commit path too, not just the UI.

Acceptance criteria:
- Trades with at least one card side are allowed.
- A trade with no card entries is blocked clearly.

## Suggested Order

1. Design the authoritative ownership model for offered cards across `folder_cards` and `deck_allocations`.
2. Implement the atomic backend trade operation.
3. Refactor `Trading.jsx` to call the new helper/RPC and refresh local state from returned results.
4. Fix wanted-item identity and foil toggling.
5. Add IDB mirror updates for all affected entities.
6. Add search error handling and final UI validation updates.

## Implementation Sequence

### Phase 1. Define the backend contract

Deliverable:
- A single trade-commit API contract that the frontend can call once per save.

Tasks:
- Create a `commit_trade` RPC design under `supabase/` with explicit inputs for:
  - `offer_items`: owned `cards.id` plus quantity to remove
  - `want_items`: card print identity plus finish and quantity to add
  - optional cash metadata if trade notes or settlement values are stored later
- Define the RPC response payload to include:
  - the `Recently Traded` binder row
  - changed `cards` rows
  - deleted card ids
  - changed `folder_cards` rows
  - deleted `folder_cards` ids
  - changed `deck_allocations` rows if touched
  - deleted `deck_allocations` ids if touched
- Document failure modes returned by the RPC:
  - offered qty exceeds removable qty
  - missing offered card row
  - conflicting placement state
  - binder creation failure

Why first:
- Everything else depends on a stable backend result shape.

### Phase 2. Implement atomic trade commit in Supabase

Deliverable:
- One transactional database function that either commits the whole trade or nothing.

Tasks:
- Add a SQL migration that creates the RPC.
- In the RPC:
  - lock offered `cards` rows being modified
  - ensure the `Recently Traded` binder exists for the user
  - read related `folder_cards` and `deck_allocations` for offered cards
  - compute removable quantities from real placements
  - reduce or delete placements first
  - call the orphan-pruning logic for cards that no longer have placements
  - upsert received owned cards by print + finish + default language/condition
  - upsert the binder links that place received cards into `Recently Traded`
  - return all changed/deleted row ids needed by the client cache
- Keep all of the above inside one transaction.

Notes:
- The existing logic in `src/lib/collectionOwnership.js` should be treated as the rule source, even if the implementation moves server-side.
- If offered cards can come from collection decks, the RPC must explicitly account for `deck_allocations`, not just `folder_cards`.

### Phase 3. Add a frontend trading data layer

Deliverable:
- `Trading.jsx` stops orchestrating raw Supabase writes directly.

Tasks:
- Create a dedicated helper module for trade commit requests and result normalization.
- Move the current `handleTrade()` persistence logic out of the page component.
- Replace the multi-step client save path with:
  - validate request
  - call RPC once
  - apply returned state locally
  - show success/error message

Why:
- The page should manage UI state, not distributed persistence logic.

### Phase 4. Synchronize IndexedDB from authoritative RPC results

Deliverable:
- Successful trades leave local state consistent without waiting for a later sync.

Tasks:
- Extend `src/lib/db.js` with any missing delete helpers for:
  - `folder_cards`
  - `deck_allocations`
- Apply returned upserts and deletes to local IDB in one post-commit reconciliation step.
- Update local `folders` when the `Recently Traded` binder is created or changed.
- Update page state from the same normalized result so UI and IDB use the same source of truth.

Notes:
- Prefer applying server-returned rows over re-deriving local mutations from the original request.

### Phase 5. Fix wanted-item identity

Deliverable:
- Foil and non-foil wanted entries behave as distinct identities.

Tasks:
- Centralize wanted-row id generation.
- Update `addWantedCard()` so it always keys rows by current finish.
- Update foil toggling so it:
  - computes the next id
  - merges with an existing matching row if present
  - preserves correct quantity
- Re-check button handlers that depend on item ids.

### Phase 6. Harden UI validation and search behavior

Deliverable:
- The page handles invalid input and failed searches cleanly.

Tasks:
- Add pre-submit validation that blocks only zero-card trades.
- Keep support for one-sided card trades and card-plus-cash scenarios.
- Wrap wanted search in `try/catch/finally`.
- Add a visible error state for failed Scryfall lookups.
- Ensure stale async search responses cannot overwrite newer results.

### Phase 7. Verify with targeted manual scenarios

Deliverable:
- A repeatable checklist proving the trade flow is safe.

Tasks:
- Test partial trade-away from a binder.
- Test trade-away from a card allocated to a collection deck.
- Test removing the final placed copy of a card.
- Test receiving into an existing owned row.
- Test foil toggle merge behavior.
- Test offline reload after a successful trade.
- Test simulated RPC failure to confirm rollback.

## Recommended First PR Slice

If this work is split into smaller PRs, the safest order is:

1. Backend migration and RPC contract.
2. Frontend integration with RPC plus IDB reconciliation.
3. Wanted-item foil identity fix.
4. Scryfall error handling and small validation polish.

## Verification Checklist

- Trade away part of a binder-held card stack and confirm both `cards.qty` and `folder_cards.qty` stay aligned.
- Trade away the final copy of a card that is also allocated to a collection deck and confirm the flow either updates allocations correctly or blocks invalid removal.
- Receive a card already owned in the same language/condition/finish and confirm qty increments instead of duplicating incorrectly.
- Toggle a wanted row between foil and non-foil and verify merge behavior is correct.
- Force a failed Scryfall search and verify the spinner clears.
- Force a backend failure during save and verify no partial trade is committed.
- Reload online and offline after a completed trade and compare results.

## Files Likely To Change

- `src/pages/Trading.jsx`
- `src/pages/Trading.module.css`
- `src/lib/collectionOwnership.js`
- `src/lib/db.js`
- `src/lib/supabase.js` or a new trading helper module
- Supabase SQL for RPC / transaction support, likely under `supabase/`

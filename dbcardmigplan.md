# Card Schema Migration Plan

Created: 2026-04-21

Current schema snapshot:

```text
supabase/schema_snapshots/2026-04-21_current_card_schema/
```

This folder contains the current top-level Supabase SQL files and all current `supabase/migrations/*.sql` files. Use it as the rollback/reference point before implementing any card metadata or quantity migration.

## Purpose

This plan documents a safe migration path for normalizing card print metadata around `card_prints` while preserving all existing user data.

The migration is primarily a reliability and data-integrity improvement. It is not expected to create major UI speedups because the app's performance-critical reads already come from IndexedDB and local Scryfall/cache data.

The migration should not be implemented as one large destructive rewrite. It should be staged, backward-compatible, auditable, and reversible until validation proves data is preserved.

## Current Model Risk Summary

The main schema risks are:

1. Card print metadata is duplicated across `cards`, `deck_cards`, `list_items`, `card_prices`, `card_hashes`, and `card_prints`.
2. `cards.qty` and placement quantities in `folder_cards` / `deck_allocations` can drift.
3. Historical deck placements may still exist in `folder_cards`, even though `deck_allocations` is now the source of truth for owned collection decks.
4. The current `cards` uniqueness logic can allow duplicates when nullable fields such as `condition` are `NULL`.
5. `list_items` stores print identity directly instead of referencing `card_prints`.
6. `schema.sql` may be behind later migrations and should be regenerated or updated after any final migration.

## Important Quantity Principle

The migration must preserve split-copy behavior.

The app currently needs to support cases like:

```text
cards.id = 123
cards.qty = 4

folder_cards:
  Binder A -> card 123 -> qty 2
  Binder B -> card 123 -> qty 1

deck_allocations:
  Deck X -> card 123 -> qty 1
```

This is not bad duplication. It is required placement data.

The safe interpretation is:

```text
cards.qty
  aggregate owned copies for one exact owned card bucket

folder_cards.qty
  number of copies placed in binder/list folders

deck_allocations.qty
  number of copies assigned to collection decks
```

Do not collapse placement rows into a single card row and discard location quantities.

## Data Loss Risk Assessment

### Metadata normalization

Risk: Low to medium.

Adding `card_print_id` to existing rows is safe if old columns remain during the transition and all unmatched rows are reported before enforcing `NOT NULL`.

### Merging duplicate `cards` rows

Risk: High.

Duplicate `cards` rows may have different placements. If they are merged, every referencing row in `folder_cards` and `deck_allocations` must be moved to the surviving `cards.id`.

If two rows collapse into the same placement after merging, quantities must be summed, not overwritten.

Do not merge duplicate `cards` rows automatically unless every affected placement row and total quantity can be reconciled without reducing owned copies. Duplicate cleanup is a preservation task, not a deduplication shortcut.

Default safety rule:

```text
If duplicate rows are not fully reconcilable:
  leave them in place
  report them for manual review

If duplicate rows are fully reconcilable:
  sum cards.qty across merged rows
  move every placement row to the survivor
  sum placement qty where rows collapse to the same folder/deck
  delete only duplicate card rows with no remaining references
```

Never use `max(cards.qty)` as the default merge policy if it would reduce owned quantity.

### Quantity reconciliation

Risk: High.

Do not automatically reduce `cards.qty` to match placement totals. This can lose owned copies when placement data is incomplete.

Safe policy:

```text
If placement total = cards.qty:
  no action needed

If placement total < cards.qty:
  preserve cards.qty
  create/report missing placement quantity
  preferred automatic repair: place missing copies in a fallback binder such as "Unsorted"

If placement total > cards.qty:
  preserve placements
  increase cards.qty to placement total, or report for manual review
```

No automatic repair should reduce total owned copies.

### Moving legacy deck placements

Risk: Medium to high.

Rows in `folder_cards` for folders of type `deck` should only be deleted after equivalent `deck_allocations` rows exist with matching quantities.

### Wishlist migration

Risk: Low to medium.

`list_items.qty`, `foil`, folder ownership, and wishlist membership must be preserved exactly.

### Schema baseline update

Risk: Low.

Updating `schema.sql` is necessary for fresh installs, but should happen only after the live migration is verified.

## Migration Strategy

### Phase 0: Backups and Rollback Readiness

Before running any database migration:

1. Keep the repository SQL snapshot at:

```text
supabase/schema_snapshots/2026-04-21_current_card_schema/
```

2. Export a production Supabase database backup using Supabase's normal backup/export tooling.
3. Record row counts for all affected tables:

```text
cards
folders
folder_cards
deck_allocations
deck_cards
list_items
card_prints
card_prices
card_hashes
```

4. Record aggregate quantity totals:

```text
sum(cards.qty)
sum(folder_cards.qty)
sum(deck_allocations.qty)
sum(list_items.qty)
```

5. Record duplicate and mismatch reports before migration.

Rollback expectation:

The SQL snapshot in this repository helps restore schema/migration files, but the real rollback path for live data is a Supabase database backup taken immediately before migration.

### Phase 1: Add Nullable References

Add new nullable columns first:

```text
cards.card_print_id
deck_cards.card_print_id
list_items.card_print_id
```

Each should reference:

```text
card_prints.id
```

Do not remove old duplicated print fields yet.

Do not make the new columns `NOT NULL` yet.

### Phase 2: Backfill `card_prints`

Build missing `card_prints` rows from existing data sources:

```text
cards
deck_cards
list_items
card_prices
card_hashes
```

Preferred identity key:

```text
scryfall_id
```

Fallback identity key:

```text
set_code + collector_number
```

Only use fallback identity where `scryfall_id` is missing.

Deduplicate candidates before inserting into `card_prints`.

### Phase 3: Backfill New Foreign Keys

Update existing rows to point at `card_prints`.

Preferred match:

```text
table.scryfall_id = card_prints.scryfall_id
```

Fallback match:

```text
table.set_code = card_prints.set_code
table.collector_number = card_prints.collector_number
```

Apply to:

```text
cards
deck_cards
list_items
```

After this phase, produce a report of every row where `card_print_id` is still `NULL`.

Do not continue to strict constraints until this report is empty or intentionally resolved.

### Phase 4: Audit Duplicate Owned Cards

Find duplicate owned-card buckets using null-safe grouping:

```text
user_id
card_print_id
foil
language
condition, treating NULL as one value
```

For every duplicate group:

1. Pick a surviving `cards.id`.
2. Move all `folder_cards.card_id` references to the survivor.
3. Move all `deck_allocations.card_id` references to the survivor.
4. If multiple placement rows become identical after the move, sum `qty`.
5. Sum `cards.qty` across the merged rows unless a prior audit proves that doing so would double-count the same physical copies.
6. Delete only the duplicate `cards` rows that have no remaining references.

This phase must be validated on a copy/staging database first.

If the migration cannot prove that duplicate rows represent the same exact owned-card bucket, do not merge them in this phase. Keep the rows, record the conflict, and defer to manual review or a later targeted repair.

### Phase 5: Fix `cards` Uniqueness

Replace the nullable-unsafe uniqueness behavior.

Preferred if the Supabase Postgres version supports it:

```text
unique nulls not distinct (
  user_id,
  card_print_id,
  foil,
  language,
  condition
)
```

Fallback:

```text
unique functional index using coalesce(condition, '')
```

This should happen only after duplicate owned-card buckets are resolved.

### Phase 6: Move Legacy Deck Placements

For `folder_cards` rows whose parent folder has `type = 'deck'`:

1. Insert or merge equivalent rows into `deck_allocations`.
2. If an allocation already exists for the same `deck_id + card_id`, add quantities or reconcile deterministically.
3. Validate that every legacy deck placement has a matching `deck_allocations` quantity.
4. Delete those legacy `folder_cards` rows only after validation.
5. Add a database guard preventing future `folder_cards` rows from referencing deck folders.

`folder_cards` should remain for binder/list placements only.

### Phase 7: Quantity Validation and Repair

Compute placement totals per `cards.id`:

```text
placement_total =
  sum(folder_cards.qty for the card)
  +
  sum(deck_allocations.qty for the card)
```

Compare to:

```text
cards.qty
```

Safe repair policy:

```text
placement_total = cards.qty
  no action

placement_total < cards.qty
  do not reduce cards.qty
  create/report missing placement quantity
  optional automatic repair: add missing qty to fallback binder "Unsorted"

placement_total > cards.qty
  do not reduce placements
  increase cards.qty to placement_total, or report for manual review
```

The migration must never silently reduce owned quantity.

### Phase 8: Update App Reads and Writes

Roll app behavior forward in stages.

Stage A:

```text
Writes include both old metadata fields and card_print_id.
Reads prefer card_print_id when available.
Reads fall back to old metadata fields.
```

Stage B:

```text
New writes require card_print_id.
Old fields remain for compatibility and debugging.
```

Stage C:

```text
After a stability period, consider dropping duplicated metadata columns only where clearly safe.
```

Do not remove old columns during the first database migration.

### Phase 9: Add Strict Constraints

Only after production validation:

```text
cards.card_print_id NOT NULL
deck_cards.card_print_id NOT NULL
list_items.card_print_id NOT NULL
```

Add indexes for:

```text
cards.card_print_id
deck_cards.card_print_id
list_items.card_print_id
```

Add or update uniqueness:

```text
cards:
  user_id + card_print_id + foil + language + condition

deck_cards:
  deck_id + card_print_id + foil + board

list_items:
  folder_id + card_print_id + foil
```

Use null-safe uniqueness where nullable fields remain.

### Phase 10: Regenerate `schema.sql`

After the live migration and app rollout are verified, regenerate or update:

```text
supabase/schema.sql
```

It should represent the current full schema, including:

```text
folders.type includes binder, deck, list, builder_deck
card_print_id references
deck_allocations
fixed cards uniqueness
folder_cards deck-folder prevention
current RLS policies
current public read policies for shared data
```

## Validation Checklist

Before migration:

```text
Record row counts.
Record quantity totals.
Record duplicate cards groups.
Record cards with placement mismatches.
Record folder_cards rows pointing at deck folders.
Record list_items rows that cannot match card_prints.
```

After each phase:

```text
No unexpected row-count drops.
No decrease in sum(cards.qty).
No decrease in sum(folder_cards.qty) except verified deck rows moved to deck_allocations.
No decrease in sum(deck_allocations.qty) after legacy deck move.
No decrease in sum(list_items.qty).
No cards row deleted while still referenced.
No placement row lost without an equivalent replacement.
No required card_print_id left null before NOT NULL constraints.
```

After full migration:

```text
All owned cards have a valid card_print_id.
All deck_cards have a valid card_print_id.
All list_items have a valid card_print_id.
No folder_cards rows point to folders of type deck.
Duplicate cards conflict target is null-safe.
cards.qty is greater than or equal to placement totals, or intentionally reconciled.
No duplicate cards merge reduced sum(cards.qty).
No duplicate cards merge reduced combined placement quantity.
Collection grid still shows split copies by binder/deck.
Bulk selection still counts selected copy quantity correctly.
Deck allocation badges still use deck_allocations.
Wishlist quantities are unchanged.
```

## Recommendation

Do not run the full normalization migration just for performance.

The highest-value near-term work is a smaller data-integrity hardening pass:

```text
1. Fix nullable uniqueness for cards.
2. Add quantity mismatch validation.
3. Prevent folder_cards from referencing deck folders.
4. Safely move legacy deck folder_cards rows to deck_allocations.
5. Update schema.sql after verification.
```

Add `card_print_id` to `cards`, `deck_cards`, and `list_items` gradually when it solves concrete reliability or maintenance problems.

Full metadata cleanup should be delayed until the app has read/write compatibility for the normalized fields and production validation has shown no data drift.

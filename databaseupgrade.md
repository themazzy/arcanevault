# Database Upgrade Plan

## Goal

Clarify the separation between:

- owned inventory
- deckbuilder intent
- owned-card allocation to decks
- shared reference data

Reduce query branching and duplicate write paths without breaking the existing workflow where a user can build a deck from cards they do not own yet, then sync owned copies into that deck later.

## Current Model Summary

### User-owned data

- `cards`
  - user-scoped owned card rows
  - stores print and ownership fields together
- `folders`
  - binder / deck / list / builder deck containers
- `folder_cards`
  - join table between owned `cards` and `folders`
  - currently used for binders and also for some deck-related behavior
- `deck_cards`
  - builder deck rows
  - stores deck intent and duplicated card-print metadata

### Shared data

- `card_prices`
  - shared daily price snapshots
- `card_hashes`
  - shared scanner lookup dataset

## Current Problems

### 1. Two models exist for deck contents

Deck contents can come from:

- `deck_cards`
- `folder_cards` fallback for `folders.type = 'deck'`

This forces extra reads and compatibility logic in the app. It also creates consistency risk when a deck is partially represented in one table and partially in the other.

### 2. Deck intent and owned allocation are mixed conceptually

The app supports:

- planning a deck with cards not yet owned
- syncing actually owned copies into the collection deck

That means the model needs a clear distinction between:

- intended deck composition
- physical owned copies committed to that deck

Today this distinction exists in behavior, but the persistence model is not fully clean.

### 3. Some denormalized metadata is intentionally duplicated

`deck_cards` stores card-print metadata directly. This is useful for fast reads and offline behavior, but it increases:

- row size
- stale metadata risk
- total duplicated data across users

### 4. Folder semantics are overloaded

`folders` currently represents:

- binders
- decks
- lists
- builder decks

This is workable, but deck-related semantics are different enough that the app compensates with special-case code.

## Recommended Target Model

Keep the high-level separation, but make responsibilities explicit.

### 1. `cards` remains the owned inventory table

Purpose:

- physical or owned collection entries for a user

Represents:

- what the user owns
- quantity
- condition
- foil
- purchase and currency metadata

### 2. `deck_cards` becomes the single source of truth for deck composition

Purpose:

- intended contents of a deck

Represents:

- all cards the user wants in the deck
- includes unowned cards
- includes commander / board / qty / print preferences

Rule:

- deck views and builder views should load deck composition only from `deck_cards`

### 3. `folder_cards` stops representing deck composition

Purpose after upgrade:

- placement of owned cards in binders and lists
- optionally, temporary compatibility use only during migration

Preferred end state:

- no screen should need to load deck composition from `folder_cards`

### 4. Add a dedicated allocation table for owned copies assigned to a deck

Recommended new table:

- `deck_allocations`

Purpose:

- map owned inventory to planned deck entries
- record which owned copies are committed to a deck

Suggested columns:

- `id`
- `user_id`
- `deck_id` references `folders(id)`
- `card_id` references `cards(id)`
- `qty`
- `created_at`
- `updated_at`

Optional future columns:

- `source` (`manual`, `sync`, `import`)
- `notes`

This table answers:

- which actual owned copies are allocated into this planned deck
- how much of the intended deck is satisfied from the collection

This separates:

- `deck_cards`: desired decklist
- `deck_allocations`: owned fulfillment of that decklist

### 5. Keep `card_prices` and `card_hashes` shared

No structural change recommended here.

They are already global/reference datasets and should not be duplicated per user.

## Why This Model Fits the Product

This app has two valid and distinct deck questions:

- "What is my deck supposed to contain?"
- "What cards do I actually own and have assigned to it?"

Those are not the same data.

Using:

- `deck_cards` for intent
- `deck_allocations` for owned fulfillment

lets the app support:

- brewing decks from scratch
- seeing missing cards
- syncing only owned cards into a deck
- moving owned copies out of general inventory into an assigned state
- showing deck completion accurately

## Fully Normalized Variant

If the goal is to do the migration once and avoid another structural change later, a more normalized target can be adopted in the same project-wide upgrade.

### Proposed shared reference table: `card_prints`

Purpose:

- one shared row per MTG printing
- canonical metadata source for card identity and display metadata

Suggested columns:

- `id`
- `scryfall_id` unique
- `oracle_id`
- `name`
- `set_code`
- `collector_number`
- `type_line`
- `mana_cost`
- `cmc`
- `color_identity`
- `image_uri`
- `art_crop_uri`
- `updated_at`

Optional later:

- rarity
- layout
- released_at
- legalities snapshot if needed locally

### Normalized owned inventory

`cards` becomes mostly ownership data:

- `id`
- `user_id`
- `card_print_id` references `card_prints(id)`
- `qty`
- `foil`
- `condition`
- `language`
- `purchase_price`
- `currency`
- `misprint`
- `altered`
- `added_at`
- `updated_at`

This removes repeated print metadata from every user-owned row.

### Normalized deck composition

`deck_cards` becomes:

- `id`
- `deck_id`
- `user_id`
- `card_print_id` references `card_prints(id)`
- `qty`
- `foil`
- `is_commander`
- `board`
- `created_at`
- `updated_at`

Optional exception:

- keep a small cached display field such as `display_name` only if a concrete UI path proves it materially faster

### Shared scanner data alignment

`card_hashes` can either:

1. keep `scryfall_id` as its external key
2. or reference `card_prints(id)`

Recommendation:

- keep `scryfall_id` as the public identity for migration simplicity
- join logically to `card_prints` via `scryfall_id`

### Shared pricing alignment

`card_prices` already aligns well with shared print identity.

It can stay keyed by:

- `scryfall_id + snapshot_date`

or later reference `card_prints(id)` if desired.

Recommendation:

- keep current external key during the first normalized migration

## Normalized Target Model Summary

### Shared/reference tables

- `card_prints`
- `card_prices`
- `card_hashes`

### User tables

- `cards`
- `folders`
- `folder_cards`
- `deck_cards`
- `deck_allocations`

### Responsibility split

- `card_prints`: what the printing is
- `cards`: what the user owns
- `folder_cards`: where owned cards are placed
- `deck_cards`: what the deck is supposed to contain
- `deck_allocations`: which owned copies fulfill that deck

## Should Normalization Be Included In The Same Migration?

Yes, it can be, but only if you accept a larger migration with more code touch points.

### Best reason to include it now

- avoids two separate disruptive schema transitions
- removes repeated print metadata across users
- creates one stable identity model across ownership, deckbuilding, prices, and scanner data

### Best reason not to include it now

- higher migration risk
- more joins or more server-side views needed
- larger application rewrite in one step

## Revised Detailed Upgrade Plan For One-Pass Migration

### Phase 0. Preparation

1. Inventory all current read/write paths.
2. Define canonical print identity as `scryfall_id`.
3. Decide whether `card_prints.id` will be internal-only or whether code will use `scryfall_id` directly in many places.

### Phase 1. Add new shared and allocation tables

Add:

- `card_prints`
- `deck_allocations`

Do not remove legacy columns yet.

### Phase 2. Backfill `card_prints`

Populate from:

- distinct `cards.scryfall_id`
- distinct `deck_cards.scryfall_id`
- scanner and pricing datasets if needed for completeness

Priority source for metadata:

1. existing `deck_cards` rows where richer metadata exists
2. existing `cards` rows
3. Scryfall-derived import pipeline if needed later

### Phase 3. Add foreign keys alongside legacy columns

Temporarily add:

- `cards.card_print_id`
- `deck_cards.card_print_id`

Backfill them from `scryfall_id`.

Keep legacy metadata columns temporarily so the app still runs while code is being switched.

### Phase 4. Make `deck_cards` canonical for all deck composition

Same as the earlier plan:

- backfill missing deck composition into `deck_cards`
- remove reliance on `folder_cards` for deck composition

### Phase 5. Move sync semantics to `deck_allocations`

Same as the earlier plan:

- sync compares intended deck vs owned cards
- writes fulfillment into `deck_allocations`

### Phase 6. Switch app reads to normalized sources

Options:

1. client joins manually after fetching `card_prints`
2. Supabase views expose app-friendly denormalized read models

Recommendation:

- use SQL views or RPCs for hot paths so the client does not perform many small joins

Likely views:

- `owned_cards_view`
- `deck_cards_view`
- `deck_completion_view`

### Phase 7. Remove duplicated metadata columns

After all reads/writes use normalized structure:

- drop print metadata columns from `cards`
- drop print metadata columns from `deck_cards`
- keep only fields truly specific to ownership or deck entry behavior

## Performance Impact Of Normalization

Normalization does not automatically make the app faster.

### It can help by reducing:

- row width
- duplicated transfer over time
- inconsistent cache invalidation

### It can hurt by increasing:

- join cost
- number of client fetches if the API shape is naive
- implementation complexity

### Practical recommendation

If you normalize, pair it with read-optimized SQL views or RPC endpoints for deck and collection screens.

That gives:

- normalized storage
- denormalized fast reads

without making the browser do extra work.

## Database Size Impact

There are two different size questions:

### 1. Raw table storage in Postgres

Normalization should reduce total storage as user count grows, because repeated print metadata stops being stored once per user-owned row and once per deck row.

Biggest win areas:

- `cards`
- `deck_cards`

Little or no meaningful change:

- `card_prices`
- `card_hashes`

because those are already shared/global.

### 2. Migration-period storage

During the migration, database size will temporarily increase because you will have:

- old duplicated columns still present
- new `card_prints` rows
- new `deck_allocations` rows

So storage will likely go up first, then go down after old columns and compatibility data are removed.

## Rough Size Direction

Without exact row counts, only directional estimates are responsible.

### Current model

Each user-owned card row may repeat:

- name
- set code
- collector number
- possibly other print metadata

Each `deck_cards` row also repeats:

- name
- set
- collector number
- type line
- mana cost
- color identity
- image URI

That means the same printing metadata can be stored:

- once in `cards` for many users
- once again in `deck_cards` for many decks

### After normalization

That print metadata is stored once in `card_prints`, and user tables mostly store:

- foreign keys
- qty
- state flags
- user-specific attributes

### Expected size effect

- small user base: little difference
- medium user base: noticeable savings
- large user base with many decks: meaningful savings

The more users and the more deck rows you have, the more normalization pays off.

## Expected Size Tradeoff By Table

### `cards`

- likely smaller after cleanup

### `deck_cards`

- likely much smaller after cleanup because this table currently repeats the most shared metadata

### `card_prints`

- new table, but far smaller than the duplicated storage it replaces once user count grows

### `deck_allocations`

- new table, so some growth is expected
- but this growth represents a real product concept you currently express less cleanly elsewhere

## Recommendation On Size And Scope

If you want to do one major migration only, I would support this combined target:

- normalize shared print metadata into `card_prints`
- make `deck_cards` the only deck composition source
- add `deck_allocations`
- keep `folder_cards` for owned placement only

That is the best long-term model.

But it should be implemented with:

- staged backfills
- compatibility columns during transition
- read-optimized views for hot screens

Otherwise the migration risk is too high.

## Final Recommendation

My recommendation is to do the structural cleanup and normalization in the same migration, but only with a staged rollout inside that migration plan.

### Recommended target

Adopt this target model:

- `card_prints` as the shared print metadata table
- `cards` as owned inventory referencing `card_prints`
- `deck_cards` as the only source of truth for intended deck composition
- `deck_allocations` as owned fulfillment of planned decks
- `folder_cards` for owned placement only
- `card_prices` and `card_hashes` kept as shared/global tables

### Why this is my recommendation

It is the best long-term fit for the product because it cleanly separates:

- shared print identity
- ownership
- folder placement
- planned deck contents
- owned deck fulfillment

It also avoids doing:

1. one migration now to clean up deck semantics
2. another migration later to normalize print metadata

If the team is already willing to do a real migration, it is more efficient to land on the right model once.

### Conditions for this recommendation

This one-pass normalized upgrade should include:

- backfill in stages
- temporary compatibility columns during transition
- SQL views or RPCs for read-heavy screens
- explicit rollback checkpoints during deployment

These are not optional safeguards. They are part of the recommended process.

## One-Pass Migration Process

The migration should be treated as one target-state upgrade with controlled internal stages, not as a fallback-driven transition.

### Stage 1. Expand schema

Add new structures first:

- `card_prints`
- `deck_allocations`
- `cards.card_print_id`
- `deck_cards.card_print_id`

Keep existing columns and existing app behavior running during this stage.

### Stage 2. Backfill canonical identities

Populate `card_prints` from all distinct known print identities.

Then backfill:

- `cards.card_print_id`
- `deck_cards.card_print_id`

Validation checks:

- every `cards` row has a valid `card_print_id`
- every `deck_cards` row has a valid `card_print_id`
- no orphan references

### Stage 3. Backfill deck truth

Backfill all deck composition into `deck_cards` so every deck has a single authoritative composition source before application code is switched.

Validation checks:

- every deck has expected card counts in `deck_cards`
- old `folder_cards`-derived deck totals match migrated `deck_cards` totals
- commanders and board assignments are preserved where applicable

### Stage 4. Introduce read models

Before changing the application, create read-optimized SQL views or RPCs for:

- owned collection cards
- deck cards with print metadata
- deck completion / allocation summary

This ensures the app switches to the new model without becoming join-heavy in the client.

### Stage 5. Switch application reads and writes atomically by feature area

Switch in this order:

1. Deck Builder reads
2. Deck View reads
3. Sync logic writes to `deck_allocations`
4. Collection placement logic remains on `folder_cards`

At the end of this stage:

- deck composition reads only from normalized `deck_cards` read models
- sync writes only to `deck_allocations`
- no deck screen depends on `folder_cards` as content truth

### Stage 6. Lock old write paths

After the new code is deployed and validated:

- stop all deck-content writes to legacy paths
- enforce constraints that keep `deck_cards` authoritative

Validation checks:

- no new deck composition rows are being inferred from `folder_cards`
- sync operations no longer mutate deck truth indirectly

### Stage 7. Remove duplicated legacy metadata

Only after the application is fully switched:

- drop duplicated print metadata columns from `cards`
- drop duplicated print metadata columns from `deck_cards`
- remove old deck fallback logic entirely from code

### Stage 8. Optional cleanup of historical deck-related folder placements

If deck-related `folder_cards` rows are no longer needed:

- archive or delete those historical rows

Do this only after confirming no reporting, export, or legacy screen still depends on them.

## One-Pass Migration Quality Bar

The migration should not be considered complete until all of the following are true:

- deck composition has one source of truth
- ownership has one source of truth
- allocation has one source of truth
- print metadata has one source of truth
- app read paths use normalized storage through stable read models
- no compatibility fallback remains in application logic

## Detailed Upgrade Plan

### Phase 0. Preparation

1. Freeze the target semantics in code comments and docs.
2. Document current readers and writers of:
   - `deck_cards`
   - `folder_cards`
   - `folders.type in ('deck', 'builder_deck')`
3. Add instrumentation if needed to confirm which code paths still rely on `folder_cards` for deck composition.

Deliverable:

- written mapping of every deck read/write path before schema migration

### Phase 1. Add the new allocation layer

Add `deck_allocations` without removing anything yet.

Suggested constraints:

- `qty >= 1`
- `unique (deck_id, card_id)` if one owned card row should appear once per deck

Suggested indexes:

- `deck_allocations_deck_id_idx`
- `deck_allocations_card_id_idx`
- `deck_allocations_user_id_idx`

Suggested RLS:

- same ownership rule pattern as `cards` / `deck_cards`

Goal of this phase:

- introduce the correct representation for owned fulfillment without breaking the current app

### Phase 2. Make `deck_cards` authoritative for all decks

Tasks:

1. Backfill `deck_cards` for any existing collection decks currently represented only through `folder_cards`.
2. Ensure every deck-related screen reads planned contents from `deck_cards` only.
3. Remove runtime fallback that loads planned deck contents from `folder_cards`.
4. Keep `folder_cards` data temporarily if older screens still need it during rollout, but stop treating it as deck composition truth.

Data migration rule:

- if a folder is a deck and only has `folder_cards`, create corresponding `deck_cards`
- preserve qty
- infer card metadata from linked `cards` rows where needed

Goal of this phase:

- one read model for deck contents

### Phase 3. Move sync logic to `deck_allocations`

Current workflow:

- user builds a deck in builder
- sync moves owned cards under that deck

Target workflow:

- sync compares `deck_cards` to owned `cards`
- sync writes owned matches into `deck_allocations`
- binders/lists remain in `folder_cards`

Rules:

- allocation never changes the intended decklist
- allocation only affects fulfillment state
- unowned cards remain visible in the deck because they stay in `deck_cards`

This phase should also define allocation policy:

- exact printing first
- optionally fallback to alternate owned printing
- never allocate more owned copies than available

### Phase 4. Update reads for performance

After `deck_cards` and `deck_allocations` are in place:

1. Deck Builder load path:
   - query `deck_cards` for deck composition
   - query `deck_allocations` for owned fulfillment
   - query owned inventory summary only when needed for badges and sync preview
2. Deck View load path:
   - query `deck_cards` only for visible deck composition
   - optionally query allocation summary for completion indicators
3. Collection / Binders / Lists:
   - keep using `cards` + `folder_cards`

Performance outcome:

- remove deck fallback query path
- reduce conditional reconciliation logic on open
- simplify local cache behavior

### Phase 5. Deprecate deck use of `folder_cards`

Once all deck screens use `deck_cards` + `deck_allocations`:

1. Stop creating new deck composition rows in `folder_cards`
2. Stop reading `folder_cards` as deck content
3. Retain historical rows only until migration confidence is high
4. Optionally delete or archive deck-related `folder_cards` rows later

Important:

- do not remove `folder_cards` entirely; it still has value for binder/list placement

### Phase 6. Optional normalization later

Only after deck semantics are stable, consider introducing a shared print reference table such as `card_prints`.

This is optional and not the first recommended step.

Potential future model:

- `card_prints`
  - shared print metadata keyed by `scryfall_id`
- `cards`
  - owned row references `card_prints`
- `deck_cards`
  - deck entry references `card_prints`
- `card_prices`
  - already aligns naturally to print identity

Why later:

- this improves consistency and storage efficiency
- but it may increase join complexity and migration risk
- it is less likely to produce immediate app speed wins than unifying deck storage

## App-Level Code Changes Needed

### Read paths

- remove deck fallback from `folder_cards`
- update deck pages to rely on `deck_cards`
- add allocation reads where owned fulfillment is shown

### Write paths

- adding/removing deck cards updates `deck_cards` only
- sync writes `deck_allocations`
- binder/list placement continues using `folder_cards`

### Cache changes

- separate local caching for:
  - deck composition
  - deck allocations
  - owned inventory

### UI semantics

Deck screens should clearly distinguish:

- in decklist
- owned
- allocated to this deck
- owned elsewhere / free / missing

## Expected Positives

### Performance

- one canonical deck-content load path
- fewer fallback queries
- less client-side migration logic on screen load
- simpler caching strategy

### Correctness

- intended deck and owned fulfillment are clearly separated
- fewer inconsistent deck states
- easier to reason about sync behavior

### Product fit

- fully supports building decks from unowned cards
- fully supports syncing owned cards into decks
- easier to add deck-completion and missing-card features

### Maintainability

- fewer special cases
- easier migrations later
- clearer table responsibilities

## Expected Negatives

### Migration cost

- requires data backfill
- requires touching multiple deck screens and sync flows
- requires careful rollout to avoid breaking existing deck data

### More tables

- adding `deck_allocations` increases conceptual complexity
- developers must understand the distinction between intent and ownership fulfillment

### Some duplication remains

- `deck_cards` may still keep denormalized card metadata for fast reads
- this is a deliberate tradeoff, not a fully normalized design

## What Not To Change First

Do not start by fully normalizing all card metadata into shared reference tables.

Reason:

- it is a larger migration
- it adds join complexity
- it is less likely to produce the most visible performance win immediately

The first meaningful upgrade is to cleanly separate:

- deck intent
- owned allocation
- folder placement

## Recommended Execution Order

1. Add `deck_allocations`
2. Backfill `deck_cards` for every deck
3. Remove `folder_cards` fallback from deck screens
4. Move sync logic to `deck_allocations`
5. Decommission deck-related writes to `folder_cards`
6. Consider deeper normalization only later if scale demands it

## Success Criteria

The upgrade is successful when:

- every deck screen loads composition from `deck_cards` only
- syncing owned cards no longer depends on `folder_cards` as deck truth
- users can still build unowned decks
- users can still sync owned cards into those decks
- deck load logic is simpler and faster
- binder/list behavior remains unchanged

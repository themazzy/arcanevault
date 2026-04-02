# Post-Migration Validation

Run [verify_post_migration.sql](C:/Users/Jan/Desktop/arcanevault/arcanevault/supabase/verify_post_migration.sql) first in Supabase SQL Editor, then use this checklist for product-level validation.

## Database Checks

Expected outcomes from the SQL script:

- `card_prints`, `deck_allocations`, `owned_cards_view`, `deck_cards_view`, and `deck_allocations_view` all exist.
- `cards_missing_card_print_id` is `0` or only contains rows with null `scryfall_id`.
- `deck_cards_missing_card_print_id` is `0` or only contains rows with null `scryfall_id`.
- duplicate `card_prints.scryfall_id` rows are `0`.
- orphan checks are all `0`.
- `deck_allocations` should only point to folders where `type = 'deck'`.

Watch closely:

- The "legacy deck-content rows still living in `folder_cards`" query may still return rows if old data exists. That is not an immediate blocker, but new deck behavior should stop depending on those rows.

## Product Checks

Use a test account with:

- at least one owned collection card
- at least one builder deck
- at least one collection deck
- at least one card not owned but present in a builder deck

### 1. Collection screen

- Collection loads without errors.
- Cards allocated to a deck still show deck folder tags in collection.
- Filtering by location = deck still returns cards allocated to decks.

### 2. Builder screen

- Builder deck opens without "deck not found" or empty-load regressions.
- Existing decks show cards from `deck_cards_view`.
- Commander and non-commander rows still render correctly.
- Owned badges still distinguish:
  - owned and free
  - owned in another deck
  - different version owned

### 3. Sync flow

- Open a deck with some owned cards and some missing cards.
- Run sync.
- Confirm owned cards become allocated to that deck.
- Confirm missing cards can still be added to a wishlist.
- Remove a card from the deck and sync again.
- Confirm it is unallocated from the deck but still remains in collection ownership.

### 4. Make Collection Deck

- Convert a builder deck into a collection deck.
- Confirm the folder type changes to `deck`.
- Confirm owned cards become deck allocations.
- Confirm the deck remains visible in deck views and collection tags.

### 5. Deck browser

- Open a collection deck from the Decks page.
- Confirm the deck browser shows allocated owned cards.
- Delete or reduce quantity of an allocated card.
- Confirm allocation quantity changes correctly.
- Move a selected card from one deck to another deck.
- Confirm the allocation moves.
- Move a selected card from a deck to a binder.
- Confirm it leaves `deck_allocations` and appears in `folder_cards`.

### 6. Add card modal

- Add an owned card directly into a deck.
- Confirm it creates or updates a `deck_allocations` row.
- Add an owned card into a binder.
- Confirm binder placement still uses `folder_cards`.

### 7. Import flows

- Import into a binder and confirm `folder_cards` are created.
- Import into a deck and confirm `deck_allocations` are created instead of `folder_cards`.
- Import into a wishlist and confirm `list_items` still work.

### 8. Shared deck view

- Open a deck through the share/view route.
- Confirm deck contents load from `deck_cards_view`.
- Copy the deck to your own account.
- Confirm copied cards still land in `deck_cards`.

## Known Risk Areas To Check Manually

### Builder folder type naming

The repo still contains mixed references to builder deck folder types:

- some places use `builder`
- some places use `builder_deck`

This predates the migration and should be checked manually:

- builder list page
- life tracker deck picker
- join game deck picker
- any flow that creates a new builder deck

If you see decks disappearing from one screen but not another, this is the first thing to inspect.

### Legacy deck rows in `folder_cards`

If old deck rows remain in `folder_cards`, collection tags may still look correct even if some old data has not been cleaned up yet. That is acceptable during validation, but new operations should be writing to:

- `deck_cards` for intended deck composition
- `deck_allocations` for owned deck fulfillment

## Sign-off Criteria

The migration can be considered successful when:

- SQL integrity checks are clean
- deck screens no longer depend on `folder_cards` for deck composition
- owned cards remain in collection after deallocation from a deck
- deck allocations appear correctly in collection and deck views
- binder and wishlist flows remain unchanged
- import and add-card flows use the correct destination table by folder type

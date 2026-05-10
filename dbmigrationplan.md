# DeckLoom DB Migration Plan — Remaining Work

## Status update 2026-05-10

Phase 5, Phase 6.1 compatibility work, and Phase 6.2 option B are now complete
in Supabase and app code.

- `20260510192825_restore_security_invoker_views.sql` re-applied
  `security_invoker = true` to the four print metadata views after the Phase
  5d view rebuilds had accidentally reverted them to SECURITY DEFINER behavior.
- `20260510193018_phase5d_drop_redundant_print_columns_reconcile.sql` dropped
  the redundant print metadata columns from `cards`, `deck_cards`, and
  `list_items` against the live schema while preserving the current inner-join
  view definitions.
- `src/pages/DeckBuilder.jsx` no longer sends denormalized print metadata in
  remaining `deck_cards.update(...)` paths.
- Verification: production schema has no remaining `scryfall_id`, `name`,
  `set_code`, `collector_number`, `type_line`, `mana_cost`, `cmc`,
  `color_identity`, or `image_uri` columns on those base tables; the four views
  all report `security_invoker=true`; `npm run build` passes.
- `20260510194405_fix_get_public_profile_after_phase5d.sql` fixed the public
  profile RPC after Phase 5d by reading print identity from `card_prints`
  instead of dropped `cards.*` metadata columns.
- `20260510194548_user_settings_archive_background_jsonb.sql` added and
  backfilled `user_settings.archive_background`; the legacy split columns are
  intentionally retained until the updated frontend is deployed everywhere.
- `20260510194632_remove_card_prices_stage.sql` removed `card_prices_stage`
  and `publish_card_prices`; `scripts/sync-card-prices.mjs` now writes directly
  to `card_prices`.
- `20260510195316_fix_get_my_decks_after_phase5d.sql` and
  `20260510195606_fix_public_deck_rpcs_after_phase5d.sql` fixed the deck RPCs
  that still read removed print metadata columns after Phase 5d.

Remaining work is the deferred `pgcrypto` extension move, a follow-up migration
to drop the legacy `archive_background_*` columns after deployment, and advisor
review. Current advisor state still includes intentional/security-reviewed
SECURITY DEFINER RPC warnings, `pgcrypto` in `public`, leaked-password
protection disabled, and low-priority performance INFO lints.

Captured 2026-05-08 after Phases 1–4 shipped. This file holds the deferred phases.

## What's already done

| Phase | Migration file | Effect |
|---|---|---|
| 1 | `20260508120000_phase1_security_lockdown.sql` | `REVOKE EXECUTE … FROM PUBLIC` on all DEFINER fns; re-`GRANT` to correct roles. Drop `card_schema_migration_audit`. Add deny-all policy to `card_prices_stage`. |
| 2 | `20260508130000_phase2_rls_initplan_and_dedup.sql` | Wrap `auth.uid()` in `(select …)` across every policy; consolidate overlapping permissive policies on app_config, deck_cards, feedback, feedback_attachments, folders, shared_folders, user_settings. |
| 3 | `20260508140000_phase3_index_hygiene.sql` | Drop 8 unused indexes; add 9 covering FK indexes; REINDEX `card_prices_stage` (47 MB → 8 kB). |
| 4 | `20260508150000_phase4_drop_dead_card_hashes_columns.sql` | Drop `card_hashes.hash_part_1..4` (BIGINT precision was lossy; client only reads `phash_hex`). Companion edits to `scripts/generate-card-hashes.js`. |

Cleared ~82 of the original 87 advisor lints. Combined index reclaim: ~66 MB.

---

## Phase 5 — Print metadata deduplication

The biggest savings (~30-40 % row width on `deck_cards`, eliminates a known
nested-select footgun), but it's also the only phase that needs app changes.

### 5a. Pre-flight ✅ DONE (2026-05-08)

- All `cards`, `deck_cards`, `list_items` rows have `card_print_id` populated.
- Zero drift across `scryfall_id`, `set_code`, `collector_number`, `name` between local denormalized cols and `card_prints` join target.

### 5b. Compatibility views ✅ ALREADY EXIST

The views are already in place from prior work — they `COALESCE(cp.col, base.col)` so they work in both the pre-drop and post-drop world:

- `owned_cards_view` — exposes `cards` joined with `card_prints`. Adds `type_line, mana_cost, cmc, color_identity, image_uri, art_crop_uri`.
- `deck_cards_view` — exposes `deck_cards` joined with `card_prints`. Used by `src/lib/deckData.js`, `src/pages/Profile.jsx`, `src/pages/Stats.jsx`, `src/lib/deckArt.js`.
- `list_items_view` — exposes `list_items` joined with `card_prints`.
- `deck_allocations_view` — exposes `deck_allocations` joined with `cards` + `card_prints`.

After 5d these views become pure passthroughs (the `COALESCE(cp.col, base.col)` collapses to `cp.col` because `base.col` is gone).

### 5c. Switch reads from base tables to views ✅ DONE (2026-05-10)

Current state: metadata reads that need `name`, `set_code`, `collector_number`,
`scryfall_id`, image fields, or deck/list print metadata use the corresponding
`*_view`. Base tables are still used for writes and ownership-only reads.

Historical note from the first attempt is kept below for context.

**Note (2026-05-08):** A first attempt at 5c was applied and reverted. Switching
collection-scale reads (`fetchCollectionCards`, Collection page, Trading,
Home, Lists) to the COALESCE views introduced a JOIN against `card_prints`
(119 k rows) on every read, plus changed row shape (extra `image_uri` /
`art_crop_uri` cols from `card_prints`). This caused:

- Trading page taking 20-30 s to save a trade (full collection re-fetch).
- Continuous 200-460 ms message-handler / click-handler violations.
- Mixed row shapes between view-loaded rows and `.upsert(...).select(...)`
  rows from base tables → image rendering paths read different fields → new
  cards rendered without art until a manual refresh. IDB cache shape diff
  also defeated the React Query refetch-on-refresh logic.

**Re-do plan:** roll 5c into the same atomic PR as 5d (write-payload cleanup
+ column drop). Once the denorm cols are gone from base tables, the views
become pure passthroughs; we can also rebuild them as `SELECT cp.col …`
without `COALESCE`, eliminating the runtime overhead. At that point the
shape-mismatch class of bugs is impossible because the base tables don't
expose the cols at all.

Until that combined PR is ready, all reads stay on base tables.

Read sites that still pull denormalized columns from base tables — must move to the corresponding `_view`:

**`src/lib/collectionFetchers.js`**
- `fetchCollectionCards` — `from('cards').select('*')` → `from('owned_cards_view').select('*')`. This is the React Query backbone; change here propagates through `idbQueryBridge.hydrateCollectionQueriesFromIdb`.

**`src/pages/Collection.jsx`** (~6 sites at L489, L864, L874 etc.)
- Selects of name/set/scryfall → switch to `owned_cards_view`.
- Pure ID-based updates/deletes (`update({qty}).eq('id', …)`, `delete().in('id', …)`) **stay** on the base table — views are not updateable.

**`src/pages/Home.jsx`** (L62, L131)
- Both are `from('cards').select(…)` reading name/set → switch to `owned_cards_view`.

**`src/pages/Trading.jsx`** (L573)
- `from('cards').select(…)` → `owned_cards_view`.

**`src/pages/Share.jsx`** (L55)
- `from('cards').select(…)` → `owned_cards_view`.

**`src/pages/DeckBuilder.jsx`** (L2123)
- `.from('cards')` reading print metadata → `owned_cards_view`.

**`src/pages/Lists.jsx`** (L268, L280, L470, L986, L1099)
- Selects from `list_items` reading metadata → `list_items_view`.
- Deletes/updates by id stay on base table.

**`src/components/AddCardModal.jsx`** (L416, L470, L494)
- Existence checks reading metadata → switch to view; pure inserts/updates stay on base.

**`src/lib/deckBuilderWrites.js`** (L89, L112, L136, L157)
- Reads → views. Writes → base tables (existing behavior is correct, just verify).

**`src/scanner/CardScanner.jsx`** (L238)
- `from('cards')` existence check by scryfall/set/collector → switch to `owned_cards_view`.

**Already correct** (no change needed):
- `src/lib/deckData.js`, `src/pages/Profile.jsx`, `src/pages/Stats.jsx`, `src/lib/deckArt.js`, `src/components/deckBuilder/SyncModal.jsx` already use `_view` suffix.

**Out of scope** (writes — views are not updateable):
- Every `sb.from('cards').update(…)` / `.insert(…)` / `.delete(…)`
- Every `sb.from('deck_cards').update/insert/delete`
- Every `sb.from('list_items').update/insert/delete`

These keep their base-table targets. The dropped columns are denormalized metadata (`name, set_code, scryfall_id, …`); writes only touch ownership cols (`qty, foil, condition, purchase_price, …`) so they're unaffected by 5d.

**QA checklist for 5c PR:**
- [ ] Collection page renders cards with names/sets/images.
- [ ] Home dashboard "recently viewed" tiles render.
- [ ] Trading page matches against owned cards.
- [ ] Public share link `/share/:token` renders.
- [ ] Deck Builder card lookup still finds owned printings.
- [ ] Wishlist (Lists) page renders rows with metadata.
- [ ] AddCardModal duplicate detection still works.
- [ ] Scanner "match against owned" toggle still works.
- [ ] No console errors about missing columns.

### 5d. Drop redundant columns + strip write payloads ✅ DONE (2026-05-10)

Current state: write helpers strip denormalized metadata, the remaining
DeckBuilder update paths were patched, live Supabase has dropped the redundant
columns, and the print metadata views are inner joins with
`security_invoker=true`.

The original implementation notes are kept below for audit context.

**Why coordinated:** `cards.name`, `cards.set_code`, `deck_cards.name`, `list_items.name`
are all `NOT NULL` in the current schema. Stripping these from `INSERT` /
`UPSERT` payloads before they're dropped would violate the constraint. Dropping
the columns while the client still writes them produces "column does not exist"
errors. So 5d is one PR with: code change + migration applied together.

**Code changes needed (write-side cleanup):**

1. `src/lib/deckBuilderWrites.js` — `DECK_CARD_DB_COLS` set: remove
   `scryfall_id, name, set_code, collector_number, type_line, mana_cost, cmc,
   color_identity, image_uri`. After this, `toDeckCardRow` only emits
   ownership cols (id, deck_id, user_id, qty, foil, is_commander, board,
   created_at, updated_at, card_print_id, category_id).

2. `src/components/AddCardModal.jsx` (L424-L427, L478-L482, L501) — when building
   `cards` upsert payload, drop `name, set_code, collector_number, scryfall_id`
   from `withCardPrint(...)` output. Rely on `card_print_id` only.

3. `src/components/AddCardModal.jsx` (L424-L427) — same for `list_items` upsert
   payload (drop `name, set_code, collector_number, scryfall_id`).

4. `src/scanner/CardScanner.jsx` (L223 area, L268 area) — same.

5. `src/pages/Collection.jsx` (L860-L865 import path, L918) — strip from
   `cards` and `list_items` upsert batches.

6. `src/pages/DeckBuilder.jsx` — verify the various deck_cards inserts use
   `toDeckCardRow()` (which becomes ownership-only after step 1).

7. `src/lib/cardPrints.js` — `withCardPrint()` currently injects the denorm
   fields onto rows. Adjust to only inject `card_print_id` once writes don't
   need them.

8. `.upsert(...).select('id,user_id,name,...')` chains in
   `AddCardModal.jsx`, `deckBuilderWrites.js` — shrink select to ownership
   cols (callers should already have name/set_code from the input row).

**Migration SQL** (apply in same PR):

```sql
-- supabase/migrations/2026XXXXXXXXXX_phase5d_drop_redundant_print_columns.sql

-- Drop dependent indexes first:
drop index if exists public.cards_scryfall_id_idx;
drop index if exists public.cards_name_idx;
drop index if exists public.cards_set_code_idx;
drop index if exists public.deck_cards_scryfall_id_idx;

-- Cards: 4 columns, ~11.9k rows
alter table public.cards
  drop column scryfall_id,
  drop column name,
  drop column set_code,
  drop column collector_number;

-- Deck cards: 9 columns, ~2.9k rows (biggest savings — ~40% row width)
alter table public.deck_cards
  drop column scryfall_id,
  drop column name,
  drop column set_code,
  drop column collector_number,
  drop column type_line,
  drop column mana_cost,
  drop column cmc,
  drop column color_identity,
  drop column image_uri;

-- List items: 4 columns, ~144 rows
alter table public.list_items
  drop column scryfall_id,
  drop column name,
  drop column set_code,
  drop column collector_number;
```

**QA checklist for 5d PR:**
- [ ] Add cards via AddCardModal → owned, binder, deck, wishlist destinations.
- [ ] Scanner → "+ Add to Collection" still saves with set_code resolved via card_prints.
- [ ] CSV import still creates cards + folder placements (Collection.jsx import path).
- [ ] Deck Builder: add card, change version, change qty, set commander, move board.
- [ ] Edit card details (purchase price, condition) in CardComponents — UPDATE only touches ownership cols, should be unaffected.
- [ ] Collection sync round-trip: refresh page, all cards re-render with names/sets.
- [ ] Linked-deck sync (Sync Changes modal) still aligns builder ↔ collection.
- [ ] No "column does not exist" or "violates not-null constraint" errors anywhere.

After this the views become pure passthroughs (the `COALESCE` reduces to `cp.col`). Optional follow-up: `CREATE OR REPLACE VIEW` to drop the now-redundant `COALESCE` for cleanliness.

**Left alone deliberately:**

- `card_hashes` denormalized cols (`name, set_code, collector_number, oracle_id, image_uri, art_crop_uri`) — table has no `card_print_id` FK; adding one needs nullable handling for prints that never reach `card_prints`. Defer indefinitely.
- `card_prices.set_code` / `card_prices.collector_number` — `card_prices_set_collector_snapshot_idx` is hit 3.9 M times. Removing requires a different access path. Skip for now.

---

## Phase 6 — Settings & staging cleanup

Low-risk hygiene work; no urgency.

### 6.1 Consolidate `user_settings.archive_background_*` columns ✅ COMPAT DONE (2026-05-10)

`archive_background` jsonb exists and is backfilled. The app writes the new
jsonb column while continuing to expose the existing flat setting keys to React
components. The old split columns remain temporarily for backward compatibility
with the currently deployed frontend. Follow-up after deployment: drop
`archive_background_mode`, `archive_background_cards`,
`archive_background_seed`, `archive_background_locked`,
`archive_background_collection_source`, `archive_background_blur`,
`archive_background_saturation`, and `archive_background_opacity`.

7 columns (`mode, cards, seed, locked, collection_source, blur, saturation, opacity`) → 1 jsonb. Same row, simpler migrations going forward.

```sql
alter table public.user_settings add column archive_background jsonb;

update public.user_settings set archive_background = jsonb_build_object(
  'mode',              archive_background_mode,
  'cards',             archive_background_cards,
  'seed',              archive_background_seed,
  'locked',            archive_background_locked,
  'collection_source', archive_background_collection_source,
  'blur',              archive_background_blur,
  'saturation',        archive_background_saturation,
  'opacity',           archive_background_opacity
);
```

Then ship app code that reads `archive_background.mode` etc. (touch points: `src/components/SettingsContext.jsx`, archive theme renderers). After app deploy, drop the 7 old columns.

### 6.2 `card_prices_stage` ✅ DONE (2026-05-10, option B)

`scripts/sync-card-prices.mjs` now writes directly to `card_prices`; the
`card_prices_stage` table and `publish_card_prices(date,date)` function are
dropped.

- **(A) Keep, schedule cleanup.** Add a `pg_cron` job: `REINDEX TABLE card_prices_stage; VACUUM FULL card_prices_stage;` weekly. Preserves the atomic publish boundary.
- **(B) Remove.** Switch the price-publish edge function (which writes via `service_role`) to `INSERT INTO card_prices … ON CONFLICT (scryfall_id, snapshot_date) DO UPDATE SET …` directly. Drop `card_prices_stage` table afterwards.

Recommendation: **(B)** — atomic swap doesn't appear load-bearing (table sat at 0 rows during normal ops), and it removes a maintenance surface.

---

## Bonus — Move `pgcrypto` out of `public` schema

Deferred from Phase 1: 36 objects depend on `pgcrypto`, and the `shared_folders.public_token` default expression uses unqualified `gen_random_bytes(16)` which only resolves via the `extensions` schema for the `postgres` role.

Steps:

1. Confirm `extensions` schema exists (it does).
2. Rewrite the default expression to fully-qualify:
   ```sql
   alter table public.shared_folders
     alter column public_token set default encode(extensions.gen_random_bytes(16), 'hex');
   ```
3. Audit any other call sites: `grep -ri "gen_random_bytes\|crypt\|digest\|hmac\|gen_salt\|encrypt" supabase/migrations` and qualify each.
4. Move the extension:
   ```sql
   alter extension pgcrypto set schema extensions;
   ```
5. Verify: `INSERT INTO public.shared_folders (folder_id) VALUES (…)` still populates `public_token` from any role.

Clears the `extension_in_public` advisor.

---

## Suggested cadence for resuming

1. Deploy the updated frontend.
2. Drop the legacy `archive_background_*` columns after the deployment is live.
3. **Bonus** — `pgcrypto` move.
4. Review the remaining SECURITY DEFINER RPC advisor warnings and either document them as intentional public RPCs or move/rewrite any that no longer need elevated privileges.
5. Decide whether the remaining performance INFO lints are worth acting on; several are low-traffic FK indexes or freshly added indexes with no usage history yet.

After all phases: schema is materially smaller, no stale audit/staging tables, RLS evaluates once per query, every critical FK is indexed, and the remaining advisor warnings are either fixed or explicitly accepted.

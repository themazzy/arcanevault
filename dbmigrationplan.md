# DeckLoom DB Migration Plan — Remaining Work

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

### 5c. Switch reads from base tables to views ⏳ TODO (app PR)

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

### 5d. Drop the redundant base-table columns ⏳ TODO (after 5c is in production for ~1 week)

```sql
-- supabase/migrations/2026XXXXXXXXXX_phase5d_drop_redundant_print_columns.sql
-- After 5c has shipped and run cleanly. PITR is the rollback path.

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

After this the views become pure passthroughs (the `COALESCE` reduces to `cp.col`). Optional follow-up: `CREATE OR REPLACE VIEW` to drop the now-redundant `COALESCE` for cleanliness.

**Left alone deliberately:**

- `card_hashes` denormalized cols (`name, set_code, collector_number, oracle_id, image_uri, art_crop_uri`) — table has no `card_print_id` FK; adding one needs nullable handling for prints that never reach `card_prints`. Defer indefinitely.
- `card_prices.set_code` / `card_prices.collector_number` — `card_prices_set_collector_snapshot_idx` is hit 3.9 M times. Removing requires a different access path. Skip for now.

---

## Phase 6 — Settings & staging cleanup

Low-risk hygiene work; no urgency.

### 6.1 Consolidate `user_settings.archive_background_*` columns

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

### 6.2 `card_prices_stage` — pick (A) or (B)

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

1. **Phase 5c PR** — open as its own branch. Run the dev server, walk the QA checklist above. Ship.
2. **Wait ~1 week of clean prod.** Watch for unusual errors in the cards/decks/lists pages.
3. **Phase 5d migration** — drops the redundant columns. PITR rollback if needed.
4. **Phase 6.1** — `archive_background` jsonb consolidation. Bundles a small app PR.
5. **Phase 6.2** — `card_prices_stage` decision; ideally option B.
6. **Bonus** — `pgcrypto` move.

After all phases: schema is materially smaller, no stale audit/staging tables, RLS evaluates once per query, every FK is indexed, security advisors green.

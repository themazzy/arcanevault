-- Phase 5d-finalize — drop redundant denormalized print columns and rebuild
-- the affected views (2026-05-08).
--
-- Pre-flight (already verified before applying this migration):
--   - All cards/deck_cards/list_items rows have a non-null card_print_id.
--   - Zero rows reference card_prints with null name/set_code (verified via
--     LEFT JOIN counts, all zero).
--   - Phase 5d-prep migration dropped the matching NOT NULL constraints.
--   - Phase 5d-code shipped: write payloads no longer include these columns,
--     and metadata reads are routed through *_view.
--
-- After this migration, card_prints is the sole source of truth for
-- name/set_code/scryfall_id/collector_number/type_line/mana_cost/cmc/
-- color_identity/image_uri. Drift is structurally impossible.

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 1. Drop dependent views                                                  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

drop view if exists public.owned_cards_view;
drop view if exists public.deck_cards_view;
drop view if exists public.list_items_view;
drop view if exists public.deck_allocations_view;

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 2. Drop indexes that reference soon-to-be-dropped columns                ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

drop index if exists public.cards_name_idx;
drop index if exists public.cards_scryfall_id_idx;
drop index if exists public.cards_set_code_idx;
drop index if exists public.deck_cards_scryfall_id_idx;

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 3. Drop redundant columns                                                ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- cards: 4 columns × ~11.9k rows
alter table public.cards
  drop column scryfall_id,
  drop column name,
  drop column set_code,
  drop column collector_number;

-- deck_cards: 9 columns × ~2.9k rows (largest savings — ~40% row width)
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

-- list_items: 4 columns × ~144 rows
alter table public.list_items
  drop column scryfall_id,
  drop column name,
  drop column set_code,
  drop column collector_number;

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 4. Recreate views — pure passthroughs from card_prints                   ║
-- ║    (no more COALESCE since the base-table fallback no longer exists).    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

create view public.owned_cards_view as
select
  c.id,
  c.user_id,
  c.card_print_id,
  cp.scryfall_id,
  cp.name,
  cp.set_code,
  cp.collector_number,
  c.qty,
  c.foil,
  c.condition,
  c.language,
  c.purchase_price,
  c.currency,
  c.misprint,
  c.altered,
  c.added_at,
  c.updated_at,
  cp.type_line,
  cp.mana_cost,
  cp.cmc,
  coalesce(cp.color_identity, '{}'::text[]) as color_identity,
  cp.image_uri,
  cp.art_crop_uri
from public.cards c
left join public.card_prints cp on cp.id = c.card_print_id;

create view public.deck_cards_view as
select
  dc.id,
  dc.deck_id,
  dc.user_id,
  dc.card_print_id,
  cp.scryfall_id,
  cp.name,
  cp.set_code,
  cp.collector_number,
  cp.type_line,
  cp.mana_cost,
  cp.cmc,
  coalesce(cp.color_identity, '{}'::text[]) as color_identity,
  cp.image_uri,
  cp.art_crop_uri,
  dc.qty,
  dc.foil,
  dc.is_commander,
  dc.board,
  dc.created_at,
  dc.updated_at,
  dc.category_id
from public.deck_cards dc
left join public.card_prints cp on cp.id = dc.card_print_id;

create view public.list_items_view as
select
  li.id,
  li.folder_id,
  li.user_id,
  li.card_print_id,
  cp.scryfall_id,
  cp.name,
  cp.set_code,
  cp.collector_number,
  li.foil,
  li.qty,
  li.added_at,
  cp.type_line,
  cp.mana_cost,
  cp.cmc,
  coalesce(cp.color_identity, '{}'::text[]) as color_identity,
  cp.image_uri,
  cp.art_crop_uri
from public.list_items li
left join public.card_prints cp on cp.id = li.card_print_id;

create view public.deck_allocations_view as
select
  da.id,
  da.deck_id,
  da.user_id,
  da.card_id,
  da.qty,
  da.created_at,
  da.updated_at,
  c.card_print_id,
  cp.scryfall_id,
  cp.name,
  cp.set_code,
  cp.collector_number,
  c.foil,
  c.condition,
  c.language,
  cp.type_line,
  cp.mana_cost,
  cp.cmc,
  coalesce(cp.color_identity, '{}'::text[]) as color_identity,
  cp.image_uri,
  cp.art_crop_uri
from public.deck_allocations da
join public.cards c on c.id = da.card_id
left join public.card_prints cp on cp.id = c.card_print_id;

-- Re-grant select on the recreated views to anon (public read for shared
-- decks) and authenticated (everywhere else). RLS on the underlying tables
-- still enforces row-level access.
grant select on public.owned_cards_view to anon, authenticated;
grant select on public.deck_cards_view to anon, authenticated;
grant select on public.list_items_view to anon, authenticated;
grant select on public.deck_allocations_view to anon, authenticated;

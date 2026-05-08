-- Phase 5d follow-up — fix owned_cards_view perf regression (2026-05-08).
--
-- Symptom: REST queries against owned_cards_view (and the other *_view
-- definitions) sometimes timed out (8s authenticated statement_timeout)
-- after a CSV import. EXPLAIN ANALYZE showed a Hash Right Join with a
-- Seq Scan over the full 119k card_prints (3+s), because the LEFT JOIN
-- forces the planner to consider rows where cp lookup misses.
--
-- All cards/deck_cards/list_items rows already reference a valid
-- card_print_id (verified pre-flight). Promoting card_print_id to NOT NULL
-- on cards lets the planner pick a Nested Loop + PK lookup. The view
-- definitions also become INNER JOINs, removing the pessimistic LEFT-side
-- preservation that doesn't apply to our data.
--
-- This migration leaves the *_view contracts unchanged (same column list,
-- same names) — it's a pure perf fix. Code paths and tests are unaffected.

-- 1. Promote card_print_id to NOT NULL on the three tables. Each pre-flight
--    SELECT confirmed zero null rows, so this is a metadata-only change.

alter table public.cards      alter column card_print_id set not null;
alter table public.deck_cards alter column card_print_id set not null;
alter table public.list_items alter column card_print_id set not null;

-- 2. Rebuild the views as INNER JOINs. (deck_allocations_view's join to
--    cards is already INNER; switching its card_prints join to INNER is
--    safe for the same reason.)

drop view if exists public.owned_cards_view;
drop view if exists public.deck_cards_view;
drop view if exists public.list_items_view;
drop view if exists public.deck_allocations_view;

create view public.owned_cards_view as
select
  c.id, c.user_id, c.card_print_id,
  cp.scryfall_id, cp.name, cp.set_code, cp.collector_number,
  c.qty, c.foil, c.condition, c.language,
  c.purchase_price, c.currency, c.misprint, c.altered,
  c.added_at, c.updated_at,
  cp.type_line, cp.mana_cost, cp.cmc,
  coalesce(cp.color_identity, '{}'::text[]) as color_identity,
  cp.image_uri, cp.art_crop_uri
from public.cards c
join public.card_prints cp on cp.id = c.card_print_id;

create view public.deck_cards_view as
select
  dc.id, dc.deck_id, dc.user_id, dc.card_print_id,
  cp.scryfall_id, cp.name, cp.set_code, cp.collector_number,
  cp.type_line, cp.mana_cost, cp.cmc,
  coalesce(cp.color_identity, '{}'::text[]) as color_identity,
  cp.image_uri, cp.art_crop_uri,
  dc.qty, dc.foil, dc.is_commander, dc.board,
  dc.created_at, dc.updated_at, dc.category_id
from public.deck_cards dc
join public.card_prints cp on cp.id = dc.card_print_id;

create view public.list_items_view as
select
  li.id, li.folder_id, li.user_id, li.card_print_id,
  cp.scryfall_id, cp.name, cp.set_code, cp.collector_number,
  li.foil, li.qty, li.added_at,
  cp.type_line, cp.mana_cost, cp.cmc,
  coalesce(cp.color_identity, '{}'::text[]) as color_identity,
  cp.image_uri, cp.art_crop_uri
from public.list_items li
join public.card_prints cp on cp.id = li.card_print_id;

create view public.deck_allocations_view as
select
  da.id, da.deck_id, da.user_id, da.card_id,
  da.qty, da.created_at, da.updated_at,
  c.card_print_id,
  cp.scryfall_id, cp.name, cp.set_code, cp.collector_number,
  c.foil, c.condition, c.language,
  cp.type_line, cp.mana_cost, cp.cmc,
  coalesce(cp.color_identity, '{}'::text[]) as color_identity,
  cp.image_uri, cp.art_crop_uri
from public.deck_allocations da
join public.cards c        on c.id = da.card_id
join public.card_prints cp on cp.id = c.card_print_id;

grant select on public.owned_cards_view      to anon, authenticated;
grant select on public.deck_cards_view       to anon, authenticated;
grant select on public.list_items_view       to anon, authenticated;
grant select on public.deck_allocations_view to anon, authenticated;

-- DeckLoom post-migration verification
-- Run after applying:
--   20260402000003_card_prints_and_deck_allocations.sql
--   20260421000001_card_schema_full_migration.sql
--
-- Purpose:
-- - confirm new tables/views exist
-- - confirm card_print backfill coverage
-- - detect obvious integrity issues
-- - surface any remaining legacy deck-placement rows in folder_cards

-- 1. Object existence
select
  'table_exists' as check_name,
  to_regclass('public.card_prints') is not null as ok,
  'public.card_prints' as details
union all
select
  'table_exists',
  to_regclass('public.deck_allocations') is not null,
  'public.deck_allocations'
union all
select
  'view_exists',
  to_regclass('public.owned_cards_view') is not null,
  'public.owned_cards_view'
union all
select
  'view_exists',
  to_regclass('public.deck_cards_view') is not null,
  'public.deck_cards_view'
union all
select
  'view_exists',
  to_regclass('public.deck_allocations_view') is not null,
  'public.deck_allocations_view'
union all
select
  'view_exists',
  to_regclass('public.list_items_view') is not null,
  'public.list_items_view';

-- 2. High-level row counts
select 'card_prints' as dataset, count(*) as row_count from public.card_prints
union all
select 'cards', count(*) from public.cards
union all
select 'deck_cards', count(*) from public.deck_cards
union all
select 'deck_allocations', count(*) from public.deck_allocations
union all
select 'folder_cards', count(*) from public.folder_cards
union all
select 'list_items', count(*) from public.list_items;

-- 3. Backfill coverage for normalized foreign keys
select
  'cards_missing_card_print_id' as metric,
  count(*) as affected_rows
from public.cards
where card_print_id is null
union all
select
  'deck_cards_missing_card_print_id',
  count(*)
from public.deck_cards
where card_print_id is null
union all
select
  'list_items_missing_card_print_id',
  count(*)
from public.list_items
where card_print_id is null;

-- 4. Duplicate print identity should not exist
select
  scryfall_id,
  count(*) as duplicate_count
from public.card_prints
where scryfall_id is not null
group by scryfall_id
having count(*) > 1
order by duplicate_count desc, scryfall_id
limit 50;

-- 5. Orphan detection
select
  'cards_bad_card_print_fk' as metric,
  count(*) as affected_rows
from public.cards c
left join public.card_prints cp on cp.id = c.card_print_id
where c.card_print_id is not null
  and cp.id is null
union all
select
  'deck_cards_bad_card_print_fk',
  count(*)
from public.deck_cards dc
left join public.card_prints cp on cp.id = dc.card_print_id
where dc.card_print_id is not null
  and cp.id is null
union all
select
  'list_items_bad_card_print_fk',
  count(*)
from public.list_items li
left join public.card_prints cp on cp.id = li.card_print_id
where li.card_print_id is not null
  and cp.id is null
union all
select
  'deck_allocations_bad_card_fk',
  count(*)
from public.deck_allocations da
left join public.cards c on c.id = da.card_id
where c.id is null
union all
select
  'deck_allocations_bad_deck_fk',
  count(*)
from public.deck_allocations da
left join public.folders f on f.id = da.deck_id
where f.id is null;

-- 6. Deck allocations that point at non-deck folders should be zero
select
  da.id,
  da.deck_id,
  f.type as folder_type,
  da.card_id,
  da.qty
from public.deck_allocations da
join public.folders f on f.id = da.deck_id
where f.type <> 'deck'
order by da.created_at desc
limit 50;

-- 7. Legacy deck-content rows still living in folder_cards
-- Should be zero after 20260421000001.
select
  f.id as deck_id,
  f.name as deck_name,
  count(fc.*) as legacy_folder_card_rows,
  coalesce(sum(fc.qty), 0) as legacy_total_qty
from public.folders f
left join public.folder_cards fc on fc.folder_id = f.id
where f.type = 'deck'
group by f.id, f.name
having count(fc.*) > 0
order by legacy_folder_card_rows desc, deck_name
limit 100;

-- 8. Compare deck allocation totals vs deck card totals for quick sanity
with deck_card_totals as (
  select deck_id, count(*) as rows, coalesce(sum(qty), 0) as total_qty
  from public.deck_cards
  group by deck_id
),
deck_alloc_totals as (
  select deck_id, count(*) as rows, coalesce(sum(qty), 0) as total_qty
  from public.deck_allocations
  group by deck_id
)
select
  f.id as deck_id,
  f.name as deck_name,
  coalesce(dc.rows, 0) as deck_card_rows,
  coalesce(dc.total_qty, 0) as deck_card_qty,
  coalesce(da.rows, 0) as alloc_rows,
  coalesce(da.total_qty, 0) as alloc_qty
from public.folders f
left join deck_card_totals dc on dc.deck_id = f.id
left join deck_alloc_totals da on da.deck_id = f.id
where f.type = 'deck'
order by deck_name;

-- 9. View sample rows to confirm read models are populated
select * from public.owned_cards_view limit 5;
select * from public.deck_cards_view limit 5;
select * from public.deck_allocations_view limit 5;
select * from public.list_items_view limit 5;

-- 10. Quantity reconciliation: placement totals should equal owned qty after automatic repair.
with placement_totals as (
  select c.id, c.qty as owned_qty, coalesce(fc.qty, 0) + coalesce(da.qty, 0) as placement_qty
  from public.cards c
  left join (
    select card_id, sum(qty) as qty
    from public.folder_cards
    group by card_id
  ) fc on fc.card_id = c.id
  left join (
    select card_id, sum(qty) as qty
    from public.deck_allocations
    group by card_id
  ) da on da.card_id = c.id
)
select *
from placement_totals
where owned_qty <> placement_qty
limit 100;

-- 11. Null-safe duplicate checks should return no rows.
select user_id, card_print_id, foil, language, condition, count(*) as rows
from public.cards
group by user_id, card_print_id, foil, language, condition
having count(*) > 1
limit 100;

select folder_id, card_print_id, foil, count(*) as rows
from public.list_items
group by folder_id, card_print_id, foil
having count(*) > 1
limit 100;

select deck_id, card_print_id, foil, board, count(*) as rows
from public.deck_cards
group by deck_id, card_print_id, foil, board
having count(*) > 1
limit 100;

-- 12. Optional per-user quick audit
-- Replace the UUID and run manually when needed.
-- select
--   'owned_cards' as dataset, count(*) from public.owned_cards_view where user_id = '00000000-0000-0000-0000-000000000000'
-- union all
-- select
--   'deck_cards', count(*) from public.deck_cards_view where user_id = '00000000-0000-0000-0000-000000000000'
-- union all
-- select
--   'deck_allocations', count(*) from public.deck_allocations_view where user_id = '00000000-0000-0000-0000-000000000000';

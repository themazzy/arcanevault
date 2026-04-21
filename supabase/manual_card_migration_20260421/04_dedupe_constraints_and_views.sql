-- Chunk 04: dedupe list/deck card rows, add strict constraints/indexes, create views, final audit
-- Run after the previous numbered chunk completes successfully.

create temporary table tmp_duplicate_list_items on commit drop as
select
  folder_id,
  card_print_id,
  foil,
  (array_agg(id order by added_at nulls last, id))[1] as survivor_id,
  sum(qty) as total_qty,
  count(*) as row_count
from public.list_items
group by folder_id, card_print_id, foil
having count(*) > 1;

update public.list_items li
set qty = d.total_qty
from tmp_duplicate_list_items d
where li.id = d.survivor_id;

delete from public.list_items li
using tmp_duplicate_list_items d
where li.folder_id = d.folder_id
  and li.card_print_id = d.card_print_id
  and li.foil is not distinct from d.foil
  and li.id <> d.survivor_id;

create temporary table tmp_duplicate_deck_cards on commit drop as
select
  deck_id,
  card_print_id,
  foil,
  board,
  (array_agg(id order by created_at nulls last, id))[1] as survivor_id,
  sum(qty) as total_qty,
  bool_or(is_commander) as is_commander,
  count(*) as row_count
from public.deck_cards
group by deck_id, card_print_id, foil, board
having count(*) > 1;

update public.deck_cards dc
set qty = d.total_qty,
    is_commander = d.is_commander,
    updated_at = now()
from tmp_duplicate_deck_cards d
where dc.id = d.survivor_id;

delete from public.deck_cards dc
using tmp_duplicate_deck_cards d
where dc.deck_id = d.deck_id
  and dc.card_print_id = d.card_print_id
  and dc.foil is not distinct from d.foil
  and dc.board is not distinct from d.board
  and dc.id <> d.survivor_id;

do $$
declare
  r record;
begin
  for r in
    select conname
    from pg_constraint
    where conrelid = 'public.cards'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) like '%set_code%'
  loop
    execute format('alter table public.cards drop constraint if exists %I', r.conname);
  end loop;

  for r in
    select conname
    from pg_constraint
    where conrelid = 'public.list_items'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) like '%set_code%'
  loop
    execute format('alter table public.list_items drop constraint if exists %I', r.conname);
  end loop;
end $$;

drop index if exists public.cards_unique_owned_print_idx;
drop index if exists public.deck_cards_unique_print_board_idx;
drop index if exists public.list_items_unique_print_idx;
drop index if exists public.card_prints_null_scryfall_set_collector_idx;

alter table public.cards
  alter column card_print_id set not null;

alter table public.deck_cards
  alter column card_print_id set not null;

alter table public.list_items
  alter column card_print_id set not null;

create unique index cards_unique_owned_print_idx
  on public.cards (user_id, card_print_id, foil, language, condition) nulls not distinct;

create unique index deck_cards_unique_print_board_idx
  on public.deck_cards (deck_id, card_print_id, foil, board) nulls not distinct;

create unique index list_items_unique_print_idx
  on public.list_items (folder_id, card_print_id, foil) nulls not distinct;

create unique index card_prints_null_scryfall_set_collector_idx
  on public.card_prints (set_code, collector_number)
  where scryfall_id is null
    and set_code is not null
    and collector_number is not null;

create or replace view public.list_items_view as
select
  li.id,
  li.folder_id,
  li.user_id,
  li.card_print_id,
  coalesce(cp.scryfall_id, li.scryfall_id) as scryfall_id,
  coalesce(cp.name, li.name) as name,
  coalesce(cp.set_code, li.set_code) as set_code,
  coalesce(cp.collector_number, li.collector_number) as collector_number,
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

grant select on public.list_items_view to authenticated;

insert into public.card_schema_migration_audit (phase, details)
select 'final_validation',
  jsonb_build_object(
    'cards', (select count(*) from public.cards),
    'sum_cards_qty', (select coalesce(sum(qty), 0) from public.cards),
    'folder_cards', (select count(*) from public.folder_cards),
    'sum_folder_cards_qty', (select coalesce(sum(qty), 0) from public.folder_cards),
    'deck_allocations', (select count(*) from public.deck_allocations),
    'sum_deck_allocations_qty', (select coalesce(sum(qty), 0) from public.deck_allocations),
    'list_items', (select count(*) from public.list_items),
    'sum_list_items_qty', (select coalesce(sum(qty), 0) from public.list_items),
    'deck_folder_cards', (
      select count(*)
      from public.folder_cards fc
      join public.folders f on f.id = fc.folder_id
      where f.type = 'deck'
    )
  );

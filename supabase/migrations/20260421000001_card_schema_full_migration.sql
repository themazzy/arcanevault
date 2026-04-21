-- Full card metadata and quantity migration.
-- This migration is intentionally idempotent. It preserves owned quantity by
-- summing duplicate buckets, moving legacy deck placements to deck_allocations,
-- and creating fallback "Unsorted" binder placements for unplaced copies.

create table if not exists public.card_schema_migration_audit (
  id          bigserial primary key,
  phase       text not null,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

alter table public.card_schema_migration_audit enable row level security;
revoke all on public.card_schema_migration_audit from anon, authenticated;

alter table public.card_prints
  alter column scryfall_id drop not null;

alter table public.cards
  add column if not exists card_print_id uuid references public.card_prints(id);

alter table public.deck_cards
  add column if not exists card_print_id uuid references public.card_prints(id);

alter table public.list_items
  add column if not exists card_print_id uuid references public.card_prints(id);

create index if not exists cards_card_print_id_idx on public.cards(card_print_id);
create index if not exists deck_cards_card_print_id_idx on public.deck_cards(card_print_id);
create index if not exists list_items_card_print_id_idx on public.list_items(card_print_id);

with src as (
  select c.scryfall_id, null::text as oracle_id, c.name, c.set_code, c.collector_number,
         null::text as type_line, null::text as mana_cost, null::numeric as cmc,
         '{}'::text[] as color_identity, null::text as image_uri, null::text as art_crop_uri, 10 as source_rank
  from public.cards c
  where c.scryfall_id is not null

  union all
  select dc.scryfall_id, null::text, dc.name, dc.set_code, dc.collector_number,
         dc.type_line, dc.mana_cost, dc.cmc, coalesce(dc.color_identity, '{}'::text[]),
         dc.image_uri, null::text, 0
  from public.deck_cards dc
  where dc.scryfall_id is not null

  union all
  select li.scryfall_id, null::text, li.name, li.set_code, li.collector_number,
         null::text, null::text, null::numeric, '{}'::text[], null::text, null::text, 20
  from public.list_items li
  where li.scryfall_id is not null

  union all
  select ch.scryfall_id, ch.oracle_id, ch.name, ch.set_code, ch.collector_number,
         null::text, null::text, null::numeric, '{}'::text[], ch.image_uri, ch.art_crop_uri, 5
  from public.card_hashes ch
  where ch.scryfall_id is not null

  union all
  select cp.scryfall_id, null::text, concat_ws(' ', cp.set_code, '#' || cp.collector_number),
         cp.set_code, cp.collector_number, null::text, null::text, null::numeric,
         '{}'::text[], null::text, null::text, 30
  from public.card_prices cp
  where cp.scryfall_id is not null
),
deduped as (
  select distinct on (scryfall_id)
    scryfall_id, oracle_id, name, set_code, collector_number, type_line, mana_cost,
    cmc, color_identity, image_uri, art_crop_uri
  from src
  order by scryfall_id, source_rank
)
insert into public.card_prints (
  scryfall_id, oracle_id, name, set_code, collector_number, type_line, mana_cost,
  cmc, color_identity, image_uri, art_crop_uri
)
select
  scryfall_id, oracle_id, coalesce(nullif(name, ''), concat_ws(' ', set_code, '#' || collector_number)),
  set_code, collector_number, type_line, mana_cost, cmc, coalesce(color_identity, '{}'::text[]),
  image_uri, art_crop_uri
from deduped
on conflict (scryfall_id) do update
set
  oracle_id = coalesce(excluded.oracle_id, public.card_prints.oracle_id),
  name = coalesce(excluded.name, public.card_prints.name),
  set_code = coalesce(excluded.set_code, public.card_prints.set_code),
  collector_number = coalesce(excluded.collector_number, public.card_prints.collector_number),
  type_line = coalesce(excluded.type_line, public.card_prints.type_line),
  mana_cost = coalesce(excluded.mana_cost, public.card_prints.mana_cost),
  cmc = coalesce(excluded.cmc, public.card_prints.cmc),
  color_identity = case
    when coalesce(array_length(excluded.color_identity, 1), 0) > 0 then excluded.color_identity
    else public.card_prints.color_identity
  end,
  image_uri = coalesce(excluded.image_uri, public.card_prints.image_uri),
  art_crop_uri = coalesce(excluded.art_crop_uri, public.card_prints.art_crop_uri),
  updated_at = now();

with fallback as (
  select distinct on (set_code, collector_number)
    null::text as scryfall_id,
    name,
    set_code,
    collector_number
  from (
    select name, set_code, collector_number from public.cards
    union all
    select name, set_code, collector_number from public.deck_cards
    union all
    select name, set_code, collector_number from public.list_items
    union all
    select name, set_code, collector_number from public.card_hashes
    union all
    select concat_ws(' ', set_code, '#' || collector_number), set_code, collector_number from public.card_prices
  ) src
  where set_code is not null
    and collector_number is not null
  order by set_code, collector_number, name nulls last
)
insert into public.card_prints (scryfall_id, name, set_code, collector_number)
select null, coalesce(nullif(name, ''), concat_ws(' ', set_code, '#' || collector_number)), set_code, collector_number
from fallback f
where not exists (
  select 1
  from public.card_prints cp
  where cp.set_code is not distinct from f.set_code
    and cp.collector_number is not distinct from f.collector_number
);

with fallback as (
  select distinct on (name)
    name
  from (
    select name, set_code, collector_number, scryfall_id from public.cards
    union all
    select name, set_code, collector_number, scryfall_id from public.deck_cards
    union all
    select name, set_code, collector_number, scryfall_id from public.list_items
  ) src
  where scryfall_id is null
    and set_code is null
    and collector_number is null
    and nullif(name, '') is not null
  order by name
)
insert into public.card_prints (scryfall_id, name, set_code, collector_number)
select null, name, null, null
from fallback f
where not exists (
  select 1
  from public.card_prints cp
  where cp.scryfall_id is null
    and cp.set_code is null
    and cp.collector_number is null
    and cp.name = f.name
);

update public.cards c
set card_print_id = cp.id
from public.card_prints cp
where c.card_print_id is null
  and c.scryfall_id is not null
  and cp.scryfall_id = c.scryfall_id;

update public.deck_cards dc
set card_print_id = cp.id
from public.card_prints cp
where dc.card_print_id is null
  and dc.scryfall_id is not null
  and cp.scryfall_id = dc.scryfall_id;

update public.list_items li
set card_print_id = cp.id
from public.card_prints cp
where li.card_print_id is null
  and li.scryfall_id is not null
  and cp.scryfall_id = li.scryfall_id;

with unique_prints as (
  select set_code, collector_number, (array_agg(id order by id))[1] as id
  from public.card_prints
  where set_code is not null
    and collector_number is not null
  group by set_code, collector_number
  having count(*) = 1
)
update public.cards c
set card_print_id = up.id
from unique_prints up
where c.card_print_id is null
  and c.set_code is not distinct from up.set_code
  and c.collector_number is not distinct from up.collector_number;

with unique_prints as (
  select set_code, collector_number, (array_agg(id order by id))[1] as id
  from public.card_prints
  where set_code is not null
    and collector_number is not null
  group by set_code, collector_number
  having count(*) = 1
)
update public.deck_cards dc
set card_print_id = up.id
from unique_prints up
where dc.card_print_id is null
  and dc.set_code is not distinct from up.set_code
  and dc.collector_number is not distinct from up.collector_number;

with unique_prints as (
  select set_code, collector_number, (array_agg(id order by id))[1] as id
  from public.card_prints
  where set_code is not null
    and collector_number is not null
  group by set_code, collector_number
  having count(*) = 1
)
update public.list_items li
set card_print_id = up.id
from unique_prints up
where li.card_print_id is null
  and li.set_code is not distinct from up.set_code
  and li.collector_number is not distinct from up.collector_number;

with unique_prints as (
  select name, (array_agg(id order by id))[1] as id
  from public.card_prints
  where scryfall_id is null
    and set_code is null
    and collector_number is null
  group by name
  having count(*) = 1
)
update public.cards c
set card_print_id = up.id
from unique_prints up
where c.card_print_id is null
  and c.scryfall_id is null
  and c.set_code is null
  and c.collector_number is null
  and c.name = up.name;

with unique_prints as (
  select name, (array_agg(id order by id))[1] as id
  from public.card_prints
  where scryfall_id is null
    and set_code is null
    and collector_number is null
  group by name
  having count(*) = 1
)
update public.deck_cards dc
set card_print_id = up.id
from unique_prints up
where dc.card_print_id is null
  and dc.scryfall_id is null
  and dc.set_code is null
  and dc.collector_number is null
  and dc.name = up.name;

with unique_prints as (
  select name, (array_agg(id order by id))[1] as id
  from public.card_prints
  where scryfall_id is null
    and set_code is null
    and collector_number is null
  group by name
  having count(*) = 1
)
update public.list_items li
set card_print_id = up.id
from unique_prints up
where li.card_print_id is null
  and li.scryfall_id is null
  and li.set_code is null
  and li.collector_number is null
  and li.name = up.name;

insert into public.card_schema_migration_audit (phase, details)
select 'card_print_backfill',
  jsonb_build_object(
    'cards_missing', (select count(*) from public.cards where card_print_id is null),
    'deck_cards_missing', (select count(*) from public.deck_cards where card_print_id is null),
    'list_items_missing', (select count(*) from public.list_items where card_print_id is null)
  );

do $$
begin
  if exists (select 1 from public.cards where card_print_id is null) then
    raise exception 'cards.card_print_id backfill is incomplete';
  end if;
  if exists (select 1 from public.deck_cards where card_print_id is null) then
    raise exception 'deck_cards.card_print_id backfill is incomplete';
  end if;
  if exists (select 1 from public.list_items where card_print_id is null) then
    raise exception 'list_items.card_print_id backfill is incomplete';
  end if;
end $$;

create temporary table tmp_duplicate_card_groups on commit drop as
select
  user_id,
  card_print_id,
  foil,
  coalesce(language, 'en') as language_key,
  condition,
  (array_agg(id order by added_at nulls last, id))[1] as survivor_id,
  sum(qty) as total_qty,
  count(*) as row_count
from public.cards
group by user_id, card_print_id, foil, coalesce(language, 'en'), condition
having count(*) > 1;

create temporary table tmp_duplicate_card_map on commit drop as
select c.id as old_id, g.survivor_id
from public.cards c
join tmp_duplicate_card_groups g
  on g.user_id = c.user_id
 and g.card_print_id = c.card_print_id
 and g.foil is not distinct from c.foil
 and g.language_key is not distinct from coalesce(c.language, 'en')
 and g.condition is not distinct from c.condition;

create temporary table tmp_folder_cards_merged on commit drop as
select fc.folder_id, m.survivor_id as card_id, sum(fc.qty) as qty, max(fc.updated_at) as updated_at
from public.folder_cards fc
join tmp_duplicate_card_map m on m.old_id = fc.card_id
group by fc.folder_id, m.survivor_id;

delete from public.folder_cards fc
using tmp_duplicate_card_map m
where fc.card_id = m.old_id;

insert into public.folder_cards (folder_id, card_id, qty, updated_at)
select folder_id, card_id, qty, coalesce(updated_at, now())
from tmp_folder_cards_merged
on conflict (folder_id, card_id) do update
set qty = public.folder_cards.qty + excluded.qty,
    updated_at = now();

create temporary table tmp_deck_allocations_merged on commit drop as
select da.deck_id, da.user_id, m.survivor_id as card_id, sum(da.qty) as qty, min(da.created_at) as created_at, max(da.updated_at) as updated_at
from public.deck_allocations da
join tmp_duplicate_card_map m on m.old_id = da.card_id
group by da.deck_id, da.user_id, m.survivor_id;

delete from public.deck_allocations da
using tmp_duplicate_card_map m
where da.card_id = m.old_id;

insert into public.deck_allocations (deck_id, user_id, card_id, qty, created_at, updated_at)
select deck_id, user_id, card_id, qty, coalesce(created_at, now()), coalesce(updated_at, now())
from tmp_deck_allocations_merged
on conflict (deck_id, card_id) do update
set qty = public.deck_allocations.qty + excluded.qty,
    updated_at = now();

update public.cards c
set qty = g.total_qty,
    updated_at = now()
from tmp_duplicate_card_groups g
where c.id = g.survivor_id;

delete from public.cards c
using tmp_duplicate_card_map m
where c.id = m.old_id
  and c.id <> m.survivor_id;

insert into public.card_schema_migration_audit (phase, details)
select 'duplicate_cards_merged',
  jsonb_build_object(
    'groups', coalesce(sum(row_count), 0),
    'survivors', count(*)
  )
from tmp_duplicate_card_groups;

insert into public.deck_allocations (deck_id, user_id, card_id, qty)
select fc.folder_id, f.user_id, fc.card_id, fc.qty
from public.folder_cards fc
join public.folders f on f.id = fc.folder_id
where f.type = 'deck'
on conflict (deck_id, card_id) do update
set qty = greatest(public.deck_allocations.qty, excluded.qty),
    updated_at = now();

delete from public.folder_cards fc
using public.folders f
where f.id = fc.folder_id
  and f.type = 'deck';

create or replace function public.prevent_deck_folder_cards()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from public.folders
    where id = new.folder_id
      and type = 'deck'
  ) then
    raise exception 'folder_cards cannot reference folders of type deck';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_deck_folder_cards_trigger on public.folder_cards;
create trigger prevent_deck_folder_cards_trigger
  before insert or update of folder_id on public.folder_cards
  for each row execute function public.prevent_deck_folder_cards();

with placement_totals as (
  select c.id as card_id, c.user_id, c.qty as owned_qty,
         coalesce(fc.qty, 0) + coalesce(da.qty, 0) as placement_qty
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
),
missing as (
  select card_id, user_id, owned_qty - placement_qty as missing_qty
  from placement_totals
  where owned_qty > placement_qty
),
unsorted as (
  insert into public.folders (user_id, name, type)
  select distinct user_id, 'Unsorted', 'binder'
  from missing
  on conflict (user_id, name, type) do update
  set updated_at = now()
  returning id, user_id
)
insert into public.folder_cards (folder_id, card_id, qty)
select u.id, m.card_id, m.missing_qty
from missing m
join unsorted u on u.user_id = m.user_id
where m.missing_qty > 0
on conflict (folder_id, card_id) do update
set qty = public.folder_cards.qty + excluded.qty,
    updated_at = now();

with placement_totals as (
  select c.id as card_id, coalesce(fc.qty, 0) + coalesce(da.qty, 0) as placement_qty
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
update public.cards c
set qty = pt.placement_qty,
    updated_at = now()
from placement_totals pt
where pt.card_id = c.id
  and pt.placement_qty > c.qty;

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

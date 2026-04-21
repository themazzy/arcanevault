-- Chunk 01: setup audit table, add nullable references, backfill card_print_id, validate backfill
-- Run after the previous numbered chunk completes successfully.

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

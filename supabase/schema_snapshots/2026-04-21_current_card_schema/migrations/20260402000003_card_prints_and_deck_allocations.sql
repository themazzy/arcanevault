create table if not exists public.card_prints (
  id               uuid primary key default gen_random_uuid(),
  scryfall_id      text not null unique,
  oracle_id        text,
  name             text not null,
  set_code         text,
  collector_number text,
  type_line        text,
  mana_cost        text,
  cmc              numeric,
  color_identity   text[] not null default '{}',
  image_uri        text,
  art_crop_uri     text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists card_prints_set_collector_idx
  on public.card_prints(set_code, collector_number);

alter table public.card_prints enable row level security;

drop policy if exists "public read card_prints" on public.card_prints;
create policy "public read card_prints"
  on public.card_prints for select
  using (true);

grant select on public.card_prints to authenticated, anon;

insert into public.card_prints (
  scryfall_id,
  oracle_id,
  name,
  set_code,
  collector_number,
  type_line,
  mana_cost,
  cmc,
  color_identity,
  image_uri,
  art_crop_uri
)
select distinct on (src.scryfall_id)
  src.scryfall_id,
  src.oracle_id,
  src.name,
  src.set_code,
  src.collector_number,
  src.type_line,
  src.mana_cost,
  src.cmc,
  coalesce(src.color_identity, '{}'),
  src.image_uri,
  src.art_crop_uri
from (
  select
    dc.scryfall_id,
    null::text as oracle_id,
    dc.name,
    dc.set_code,
    dc.collector_number,
    dc.type_line,
    dc.mana_cost,
    dc.cmc,
    coalesce(dc.color_identity, '{}') as color_identity,
    dc.image_uri,
    null::text as art_crop_uri,
    0 as source_rank
  from public.deck_cards dc
  where dc.scryfall_id is not null

  union all

  select
    c.scryfall_id,
    null::text as oracle_id,
    c.name,
    c.set_code,
    c.collector_number,
    null::text as type_line,
    null::text as mana_cost,
    null::numeric as cmc,
    '{}'::text[] as color_identity,
    null::text as image_uri,
    null::text as art_crop_uri,
    1 as source_rank
  from public.cards c
  where c.scryfall_id is not null

  union all

  select
    ch.scryfall_id,
    ch.oracle_id,
    ch.name,
    ch.set_code,
    ch.collector_number,
    null::text as type_line,
    null::text as mana_cost,
    null::numeric as cmc,
    '{}'::text[] as color_identity,
    ch.image_uri,
    ch.art_crop_uri,
    2 as source_rank
  from public.card_hashes ch
  where ch.scryfall_id is not null
) src
order by src.scryfall_id, src.source_rank
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

alter table public.cards
  add column if not exists card_print_id uuid references public.card_prints(id);

alter table public.deck_cards
  add column if not exists card_print_id uuid references public.card_prints(id);

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

create table if not exists public.deck_allocations (
  id         uuid primary key default gen_random_uuid(),
  deck_id     uuid not null references public.folders(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  card_id     uuid not null references public.cards(id) on delete cascade,
  qty         integer not null default 1 check (qty >= 1),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (deck_id, card_id)
);

create index if not exists deck_allocations_deck_id_idx on public.deck_allocations(deck_id);
create index if not exists deck_allocations_user_id_idx on public.deck_allocations(user_id);
create index if not exists deck_allocations_card_id_idx on public.deck_allocations(card_id);

alter table public.deck_allocations enable row level security;

drop policy if exists "Users manage own deck_allocations" on public.deck_allocations;
create policy "Users manage own deck_allocations"
  on public.deck_allocations for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant all on public.deck_allocations to authenticated;

insert into public.deck_allocations (
  deck_id,
  user_id,
  card_id,
  qty
)
select
  fc.folder_id as deck_id,
  f.user_id,
  fc.card_id,
  fc.qty
from public.folder_cards fc
join public.folders f on f.id = fc.folder_id
where f.type = 'deck'
on conflict (deck_id, card_id) do update
set
  qty = excluded.qty,
  updated_at = now();

drop trigger if exists card_prints_updated_at on public.card_prints;
create trigger card_prints_updated_at
  before update on public.card_prints
  for each row execute function public.update_updated_at();

drop trigger if exists deck_allocations_updated_at on public.deck_allocations;
create trigger deck_allocations_updated_at
  before update on public.deck_allocations
  for each row execute function public.update_updated_at();

create index if not exists cards_card_print_id_idx on public.cards(card_print_id);
create index if not exists deck_cards_card_print_id_idx on public.deck_cards(card_print_id);

create or replace view public.owned_cards_view as
select
  c.id,
  c.user_id,
  c.card_print_id,
  cp.scryfall_id,
  coalesce(cp.name, c.name) as name,
  coalesce(cp.set_code, c.set_code) as set_code,
  coalesce(cp.collector_number, c.collector_number) as collector_number,
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

create or replace view public.deck_cards_view as
select
  dc.id,
  dc.deck_id,
  dc.user_id,
  dc.card_print_id,
  coalesce(cp.scryfall_id, dc.scryfall_id) as scryfall_id,
  coalesce(cp.name, dc.name) as name,
  coalesce(cp.set_code, dc.set_code) as set_code,
  coalesce(cp.collector_number, dc.collector_number) as collector_number,
  coalesce(cp.type_line, dc.type_line) as type_line,
  coalesce(cp.mana_cost, dc.mana_cost) as mana_cost,
  coalesce(cp.cmc, dc.cmc) as cmc,
  case
    when coalesce(array_length(cp.color_identity, 1), 0) > 0 then cp.color_identity
    else coalesce(dc.color_identity, '{}'::text[])
  end as color_identity,
  coalesce(cp.image_uri, dc.image_uri) as image_uri,
  cp.art_crop_uri,
  dc.qty,
  dc.foil,
  dc.is_commander,
  dc.board,
  dc.created_at,
  dc.updated_at
from public.deck_cards dc
left join public.card_prints cp on cp.id = dc.card_print_id;

create or replace view public.deck_allocations_view as
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
  coalesce(cp.name, c.name) as name,
  coalesce(cp.set_code, c.set_code) as set_code,
  coalesce(cp.collector_number, c.collector_number) as collector_number,
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

grant select on public.owned_cards_view to authenticated;
grant select on public.deck_cards_view to authenticated;
grant select on public.deck_allocations_view to authenticated;

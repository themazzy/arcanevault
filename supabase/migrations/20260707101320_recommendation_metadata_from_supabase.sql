-- Runtime recommendation enrichment should not depend on Scryfall's card API.
-- Legalities are oracle-level data, so store them once per oracle card instead
-- of repeating the same JSON across every row in card_prints.

create table if not exists public.oracle_cards (
  oracle_id         text primary key,
  name              text not null,
  legalities        jsonb not null default '{}'::jsonb,
  source_updated_at timestamptz,
  synced_at         timestamptz not null default now(),
  constraint oracle_cards_legalities_object
    check (jsonb_typeof(legalities) = 'object')
);

create index if not exists oracle_cards_name_idx
  on public.oracle_cards (name);

alter table public.oracle_cards enable row level security;

drop policy if exists "public read oracle_cards" on public.oracle_cards;
create policy "public read oracle_cards"
  on public.oracle_cards
  for select
  to anon, authenticated
  using (true);

-- Explicit grants are required for projects using the newer Data API exposure
-- defaults. Browser clients are read-only; the scheduled bulk sync uses the
-- service role for writes.
grant select on public.oracle_cards to anon, authenticated;
grant select, insert, update, delete on public.oracle_cards to service_role;

-- One index-backed card_prints lookup per requested name. The RPC is bounded to
-- 300 distinct names, preserves caller order, and returns one representative
-- paper printing plus oracle-level legalities. SECURITY INVOKER keeps table RLS
-- and grants in force.
create or replace function public.get_recommendation_card_metadata(requested_names text[])
returns table (
  name             text,
  scryfall_id      text,
  oracle_id        text,
  set_code         text,
  collector_number text,
  type_line        text,
  mana_cost        text,
  cmc              numeric,
  color_identity   text[],
  image_uri        text,
  art_crop_uri     text,
  oracle_text      text,
  rarity           text,
  set_name         text,
  artist           text,
  power            text,
  toughness        text,
  produced_mana    text[],
  keywords         text[],
  colors           text[],
  card_faces       jsonb,
  legalities       jsonb
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with raw_names as (
    select btrim(input.name) as name, input.ordinality
    from unnest(coalesce(requested_names, array[]::text[]))
      with ordinality as input(name, ordinality)
    where input.name is not null
      and btrim(input.name) <> ''
  ),
  names as (
    select raw_names.name, min(raw_names.ordinality) as ordinality
    from raw_names
    group by raw_names.name
    order by min(raw_names.ordinality)
    limit 300
  )
  select
    picked.name,
    picked.scryfall_id,
    picked.oracle_id,
    picked.set_code,
    picked.collector_number,
    picked.type_line,
    picked.mana_cost,
    picked.cmc,
    picked.color_identity,
    picked.image_uri,
    picked.art_crop_uri,
    picked.oracle_text,
    picked.rarity,
    picked.set_name,
    picked.artist,
    picked.power,
    picked.toughness,
    picked.produced_mana,
    picked.keywords,
    picked.colors,
    picked.card_faces,
    coalesce(oracle.legalities, '{}'::jsonb) as legalities
  from names
  cross join lateral (
    select
      cp.name,
      cp.scryfall_id,
      cp.oracle_id,
      cp.set_code,
      cp.collector_number,
      cp.type_line,
      cp.mana_cost,
      cp.cmc,
      cp.color_identity,
      cp.image_uri,
      cp.art_crop_uri,
      cp.oracle_text,
      cp.rarity,
      cp.set_name,
      cp.artist,
      cp.power,
      cp.toughness,
      cp.produced_mana,
      cp.keywords,
      cp.colors,
      cp.card_faces
    from public.card_prints cp
    where cp.name = names.name
    order by
      (cp.image_uri is not null) desc,
      (cp.oracle_text is not null) desc,
      cp.updated_at desc,
      cp.scryfall_id
    limit 1
  ) as picked
  left join public.oracle_cards oracle
    on oracle.oracle_id = picked.oracle_id
  order by names.ordinality;
$$;

revoke all on function public.get_recommendation_card_metadata(text[]) from public;
grant execute on function public.get_recommendation_card_metadata(text[]) to anon, authenticated;

notify pgrst, 'reload schema';

-- Keep one representative Scryfall bulk record per Oracle identity. This fills
-- recommendation images/details when a card has not reached card_prints yet and
-- lets EDHREC front-face names resolve canonical double-faced card records.

alter table public.oracle_cards
  add column if not exists scryfall_id text,
  add column if not exists set_code text,
  add column if not exists collector_number text,
  add column if not exists type_line text,
  add column if not exists mana_cost text,
  add column if not exists cmc numeric,
  add column if not exists color_identity text[] not null default '{}'::text[],
  add column if not exists image_uri text,
  add column if not exists art_crop_uri text,
  add column if not exists oracle_text text,
  add column if not exists rarity text,
  add column if not exists set_name text,
  add column if not exists artist text,
  add column if not exists power text,
  add column if not exists toughness text,
  add column if not exists produced_mana text[] not null default '{}'::text[],
  add column if not exists keywords text[] not null default '{}'::text[],
  add column if not exists colors text[] not null default '{}'::text[],
  add column if not exists card_faces jsonb,
  add column if not exists face_names text[] not null default '{}'::text[];

create index if not exists oracle_cards_name_idx
  on public.oracle_cards (name);

create index if not exists oracle_cards_face_names_idx
  on public.oracle_cards using gin (face_names);

drop function if exists public.get_recommendation_card_metadata(text[]);

create function public.get_recommendation_card_metadata(requested_names text[])
returns table (
  requested_name   text,
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
    names.name as requested_name,
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
    picked.legalities
  from names
  cross join lateral (
    select candidates.*
    from (
      select
        0 as source_rank,
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
        cp.card_faces,
        coalesce(oc.legalities, '{}'::jsonb) as legalities,
        cp.updated_at as source_updated_at
      from public.card_prints cp
      left join public.oracle_cards oc on oc.oracle_id = cp.oracle_id
      where cp.name = names.name

      union all

      select
        1 as source_rank,
        oc.name,
        oc.scryfall_id,
        oc.oracle_id,
        oc.set_code,
        oc.collector_number,
        oc.type_line,
        oc.mana_cost,
        oc.cmc,
        oc.color_identity,
        oc.image_uri,
        oc.art_crop_uri,
        oc.oracle_text,
        oc.rarity,
        oc.set_name,
        oc.artist,
        oc.power,
        oc.toughness,
        oc.produced_mana,
        oc.keywords,
        oc.colors,
        oc.card_faces,
        oc.legalities,
        coalesce(oc.source_updated_at, oc.synced_at) as source_updated_at
      from public.oracle_cards oc
      where oc.name = names.name
         or oc.face_names @> array[names.name]
    ) candidates
    where candidates.scryfall_id is not null
    order by
      candidates.source_rank,
      (candidates.legalities ->> 'commander' = 'legal') desc,
      (candidates.image_uri is not null) desc,
      (candidates.oracle_text is not null) desc,
      candidates.source_updated_at desc nulls last,
      candidates.scryfall_id
    limit 1
  ) picked
  order by names.ordinality;
$$;

revoke all on function public.get_recommendation_card_metadata(text[]) from public;
grant execute on function public.get_recommendation_card_metadata(text[]) to anon, authenticated;

notify pgrst, 'reload schema';

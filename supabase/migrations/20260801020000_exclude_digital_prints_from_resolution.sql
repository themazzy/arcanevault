-- Apply the new card_prints.digital flag to the two RPCs that choose a printing
-- for deck building. Cheapest-first already couldn't reach a digital row (they
-- carry no market price), but the "nothing is priced" fallback orders by
-- released_at and was returning MTGO promos for cards like Crusade.
--
-- Only the card_prints branches are filtered. oracle_cards holds one row per
-- oracle_id — the representative-printing metadata there is used for rules text
-- and images, not as a purchasable printing, and a digital-only card still
-- needs to resolve to something.

create or replace function public.get_deck_builder_display_printings(
  card_names text[],
  price_source text default 'cardmarket_trend'::text
)
returns table(
  requested_name text, scryfall_id text, oracle_id text, name text,
  set_code text, collector_number text, lang text, image_uri text,
  art_crop_uri text, released_at date, selected_price numeric, selected_foil boolean
)
language sql
stable
set search_path to 'public'
as $function$
  with requested as (
    select
      min(trim(input.card_name)) as requested_name,
      min(input.ordinality) as ord
    from unnest(coalesce(card_names, '{}'::text[])) with ordinality
      as input(card_name, ordinality)
    where trim(coalesce(input.card_name, '')) <> ''
    group by lower(trim(input.card_name))
  ),
  resolved as (
    select
      requested.requested_name,
      requested.ord,
      coalesce(canonical.name, requested.requested_name) as canonical_name
    from requested
    left join lateral (
      select oc.name
      from public.oracle_cards oc
      where oc.name = requested.requested_name
         or oc.face_names @> array[requested.requested_name]
      order by
        (oc.name = requested.requested_name) desc,
        public.is_nonplayable_print_type(oc.type_line) asc,
        oc.name
      limit 1
    ) canonical on true
  )
  select
    resolved.requested_name,
    chosen.scryfall_id, chosen.oracle_id, chosen.name, chosen.set_code,
    chosen.collector_number, chosen.lang, chosen.image_uri, chosen.art_crop_uri,
    chosen.released_at, chosen.selected_price,
    case when chosen.selected_price is null then null else chosen.selected_foil end
  from resolved
  join lateral (
    select
      cp.scryfall_id, cp.oracle_id, cp.name, cp.set_code, cp.collector_number,
      cp.lang, cp.image_uri, cp.art_crop_uri, cp.released_at,
      finish.selected_price, finish.selected_foil
    from public.card_prints cp
    left join lateral (
      select
        prices.price_regular_eur, prices.price_foil_eur,
        prices.price_regular_usd, prices.price_foil_usd
      from public.card_prices prices
      where prices.scryfall_id = cp.scryfall_id
      order by prices.snapshot_date desc
      limit 1
    ) latest_price on true
    cross join lateral (
      select candidate.selected_price, candidate.selected_foil
      from (values
        (
          case when price_source = 'tcgplayer_market'
            then nullif(latest_price.price_regular_usd, 0)
            else nullif(latest_price.price_regular_eur, 0)
          end,
          false
        ),
        (
          case when price_source = 'tcgplayer_market'
            then nullif(latest_price.price_foil_usd, 0)
            else nullif(latest_price.price_foil_eur, 0)
          end,
          true
        )
      ) as candidate(selected_price, selected_foil)
      order by candidate.selected_price asc nulls last, candidate.selected_foil asc
      limit 1
    ) finish
    where cp.lang = 'en'
      and cp.name = resolved.canonical_name
      and not public.is_nonplayable_print_type(cp.type_line)
      and not cp.digital
    order by
      (finish.selected_price is null) asc,
      finish.selected_price asc nulls last,
      finish.selected_foil asc,
      cp.released_at desc nulls last,
      cp.created_at desc,
      cp.scryfall_id asc
    limit 1
  ) chosen on true
  order by resolved.ord
$function$;

create or replace function public.get_recommendation_card_metadata(requested_names text[])
returns table(
  requested_name text, name text, scryfall_id text, oracle_id text, set_code text,
  collector_number text, lang text, type_line text, mana_cost text, cmc numeric,
  color_identity text[], image_uri text, art_crop_uri text, oracle_text text,
  rarity text, set_name text, artist text, power text, toughness text,
  produced_mana text[], keywords text[], colors text[], card_faces jsonb, legalities jsonb
)
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
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
    picked.name, picked.scryfall_id, picked.oracle_id, picked.set_code,
    picked.collector_number, picked.lang, picked.type_line, picked.mana_cost,
    picked.cmc, picked.color_identity, picked.image_uri, picked.art_crop_uri,
    picked.oracle_text, picked.rarity, picked.set_name, picked.artist,
    picked.power, picked.toughness, picked.produced_mana, picked.keywords,
    picked.colors, picked.card_faces, picked.legalities
  from names
  cross join lateral (
    select candidates.*
    from (
      select
        0 as source_rank,
        cp.name, cp.scryfall_id, cp.oracle_id, cp.set_code, cp.collector_number,
        cp.lang, cp.type_line, cp.mana_cost, cp.cmc, cp.color_identity,
        cp.image_uri, cp.art_crop_uri, cp.oracle_text, cp.rarity, cp.set_name,
        cp.artist, cp.power, cp.toughness, cp.produced_mana, cp.keywords,
        cp.colors, cp.card_faces,
        coalesce(oc.legalities, '{}'::jsonb) as legalities,
        cp.updated_at as source_updated_at
      from public.card_prints cp
      left join public.oracle_cards oc on oc.oracle_id = cp.oracle_id
      where cp.name = names.name
        and not public.is_nonplayable_print_type(cp.type_line)
        and not cp.digital

      union all

      select
        1 as source_rank,
        oc.name, oc.scryfall_id, oc.oracle_id, oc.set_code, oc.collector_number,
        'en'::text as lang, oc.type_line, oc.mana_cost, oc.cmc, oc.color_identity,
        oc.image_uri, oc.art_crop_uri, oc.oracle_text, oc.rarity, oc.set_name,
        oc.artist, oc.power, oc.toughness, oc.produced_mana, oc.keywords,
        oc.colors, oc.card_faces, oc.legalities,
        coalesce(oc.source_updated_at, oc.synced_at) as source_updated_at
      from public.oracle_cards oc
      where (oc.name = names.name
         or oc.face_names @> array[names.name])
        and not public.is_nonplayable_print_type(oc.type_line)
    ) candidates
    where candidates.scryfall_id is not null
    order by
      coalesce(candidates.lang = 'en', false) desc,
      candidates.source_rank,
      coalesce(candidates.legalities ->> 'commander' = 'legal', false) desc,
      (candidates.image_uri is not null) desc,
      (candidates.oracle_text is not null) desc,
      candidates.source_updated_at desc nulls last,
      candidates.scryfall_id
    limit 1
  ) picked
  order by names.ordinality;
$function$;

notify pgrst, 'reload schema';

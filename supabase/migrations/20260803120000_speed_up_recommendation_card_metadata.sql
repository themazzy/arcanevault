-- Speed up get_recommendation_card_metadata.
--
-- A build plan resolves ~250 EDHREC names in one call. The old body joined
-- oracle_cards to EVERY candidate print inside the per-name lateral (Sol Ring
-- alone has ~80 printings, so 250 names meant ~20k joined rows) purely to feed
-- a "commander legal" tiebreaker in the ORDER BY. That tiebreaker is constant
-- within the card_prints branch — every print of a card shares one oracle_id,
-- hence one legalities blob — and across branches `source_rank` already decides,
-- so the join could never change which row was picked. It cost 3.1 s and 37k
-- shared buffer hits for 246 names, close enough to the 8 s statement timeout to
-- fail intermittently under autovacuum load.
--
-- When it failed, the deck builder degraded silently: unowned EDHREC suggestions
-- arrived with no oracle_text and no cmc, so every mana dork was classified from
-- its section header ("Creatures" -> Synergy) instead of its rules text (Ramp),
-- and curve fit saw cmc 0 for the entire upgrade pool.
--
-- Fix: don't join oracle_cards inside the lateral. Leave legalities NULL on the
-- card_prints branch (the tiebreaker still evaluates to false for all of them,
-- exactly as before) and resolve it once, for the single winning row, after the
-- pick. Same result set, same ordering, one oracle_cards lookup per name.
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
    picked.colors, picked.card_faces,
    -- Resolved once for the winner instead of once per candidate print.
    coalesce(picked.legalities, winner_oracle.legalities, '{}'::jsonb) as legalities
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
        -- NULL here, not the joined blob: the tiebreaker below coalesces it to
        -- false for every row of this branch, which is what the join produced
        -- anyway (one oracle_id per name => one legalities value).
        null::jsonb as legalities,
        cp.updated_at as source_updated_at
      from public.card_prints cp
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
  left join public.oracle_cards winner_oracle
    on winner_oracle.oracle_id = picked.oracle_id
   and picked.legalities is null
  order by names.ordinality;
$function$;

grant execute on function public.get_recommendation_card_metadata(text[]) to anon, authenticated;

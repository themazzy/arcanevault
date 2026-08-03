-- Speed up get_deck_builder_display_printings, which was 500ing on statement
-- timeouts in the deck builder.
--
-- The function picks the cheapest English printing per name, so it has to price
-- every candidate print — and popular cards have a lot of them (Sol Ring ~80).
-- For each of those ~2000 rows per 100-name call it started a `cross join
-- lateral (values (regular), (foil)) order by price limit 1` just to choose the
-- cheaper of two scalars. That is a full executor node — VALUES scan, sort,
-- limit — set up and torn down once per candidate print, and it dominated the
-- runtime: 2.4 s for 100 names against an 8 s statement timeout, so any load
-- spike pushed it over.
--
-- The same choice is two scalar expressions. `least()` already ignores nulls,
-- and the tie-break the old ORDER BY encoded (`selected_foil asc`, so regular
-- wins an exact tie) becomes an explicit `<` comparison:
--
--   both priced      -> cheaper one, regular on a tie
--   only foil priced -> foil
--   only regular     -> regular
--   neither          -> null price, and the outer select nulls the flag
--
-- Output is unchanged; verified row-for-row over 167 EUR names and 99 USD names
-- (both price_source branches) before and after.
create or replace function public.get_deck_builder_display_printings(
  card_names text[],
  price_source text default 'cardmarket_trend'::text
)
returns table(
  requested_name text, scryfall_id text, oracle_id text, name text, set_code text,
  collector_number text, lang text, image_uri text, art_crop_uri text,
  released_at date, selected_price numeric, selected_foil boolean
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
    chosen.scryfall_id,
    chosen.oracle_id,
    chosen.name,
    chosen.set_code,
    chosen.collector_number,
    chosen.lang,
    chosen.image_uri,
    chosen.art_crop_uri,
    chosen.released_at,
    chosen.selected_price,
    case when chosen.selected_price is null then null else chosen.selected_foil end
  from resolved
  join lateral (
    select
      cp.scryfall_id,
      cp.oracle_id,
      cp.name,
      cp.set_code,
      cp.collector_number,
      cp.lang,
      cp.image_uri,
      cp.art_crop_uri,
      cp.released_at,
      finish.selected_price,
      finish.selected_foil
    from public.card_prints cp
    left join lateral (
      select
        case when price_source = 'tcgplayer_market'
          then nullif(prices.price_regular_usd, 0)
          else nullif(prices.price_regular_eur, 0)
        end as regular_price,
        case when price_source = 'tcgplayer_market'
          then nullif(prices.price_foil_usd, 0)
          else nullif(prices.price_foil_eur, 0)
        end as foil_price
      from public.card_prices prices
      where prices.scryfall_id = cp.scryfall_id
      order by prices.snapshot_date desc
      limit 1
    ) latest_price on true
    cross join lateral (
      select
        least(latest_price.regular_price, latest_price.foil_price) as selected_price,
        -- Foil only wins when it exists AND is strictly cheaper (or is the only
        -- price we have). An exact tie goes to regular, as it did before.
        coalesce(
          latest_price.foil_price is not null
            and (latest_price.regular_price is null
                 or latest_price.foil_price < latest_price.regular_price),
          false
        ) as selected_foil
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

grant execute on function public.get_deck_builder_display_printings(text[], text) to anon, authenticated;

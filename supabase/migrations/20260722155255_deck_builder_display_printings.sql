-- Resolve each requested card name to the exact English printing that should
-- be displayed in DeckBuilder search/recommendations:
--   1. lowest available price in the user's selected market, comparing foil
--      and non-foil prices across every English printing;
--   2. newest English printing when no price exists for that card.
--
-- The returned image and finish belong to the same scryfall_id as the price,
-- preventing the UI from showing one printing's art beside another's value.
create or replace function public.get_deck_builder_display_printings(
  card_names text[],
  price_source text default 'cardmarket_trend'
)
returns table (
  requested_name text,
  scryfall_id text,
  oracle_id text,
  name text,
  set_code text,
  collector_number text,
  lang text,
  image_uri text,
  art_crop_uri text,
  released_at date,
  selected_price numeric,
  selected_foil boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  with requested as (
    select
      min(trim(input.card_name)) as requested_name,
      min(input.ordinality) as ord
    from unnest(coalesce(card_names, '{}'::text[])) with ordinality
      as input(card_name, ordinality)
    where trim(coalesce(input.card_name, '')) <> ''
    group by lower(trim(input.card_name))
  )
  select
    requested.requested_name,
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
  from requested
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
        prices.price_regular_eur,
        prices.price_foil_eur,
        prices.price_regular_usd,
        prices.price_foil_usd
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
      and (
        cp.name = requested.requested_name
        or (
          position(' // ' in requested.requested_name) = 0
          and split_part(cp.name, ' // ', 1) = requested.requested_name
        )
      )
    order by
      (finish.selected_price is null) asc,
      finish.selected_price asc nulls last,
      finish.selected_foil asc,
      cp.released_at desc nulls last,
      cp.created_at desc,
      cp.scryfall_id asc
    limit 1
  ) chosen on true
  order by requested.ord
$$;

revoke all on function public.get_deck_builder_display_printings(text[], text) from public;
grant execute on function public.get_deck_builder_display_printings(text[], text)
  to anon, authenticated;

notify pgrst, 'reload schema';

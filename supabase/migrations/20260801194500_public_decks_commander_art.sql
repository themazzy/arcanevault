-- Kill the deck-art N+1 on public profiles.
--
-- Profile.jsx's enrichPublicDecksWithCommanderArt() called
-- get_deck_cards_for_view once PER DECK that had no cached art, and each call
-- returns that deck's entire card list just to read one commander row. A profile
-- showing 20 public decks issued 20 sequential-ish HTTP round trips and
-- downloaded ~20 decklists to end up with 20 image URLs.
--
-- get_public_decks now resolves commander art itself, in the same single query
-- it was already running:
--   * meta already has coverArtUri / commanders / commanderScryfallId -> free,
--     it is a string transform, no lookup at all;
--   * only when meta has nothing does it fall back to a per-deck commander
--     lookup, and that is guarded by CASE so Postgres skips the subquery
--     entirely for every deck that does not need it.
--
-- Also switches card_count and color identity to the folders rollup columns
-- (deck_card_count / deck_color_identity, maintained by the refresh_deck_rollups
-- triggers) instead of summing deck_cards/deck_allocations per deck — the same
-- change that fixed the Builder index statement timeouts on 2026-07-11.

create or replace function public.get_public_decks(p_username text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_user_id uuid;
  v_result  jsonb;
begin
  select user_id into v_user_id
  from user_settings
  where lower(nickname) = lower(p_username)
  limit 1;

  if v_user_id is null then
    return '[]'::jsonb;
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'id',                    f.id,
      'name',                  f.name,
      'type',                  f.type,
      -- Rollup column first; the subquery only runs for a deck whose trigger has
      -- never fired (pre-rollup rows).
      'card_count',            coalesce(
                                 f.deck_card_count,
                                 case f.type
                                   when 'builder_deck' then (
                                     select coalesce(sum(dc.qty), 0)
                                     from deck_cards dc where dc.deck_id = f.id
                                   )
                                   else (
                                     select coalesce(sum(da.qty), 0)
                                     from deck_allocations da where da.deck_id = f.id
                                   )
                                 end
                               ),
      'commander_name',        meta->>'commanderName',
      'commander_scryfall_id', meta->>'commanderScryfallId',
      'commanders',            meta->'commanders',
      'color_identity',        coalesce(meta->'commanderColorIdentity',
                                        to_jsonb(f.deck_color_identity)),
      'format',                meta->>'format',
      'bracket',               meta->'bracket',
      'cover_art_uri',         coalesce(
                                 meta->>'coverArtUri',
                                 -- Scryfall art_crop URLs are derivable from the
                                 -- id, so a known commander needs no lookup.
                                 case
                                   when meta->>'commanderScryfallId' is not null then
                                     'https://cards.scryfall.io/art_crop/front/'
                                       || left(meta->>'commanderScryfallId', 1) || '/'
                                       || substr(meta->>'commanderScryfallId', 2, 1) || '/'
                                       || (meta->>'commanderScryfallId') || '.jpg'
                                 end,
                                 -- Last resort: find the commander. CASE keeps
                                 -- this subquery unevaluated for every deck that
                                 -- resolved above.
                                 case
                                   when meta->>'coverArtUri' is null
                                    and meta->>'commanderScryfallId' is null
                                    and meta->'commanders' is null
                                   then (
                                     select coalesce(c.art_crop_uri, c.image_uri)
                                     from (
                                       select dcv.art_crop_uri, dcv.image_uri
                                       from deck_cards_view dcv
                                       where dcv.deck_id = f.id and dcv.is_commander
                                       union all
                                       select dav.art_crop_uri, dav.image_uri
                                       from deck_allocations_view dav
                                       where dav.deck_id = f.id
                                         and lower(dav.name) = lower(coalesce(meta->>'commanderName', ''))
                                     ) c
                                     limit 1
                                   )
                                 end
                               ),
      'deck_description',      meta->>'deckDescription',
      'tags',                  coalesce(meta->'tags', '[]'::jsonb)
    )
    order by f.created_at desc
  ) into v_result
  from folders f
  cross join lateral public.safe_jsonb(f.description) meta
  where f.user_id = v_user_id
    and f.type in ('deck', 'builder_deck')
    and meta->>'is_public' = 'true'
    and not (
      f.type = 'deck'
      and meta->>'linked_builder_id' is not null
      and meta->>'linked_builder_id' != ''
    )
  limit 100;

  return coalesce(v_result, '[]'::jsonb);
end;
$function$;

notify pgrst, 'reload schema';

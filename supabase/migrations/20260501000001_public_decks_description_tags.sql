-- Extend get_public_decks to also return deck description and tags so the
-- public Profile featured-deck block can render them.

drop function if exists get_public_decks(text);

create or replace function get_public_decks(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
      'card_count',
        case f.type
          when 'builder_deck' then (
            select coalesce(sum(dc.qty), 0) from deck_cards dc where dc.deck_id = f.id
          )
          else (
            select coalesce(sum(da.qty), 0) from deck_allocations da where da.deck_id = f.id
          )
        end,
      'commander_name',        meta->>'commanderName',
      'commander_scryfall_id', meta->>'commanderScryfallId',
      'color_identity',        meta->'commanderColorIdentity',
      'format',                meta->>'format',
      'cover_art_uri',         meta->>'coverArtUri',
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
$$;

grant execute on function get_public_decks(text) to anon, authenticated;

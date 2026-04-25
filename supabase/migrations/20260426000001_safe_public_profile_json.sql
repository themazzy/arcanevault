-- Harden public profile RPCs against legacy/plain-text folder descriptions.
-- App code treats folders.description as JSON metadata when possible, but older
-- rows may contain arbitrary text. Direct description::jsonb casts make the
-- public profile endpoints fail with HTTP 500 for those users.

create or replace function public.safe_jsonb(p_text text)
returns jsonb
language plpgsql
immutable
as $$
begin
  return coalesce(p_text, '{}')::jsonb;
exception
  when others then
    return '{}'::jsonb;
end;
$$;
grant execute on function public.safe_jsonb(text) to anon, authenticated;

drop function if exists get_public_decks(uuid);
create or replace function get_public_decks(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  select jsonb_agg(
    jsonb_build_object(
      'id',         f.id,
      'name',       f.name,
      'type',       f.type,
      'card_count',
        case f.type
          when 'builder_deck' then (
            select coalesce(sum(dc.qty), 0) from deck_cards dc where dc.deck_id = f.id
          )
          else (
            select coalesce(sum(da.qty), 0) from deck_allocations da where da.deck_id = f.id
          )
        end,
      'commander_name',        public.safe_jsonb(f.description)->>'commanderName',
      'commander_scryfall_id', public.safe_jsonb(f.description)->>'commanderScryfallId',
      'color_identity',        public.safe_jsonb(f.description)->'commanderColorIdentity',
      'format',                public.safe_jsonb(f.description)->>'format',
      'cover_art_uri',         public.safe_jsonb(f.description)->>'coverArtUri'
    )
    order by f.created_at desc
  ) into v_result
  from folders f
  where f.user_id = p_user_id
    and f.type in ('deck', 'builder_deck')
    and public.safe_jsonb(f.description)->>'is_public' = 'true'
    and not (
      f.type = 'deck'
      and public.safe_jsonb(f.description)->>'linked_builder_id' is not null
      and public.safe_jsonb(f.description)->>'linked_builder_id' != ''
    );

  return coalesce(v_result, '[]'::jsonb);
end;
$$;
grant execute on function get_public_decks(uuid) to anon, authenticated;

drop function if exists get_public_profile(text);
create or replace function get_public_profile(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id    uuid;
  v_row        user_settings%rowtype;
  v_joined_at  timestamptz;
  v_total      bigint;
  v_unique     bigint;
  v_value      numeric;
  v_top_card   jsonb;
  v_deck_count bigint;
begin
  select * into v_row
  from user_settings
  where lower(nickname) = lower(p_username)
  limit 1;

  if not found then
    return null;
  end if;

  v_user_id := v_row.user_id;

  select created_at into v_joined_at
  from auth.users
  where id = v_user_id;

  select coalesce(sum(qty), 0) into v_total
  from cards
  where user_id = v_user_id;

  select count(distinct (set_code, collector_number, foil)) into v_unique
  from cards
  where user_id = v_user_id;

  select coalesce(sum(
    c.qty * case
      when c.foil then coalesce(cp.price_foil_eur, cp.price_regular_eur, 0)
      else              coalesce(cp.price_regular_eur, cp.price_foil_eur, 0)
    end
  ), 0) into v_value
  from cards c
  left join card_prices cp
    on cp.scryfall_id   = c.scryfall_id
   and cp.snapshot_date = current_date
  where c.user_id = v_user_id;

  select jsonb_build_object(
    'name',             c.name,
    'set_code',         c.set_code,
    'collector_number', c.collector_number,
    'image_uri',        coalesce(cpr.image_uri, dc.image_uri),
    'foil',             c.foil,
    'price',
      case
        when c.foil then coalesce(cp.price_foil_eur, cp.price_regular_eur)
        else              coalesce(cp.price_regular_eur, cp.price_foil_eur)
      end
  ) into v_top_card
  from cards c
  left join card_prices cp
    on cp.scryfall_id   = c.scryfall_id
   and cp.snapshot_date = current_date
  left join card_prints cpr
    on cpr.scryfall_id  = c.scryfall_id
  left join deck_cards dc
    on dc.scryfall_id   = c.scryfall_id
   and dc.user_id       = v_user_id
  where c.user_id = v_user_id
  order by (
    case
      when c.foil then coalesce(cp.price_foil_eur, cp.price_regular_eur, 0)
      else              coalesce(cp.price_regular_eur, cp.price_foil_eur, 0)
    end
  ) desc nulls last
  limit 1;

  select count(*) into v_deck_count
  from folders f
  where f.user_id = v_user_id
    and f.type in ('deck', 'builder_deck')
    and public.safe_jsonb(f.description)->>'is_public' = 'true'
    and not (
      f.type = 'deck'
      and public.safe_jsonb(f.description)->>'linked_builder_id' is not null
      and public.safe_jsonb(f.description)->>'linked_builder_id' != ''
    );

  return jsonb_build_object(
    'user_id',           v_user_id,
    'nickname',          v_row.nickname,
    'bio',               coalesce(v_row.profile_bio, ''),
    'accent',            coalesce(v_row.profile_accent, ''),
    'premium',           coalesce(v_row.premium, false),
    'bento_config',      coalesce(v_row.profile_config, '{"blocks":[]}'::jsonb),
    'joined_at',         v_joined_at,
    'stats',             jsonb_build_object(
                           'total_cards',  v_total,
                           'unique_cards', v_unique
                         ),
    'collection_value',  v_value,
    'top_card',          v_top_card,
    'public_deck_count', v_deck_count
  );
end;
$$;
grant execute on function get_public_profile(text) to anon, authenticated;

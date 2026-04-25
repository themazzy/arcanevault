-- Reduce public profile RPC work enough to stay under PostgREST statement
-- timeout for large collections.

create index if not exists user_settings_lower_nickname_idx
  on public.user_settings (lower(nickname));

create index if not exists folders_user_type_idx
  on public.folders (user_id, type);

create index if not exists deck_cards_deck_id_idx
  on public.deck_cards (deck_id);

create index if not exists deck_allocations_deck_id_idx
  on public.deck_allocations (deck_id);

create index if not exists cards_user_scryfall_idx
  on public.cards (user_id, scryfall_id);

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

  select
    coalesce(sum(c.qty), 0),
    count(distinct (c.set_code, c.collector_number, c.foil)),
    coalesce(sum(
      c.qty * case
        when c.foil then coalesce(cp.price_foil_eur, cp.price_regular_eur, 0)
        else              coalesce(cp.price_regular_eur, cp.price_foil_eur, 0)
      end
    ), 0)
  into v_total, v_unique, v_value
  from cards c
  left join card_prices cp
    on cp.scryfall_id   = c.scryfall_id
   and cp.snapshot_date = current_date
  where c.user_id = v_user_id;

  select jsonb_build_object(
    'name',             c.name,
    'set_code',         c.set_code,
    'collector_number', c.collector_number,
    'image_uri',        cpr.image_uri,
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
  cross join lateral public.safe_jsonb(f.description) meta
  where f.user_id = v_user_id
    and f.type in ('deck', 'builder_deck')
    and meta->>'is_public' = 'true'
    and not (
      f.type = 'deck'
      and meta->>'linked_builder_id' is not null
      and meta->>'linked_builder_id' != ''
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

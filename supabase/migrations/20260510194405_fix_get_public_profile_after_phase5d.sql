-- get_public_profile still referenced denormalized print columns that Phase 5d
-- removed from public.cards. Read print identity from card_prints instead.

create or replace function public.get_public_profile(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_user_id      uuid;
  v_row          user_settings%rowtype;
  v_joined_at    timestamptz;
  v_total        bigint;
  v_unique       bigint;
  v_value        numeric;
  v_top_card     jsonb;
  v_deck_count   bigint;
  v_show_value   boolean;
  v_show_crown   boolean;
  v_blocks       jsonb;
  v_top_id       uuid;
  v_top_price    numeric;
begin
  select * into v_row
  from user_settings
  where lower(nickname) = lower(p_username)
  limit 1;

  if not found then
    return null;
  end if;

  v_user_id := v_row.user_id;
  v_blocks  := coalesce(v_row.profile_config->'blocks', '[]'::jsonb);

  select
    bool_or(b->>'id' = 'value' and (b->>'enabled')::boolean),
    bool_or(b->>'id' = 'crown' and (b->>'enabled')::boolean)
  into v_show_value, v_show_crown
  from jsonb_array_elements(v_blocks) b;

  select created_at into v_joined_at
  from auth.users
  where id = v_user_id;

  select
    coalesce(sum(c.qty), 0),
    count(distinct (cp.set_code, cp.collector_number, c.foil))
  into v_total, v_unique
  from cards c
  join card_prints cp on cp.id = c.card_print_id
  where c.user_id = v_user_id;

  if coalesce(v_show_value, false) then
    select coalesce(sum(
      c.qty * case
        when c.foil then coalesce(pr.price_foil_eur, pr.price_regular_eur, 0)
        else             coalesce(pr.price_regular_eur, pr.price_foil_eur, 0)
      end
    ), 0)
    into v_value
    from cards c
    join card_prints cp on cp.id = c.card_print_id
    left join card_prices pr
      on pr.scryfall_id   = cp.scryfall_id
     and pr.snapshot_date = current_date
    where c.user_id = v_user_id;
  end if;

  if coalesce(v_show_crown, false) then
    select c.id,
      case
        when c.foil then coalesce(pr.price_foil_eur, pr.price_regular_eur, 0)
        else             coalesce(pr.price_regular_eur, pr.price_foil_eur, 0)
      end
    into v_top_id, v_top_price
    from cards c
    join card_prints cp on cp.id = c.card_print_id
    left join card_prices pr
      on pr.scryfall_id   = cp.scryfall_id
     and pr.snapshot_date = current_date
    where c.user_id = v_user_id
    order by 2 desc nulls last
    limit 1;

    if v_top_id is not null then
      select jsonb_build_object(
        'name',             cp.name,
        'set_code',         cp.set_code,
        'collector_number', cp.collector_number,
        'image_uri',        cp.image_uri,
        'foil',             c.foil,
        'price',            nullif(v_top_price, 0)
      )
      into v_top_card
      from cards c
      join card_prints cp on cp.id = c.card_print_id
      where c.id = v_top_id;
    end if;
  end if;

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
$function$;

revoke execute on function public.get_public_profile(text) from public;
grant execute on function public.get_public_profile(text) to anon, authenticated;

-- get_public_profile was scanning card_prints once for stats, again for
-- collection value, and again for the top-card block. On cold cache that can
-- exceed PostgREST's statement timeout for larger collections.

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

  with priced as materialized (
    select
      c.id,
      c.foil,
      c.qty,
      cp.name,
      cp.set_code,
      cp.collector_number,
      cp.image_uri,
      case
        when c.foil then coalesce(pr.price_foil_eur, pr.price_regular_eur, 0)
        else             coalesce(pr.price_regular_eur, pr.price_foil_eur, 0)
      end as price
    from cards c
    join card_prints cp on cp.id = c.card_print_id
    left join card_prices pr
      on pr.scryfall_id   = cp.scryfall_id
     and pr.snapshot_date = current_date
    where c.user_id = v_user_id
  ),
  agg as (
    select
      coalesce(sum(qty), 0)::bigint as total_cards,
      count(distinct (set_code, collector_number, foil))::bigint as unique_cards,
      coalesce(sum(qty * price), 0)::numeric as collection_value
    from priced
  ),
  top_one as (
    select jsonb_build_object(
      'name',             name,
      'set_code',         set_code,
      'collector_number', collector_number,
      'image_uri',        image_uri,
      'foil',             foil,
      'price',            nullif(price, 0)
    ) as top_card
    from priced
    where coalesce(v_show_crown, false)
    order by price desc nulls last
    limit 1
  )
  select
    agg.total_cards,
    agg.unique_cards,
    case when coalesce(v_show_value, false) then agg.collection_value end,
    top_one.top_card
  into v_total, v_unique, v_value, v_top_card
  from agg
  left join top_one on true;

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

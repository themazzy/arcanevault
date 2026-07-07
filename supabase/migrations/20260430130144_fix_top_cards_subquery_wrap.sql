
CREATE OR REPLACE FUNCTION public.get_public_profile(p_username text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id      uuid;
  v_row          user_settings%rowtype;
  v_joined_at    timestamptz;
  v_total        bigint;
  v_unique       bigint;
  v_foil_count   bigint;
  v_sets_count   bigint;
  v_value        numeric;
  v_top_card     jsonb;
  v_top_cards    jsonb;
  v_color_dist   jsonb;
  v_recent_cards jsonb;
  v_deck_count   bigint;
  v_show_value   boolean;
  v_show_crown   boolean;
  v_blocks       jsonb;
begin
  select * into v_row
  from user_settings
  where lower(nickname) = lower(p_username)
  limit 1;

  if not found then return null; end if;

  v_user_id := v_row.user_id;
  v_blocks  := coalesce(v_row.profile_config->'blocks', '[]'::jsonb);

  select
    bool_or(b->>'id' = 'value'                              and (b->>'enabled')::boolean),
    bool_or((b->>'id' = 'crown' or b->>'id' = 'top_cards') and (b->>'enabled')::boolean)
  into v_show_value, v_show_crown
  from jsonb_array_elements(v_blocks) b;

  select created_at into v_joined_at from auth.users where id = v_user_id;

  select
    coalesce(sum(c.qty), 0),
    count(distinct (c.set_code, c.collector_number, c.foil)),
    coalesce(sum(c.qty) filter (where c.foil = true), 0),
    count(distinct c.set_code)
  into v_total, v_unique, v_foil_count, v_sets_count
  from cards c where c.user_id = v_user_id;

  select jsonb_object_agg(color, total_qty) into v_color_dist
  from (
    select col as color, sum(c.qty) as total_qty
    from cards c
    left join card_prints cp on cp.scryfall_id = c.scryfall_id
    cross join lateral (
      select unnest(
        case when array_length(cp.color_identity, 1) > 0
             then cp.color_identity else array['C']::text[] end
      ) as col
    ) ci
    where c.user_id = v_user_id
    group by col
  ) sub;

  select jsonb_agg(jsonb_build_object('name', sub.name, 'image_uri', cp2.image_uri))
  into v_recent_cards
  from (
    select c.name, c.scryfall_id from cards c
    where c.user_id = v_user_id order by c.added_at desc limit 8
  ) sub
  left join card_prints cp2 on cp2.scryfall_id = sub.scryfall_id;

  if coalesce(v_show_value, false) then
    select coalesce(sum(
      c.qty * case when c.foil
        then coalesce(cp.price_foil_eur, cp.price_regular_eur, 0)
        else coalesce(cp.price_regular_eur, cp.price_foil_eur, 0)
      end
    ), 0) into v_value
    from cards c
    left join lateral (
      select price_regular_eur, price_foil_eur from card_prices
      where set_code = c.set_code and collector_number = c.collector_number
        and snapshot_date in (current_date, current_date - 1)
      order by snapshot_date desc limit 1
    ) cp on true
    where c.user_id = v_user_id;
  end if;

  if coalesce(v_show_crown, false) then

    -- crown: single most valuable card
    select jsonb_build_object(
      'name',             d.name,
      'set_code',         d.set_code,
      'collector_number', d.collector_number,
      'image_uri',        d.image_uri,
      'foil',             d.foil,
      'price',            d.unit_price
    ) into v_top_card
    from (
      select distinct on (c.scryfall_id)
        c.name, c.set_code, c.collector_number, c.foil, cpr.image_uri,
        case when c.foil
          then coalesce(cp.price_foil_eur, cp.price_regular_eur, 0)
          else coalesce(cp.price_regular_eur, cp.price_foil_eur, 0)
        end as unit_price
      from cards c
      left join card_prints cpr on cpr.scryfall_id = c.scryfall_id
      left join lateral (
        select price_regular_eur, price_foil_eur from card_prices
        where set_code = c.set_code and collector_number = c.collector_number
          and snapshot_date in (current_date, current_date - 1)
        order by snapshot_date desc limit 1
      ) cp on true
      where c.user_id = v_user_id
      order by c.scryfall_id, (
        case when c.foil
          then coalesce(cp.price_foil_eur, cp.price_regular_eur, 0)
          else coalesce(cp.price_regular_eur, cp.price_foil_eur, 0)
        end
      ) desc
    ) d
    order by d.unit_price desc nulls last
    limit 1;

    -- top 5: dedup → sort → limit 5 → aggregate
    select jsonb_agg(
      jsonb_build_object(
        'name',      top5.name,
        'set_code',  top5.set_code,
        'image_uri', top5.image_uri,
        'foil',      top5.foil,
        'price',     top5.unit_price
      )
    ) into v_top_cards
    from (
      select name, set_code, image_uri, foil, unit_price
      from (
        select distinct on (c.scryfall_id)
          c.name, c.set_code, c.foil, cpr.image_uri,
          case when c.foil
            then coalesce(cp.price_foil_eur, cp.price_regular_eur, 0)
            else coalesce(cp.price_regular_eur, cp.price_foil_eur, 0)
          end as unit_price
        from cards c
        left join card_prints cpr on cpr.scryfall_id = c.scryfall_id
        left join lateral (
          select price_regular_eur, price_foil_eur from card_prices
          where set_code = c.set_code and collector_number = c.collector_number
            and snapshot_date in (current_date, current_date - 1)
          order by snapshot_date desc limit 1
        ) cp on true
        where c.user_id = v_user_id
          and cpr.image_uri is not null
        order by c.scryfall_id, (
          case when c.foil
            then coalesce(cp.price_foil_eur, cp.price_regular_eur, 0)
            else coalesce(cp.price_regular_eur, cp.price_foil_eur, 0)
          end
        ) desc
      ) deduped
      order by unit_price desc nulls last
      limit 5
    ) top5;

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
    'stats', jsonb_build_object(
      'total_cards',        v_total,
      'unique_cards',       v_unique,
      'foil_count',         v_foil_count,
      'sets_count',         v_sets_count,
      'color_distribution', v_color_dist
    ),
    'collection_value',  v_value,
    'top_card',          v_top_card,
    'top_cards',         v_top_cards,
    'public_deck_count', v_deck_count,
    'recent_cards',      v_recent_cards
  );
end;
$function$;
;

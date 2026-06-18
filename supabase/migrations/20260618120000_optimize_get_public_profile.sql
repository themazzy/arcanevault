-- Optimize get_public_profile so it stops timing out (HTTP 500) for large
-- collections. The old function joined every owned card to card_prints + today's
-- card_prices to compute totals, value and the top card. On a ~11k-print
-- collection that ran ~12-15s and was canceled by the role statement_timeout
-- (anon=3s, authenticated=8s), surfacing as a 500 on public profile pages.
--
-- Fixes, in order of impact:
--   1. Covering indexes so the price join is index-only (no heap fetches).
--   2. total_cards / unique_cards now come from `cards` alone (no join at all).
--   3. collection_value + top_card are computed in a single index-only pass, and
--      only when the matching profile block is enabled. The most-valuable card's
--      display fields are fetched with one PK lookup instead of carrying name/art
--      for every owned card through the aggregate.
--   4. A function-scoped statement_timeout override (20s) guarantees the role's
--      3s/8s ceiling can never cancel a legitimately-running call. With the
--      indexes the warm cost is ~2-3s, so this is a safety net, not the hot path.
--
-- The returned JSON shape is unchanged. unique_cards switches from
-- distinct (set_code, collector_number, foil) to distinct (card_print_id, foil);
-- these are equivalent because card_prints is one row per (set_code, collector
-- number), and the latter needs no join.

create index if not exists card_prints_id_scry_cover
  on card_prints (id) include (scryfall_id);

create index if not exists card_prices_lookup_cover
  on card_prices (scryfall_id, snapshot_date) include (price_regular_eur, price_foil_eur);

create or replace function public.get_public_profile(p_username text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '20s'
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
  v_value_raw    numeric;
  v_top_print_id uuid;
  v_top_foil     boolean;
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

  -- Totals straight from `cards` — no join, index-only on cards_user_id_idx.
  select
    coalesce(sum(qty), 0)::bigint,
    count(distinct (card_print_id, foil))::bigint
  into v_total, v_unique
  from cards
  where user_id = v_user_id;

  -- Value + most-valuable card: one index-only pass over the price join, only
  -- when a block actually needs it.
  if coalesce(v_show_value, false) or coalesce(v_show_crown, false) then
    select
      coalesce(sum(p.qty * p.price), 0)::numeric,
      (array_agg(p.card_print_id order by p.price desc nulls last))[1],
      (array_agg(p.foil          order by p.price desc nulls last))[1],
      (array_agg(p.price         order by p.price desc nulls last))[1]
    into v_value_raw, v_top_print_id, v_top_foil, v_top_price
    from (
      select
        c.card_print_id,
        c.foil,
        c.qty,
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
    ) p;

    if coalesce(v_show_value, false) then
      v_value := v_value_raw;
    end if;

    if coalesce(v_show_crown, false) and v_top_print_id is not null then
      select jsonb_build_object(
        'name',             cp.name,
        'set_code',         cp.set_code,
        'collector_number', cp.collector_number,
        'image_uri',        cp.image_uri,
        'foil',             v_top_foil,
        'price',            nullif(v_top_price, 0)
      )
      into v_top_card
      from card_prints cp
      where cp.id = v_top_print_id;
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

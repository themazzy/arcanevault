-- SEC-002: get_public_profile returned the raw user_id UUID and always included
-- collection_value + top_card regardless of the user's bento block config.
-- The user_id fed the SEC-001 attack chain from unauthenticated callers.
--
-- Fixes:
--   1. Remove user_id from the response entirely.
--   2. Only compute and return collection_value when the 'value' block is enabled.
--   3. Only compute and return top_card when the 'crown' block is enabled.
--   4. Rewrite get_public_decks to accept p_username (resolves user_id internally)
--      so callers never need the UUID. Also fixes unsafe ::jsonb casts → safe_jsonb.

-- ── get_public_profile ────────────────────────────────────────────────────────

drop function if exists get_public_profile(text);
create or replace function get_public_profile(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

  -- check which sensitive blocks the user has enabled
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
    count(distinct (c.set_code, c.collector_number, c.foil))
  into v_total, v_unique
  from cards c
  where c.user_id = v_user_id;

  -- only run the expensive value aggregation if the block is on
  if coalesce(v_show_value, false) then
    select coalesce(sum(
      c.qty * case
        when c.foil then coalesce(cp.price_foil_eur, cp.price_regular_eur, 0)
        else              coalesce(cp.price_regular_eur, cp.price_foil_eur, 0)
      end
    ), 0)
    into v_value
    from cards c
    left join card_prices cp
      on cp.scryfall_id   = c.scryfall_id
     and cp.snapshot_date = current_date
    where c.user_id = v_user_id;
  end if;

  -- only fetch top card if the crown block is on
  if coalesce(v_show_crown, false) then
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
    -- user_id intentionally omitted — callers use the username as the opaque handle
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
    -- null when the block is disabled — client must handle null gracefully
    'collection_value',  v_value,
    'top_card',          v_top_card,
    'public_deck_count', v_deck_count
  );
end;
$$;

grant execute on function get_public_profile(text) to anon, authenticated;


-- ── get_public_decks ──────────────────────────────────────────────────────────
-- Accept p_username instead of p_user_id so callers never need the internal UUID.
-- Also fixes raw ::jsonb casts → safe_jsonb to prevent HTTP 500 on legacy rows.

drop function if exists get_public_decks(uuid);
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
      'cover_art_uri',         meta->>'coverArtUri'
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

-- Public deck RPCs still referenced print metadata columns removed from base
-- tables in Phase 5d. Read that metadata from card_prints instead.

create or replace function public.get_community_decks()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_result jsonb;
begin
  select jsonb_agg(
    jsonb_build_object(
      'id',          f.id,
      'name',        f.name,
      'user_id',     f.user_id,
      'updated_at',  f.updated_at,
      'type',        f.type,
      -- strip internal sync state before returning
      'description', (
        public.safe_jsonb(f.description)
        - 'sync_state'
        - 'last_sync_at'
        - 'last_sync_snapshot'
        - 'unsynced_builder'
        - 'unsynced_collection'
      )::text,
      'deck_color_identity', (
        select jsonb_agg(distinct ci order by ci)
        from (
          select unnest(cp.color_identity) as ci
          from deck_cards dc
          join card_prints cp on cp.id = dc.card_print_id
          where dc.deck_id = f.id
        ) colors
        where ci in ('W','U','B','R','G','C')
      )
    )
    order by f.updated_at desc
  ) into v_result
  from folders f
  cross join lateral public.safe_jsonb(f.description) meta
  where f.type in ('builder_deck', 'deck')
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

revoke execute on function public.get_community_decks() from public;
grant execute on function public.get_community_decks() to anon, authenticated;

create or replace function public.get_deck_cards_for_view(p_deck_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_result  jsonb;
  v_user_id uuid;
begin
  -- Try deck_cards first (builder decks and hydrated collection decks).
  -- deck_cards_view is security_invoker, so RLS on deck_cards applies normally.
  select jsonb_agg(row_to_json(v)::jsonb order by v.is_commander desc, v.name)
  into v_result
  from deck_cards_view v
  where v.deck_id = p_deck_id;

  if v_result is not null and jsonb_array_length(v_result) > 0 then
    return v_result;
  end if;

  -- Allocations fallback: only run for the deck owner.
  -- This branch bypasses the RLS on `cards`, so it must self-enforce ownership.
  select f.user_id into v_user_id
  from public.folders f
  where f.id = p_deck_id;

  if v_user_id is distinct from auth.uid() then
    return '[]'::jsonb;
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'id',               da.id,
      'deck_id',          da.deck_id,
      'user_id',          da.user_id,
      'card_print_id',    c.card_print_id,
      'scryfall_id',      cp.scryfall_id,
      'name',             cp.name,
      'set_code',         cp.set_code,
      'collector_number', cp.collector_number,
      'type_line',        cp.type_line,
      'mana_cost',        cp.mana_cost,
      'cmc',              cp.cmc,
      'color_identity',   coalesce(cp.color_identity, '{}'::text[]),
      'image_uri',        cp.image_uri,
      'art_crop_uri',     cp.art_crop_uri,
      'qty',              da.qty,
      'foil',             c.foil,
      'is_commander',     false,
      'board',            'main',
      'created_at',       da.created_at,
      'updated_at',       da.updated_at
    )
    order by cp.name
  ) into v_result
  from deck_allocations da
  join cards c on c.id = da.card_id
  join card_prints cp on cp.id = c.card_print_id
  where da.deck_id = p_deck_id;

  return coalesce(v_result, '[]'::jsonb);
end;
$function$;

revoke execute on function public.get_deck_cards_for_view(uuid) from public;
grant execute on function public.get_deck_cards_for_view(uuid) to anon, authenticated;

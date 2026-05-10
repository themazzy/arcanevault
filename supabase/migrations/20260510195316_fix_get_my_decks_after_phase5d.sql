-- get_my_decks still referenced deck_cards.color_identity after Phase 5d
-- removed denormalized print metadata from deck_cards. Read colors from the
-- linked card_prints row instead.

create or replace function public.get_my_decks()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_user_id uuid := auth.uid();
  v_result  jsonb;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'id',                  f.id,
      'name',                f.name,
      'type',                f.type,
      'created_at',          f.created_at,
      'updated_at',          f.updated_at,
      -- strip internal sync state before returning to client
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
          union
          select unnest(cp.color_identity) as ci
          from deck_allocations da
          join cards c on c.id = da.card_id
          join card_prints cp on cp.id = c.card_print_id
          where da.deck_id = f.id
        ) colors
        where ci in ('W','U','B','R','G','C')
      )
    )
    order by f.updated_at desc
  ) into v_result
  from folders f
  cross join lateral public.safe_jsonb(f.description) meta
  where f.user_id = v_user_id
    and f.type in ('builder_deck', 'deck')
    and (meta->>'isGroup')         is distinct from 'true'
    and (meta->>'hideFromBuilder') is distinct from 'true'
    -- exclude collection decks paired to a builder deck (avoid duplicates in index)
    and not (
      f.type = 'builder_deck'
      and meta->>'linked_deck_id' is not null
      and meta->>'linked_deck_id' != ''
    )
  limit 500;

  return coalesce(v_result, '[]'::jsonb);
end;
$function$;

revoke execute on function public.get_my_decks() from public;
revoke execute on function public.get_my_decks() from anon;
grant execute on function public.get_my_decks() to authenticated;

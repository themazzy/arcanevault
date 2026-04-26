-- SEC-001: get_my_decks accepted a caller-supplied p_user_id with no ownership
-- check, allowing any authenticated user to read another user's full private
-- deck list. Fix: remove the parameter entirely and use auth.uid() internally.
-- Also filters groups/hidden/paired decks server-side and strips internal sync
-- state fields from the description before returning.

drop function if exists get_my_decks(uuid);

create or replace function get_my_decks()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
          select unnest(dc.color_identity) as ci
          from deck_cards dc
          where dc.deck_id = f.id
          union
          select unnest(cp.color_identity) as ci
          from deck_allocations da
          join cards c   on c.id  = da.card_id
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
$$;

grant execute on function get_my_decks() to authenticated;
-- anon must not have access
revoke execute on function get_my_decks() from anon;

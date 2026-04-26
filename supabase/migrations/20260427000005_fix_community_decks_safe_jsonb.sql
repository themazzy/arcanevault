-- SEC-005: get_community_decks used direct ::jsonb casts on folder.description,
-- causing an HTTP 500 for all callers if any public folder has a non-JSON
-- description string. One authenticated user could trigger this permanently.
-- Fix: replace all ::jsonb casts with safe_jsonb(), add LIMIT 100, and strip
-- internal sync state fields from description before returning to client.

create or replace function get_community_decks()
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
        from deck_cards dc,
             jsonb_array_elements_text(to_jsonb(dc.color_identity)) as ci
        where dc.deck_id = f.id
          and ci in ('W','U','B','R','G','C')
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
$$;

grant execute on function get_community_decks() to anon, authenticated;

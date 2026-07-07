-- Add like/comment counts + created_at to the community deck browser feed so the
-- merged Deck Browser can sort by Trending (likes) / Most commented and pick a
-- "trending recently" headliner.
create or replace function public.get_community_decks()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
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
      'created_at',  f.created_at,
      'type',        f.type,
      'description', (
        public.safe_jsonb(f.description)
        - 'sync_state'
        - 'last_sync_at'
        - 'last_sync_snapshot'
        - 'unsynced_builder'
        - 'unsynced_collection'
      )::text,
      'like_count',    (select count(*)::int from public.deck_likes dl where dl.deck_id = f.id),
      'comment_count', (select count(*)::int from public.deck_comments dc2 where dc2.deck_id = f.id),
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

notify pgrst, 'reload schema';

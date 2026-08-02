-- Speed up the community deck browser by reading the cached color-identity
-- rollup instead of re-deriving it from card_prints on every request.
--
-- The function computed each deck's color identity with a correlated subquery
-- that unioned deck_cards→card_prints with deck_allocations→cards→card_prints,
-- for every public deck, on every page load. That is 34,118 shared buffers per
-- call: ~66 ms warm, but ~1 s when the buffers are cold — and it is exactly the
-- per-row card_prints join pattern that blew statement timeouts on the "my
-- decks" index before it was moved to the rollup columns.
--
-- folders.deck_color_identity is maintained by the statement-level
-- refresh_deck_rollups triggers on deck_cards/deck_allocations, and was
-- verified identical to the computed value for all 90 public decks before this
-- change. Measured after: 2,669 buffers, ~22 ms warm (12.8x less I/O, 3x
-- faster). Output is byte-identical across 15 filter/sort/paging combinations.
--
-- NOT changed: card_count. folders.deck_card_count disagrees with the RPC for
-- collection decks that still carry orphaned deck_cards rows from a since-
-- unlinked builder deck (the rollup counts those, the RPC counts
-- deck_allocations, which is the source of truth for a collection deck). Those
-- sums touch only deck_cards/deck_allocations — no card_prints join — so they
-- are not what made this slow.

create or replace function public.get_community_decks(
  p_search     text    default null,
  p_format     text    default null,
  p_colors     text[]  default null,
  p_color_mode text    default 'includes',
  p_bracket    int     default null,
  p_tags       text[]  default null,
  p_sort       text    default 'recent',
  p_limit      int     default 24,
  p_offset     int     default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_result jsonb;
  v_limit  int  := least(greatest(coalesce(p_limit, 24), 1), 48);
  v_offset int  := greatest(coalesce(p_offset, 0), 0);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
  with base as (
    select
      f.id, f.name, f.user_id, f.updated_at, f.created_at, f.type,
      meta,
      (
        meta
        - 'sync_state'
        - 'last_sync_at'
        - 'last_sync_snapshot'
        - 'unsynced_builder'
        - 'unsynced_collection'
      )::text as description,
      coalesce(meta->>'format', 'commander') as format,
      coalesce((
        select array_agg(tg order by tg)
        from jsonb_array_elements_text(
          case when jsonb_typeof(meta->'tags') = 'array' then meta->'tags' else '[]'::jsonb end
        ) tg
      ), '{}'::text[]) as tags,
      (select count(*)::int from public.deck_likes    dl  where dl.deck_id  = f.id) as like_count,
      (select count(*)::int from public.deck_comments dc2 where dc2.deck_id = f.id) as comment_count,
      case f.type
        when 'builder_deck' then (
          select coalesce(sum(dc.qty),0)::int from deck_cards dc where dc.deck_id = f.id
        )
        else (
          select coalesce(sum(da.qty),0)::int from deck_allocations da where da.deck_id = f.id
        )
      end as card_count,
      -- Cached rollup, maintained by refresh_deck_rollups. Replaces the
      -- per-card card_prints union this function used to run per deck.
      coalesce(f.deck_color_identity, '{}'::text[]) as colors
    from folders f
    cross join lateral public.safe_jsonb(f.description) meta
    where f.type in ('builder_deck', 'deck')
      and meta->>'is_public' = 'true'
      and not (
        f.type = 'deck'
        and meta->>'linked_builder_id' is not null
        and meta->>'linked_builder_id' != ''
      )
  ),
  filtered as (
    select b.*,
      case when cardinality(b.colors) = 0 then array['C']::text[] else b.colors end as norm_colors
    from base b
    where
      (v_search is null
        or b.name ilike '%' || v_search || '%'
        or coalesce(b.meta->>'commanderName', '') ilike '%' || v_search || '%'
        or exists (
          select 1 from jsonb_array_elements(
            case when jsonb_typeof(b.meta->'commanders') = 'array' then b.meta->'commanders' else '[]'::jsonb end
          ) cm where cm->>'name' ilike '%' || v_search || '%'
        )
        or exists (
          select 1 from jsonb_array_elements_text(
            case when jsonb_typeof(b.meta->'tags') = 'array' then b.meta->'tags' else '[]'::jsonb end
          ) tg where tg ilike '%' || v_search || '%'
        ))
      and (p_format is null or p_format = 'all' or b.format = p_format)
      and (p_bracket is null
        or (b.meta->>'bracket' ~ '^[0-9]+$' and (b.meta->>'bracket')::int = p_bracket))
      and (p_tags is null or cardinality(p_tags) = 0 or b.tags @> p_tags)
  ),
  color_filtered as (
    select fl.* from filtered fl
    where p_colors is null or cardinality(p_colors) = 0
      or case coalesce(p_color_mode, 'includes')
           when 'exact'   then fl.norm_colors @> p_colors and fl.norm_colors <@ p_colors
           when 'at_most' then fl.norm_colors <@ p_colors
           else                fl.norm_colors @> p_colors
         end
  ),
  page as (
    select cf.*,
      row_number() over (
        order by
          case when p_sort = 'trending'  then cf.like_count    end desc nulls last,
          case when p_sort = 'commented' then cf.comment_count end desc nulls last,
          case when p_sort = 'name'      then cf.name          end asc,
          case when p_sort = 'created'   then cf.created_at    end desc,
          cf.updated_at desc
      ) as rn
    from color_filtered cf
  )
  select jsonb_build_object(
    'total', (select count(*) from color_filtered),
    'tags', coalesce((
      select jsonb_agg(t order by t)
      from (select distinct unnest(b.tags) as t from base b) tag_list
      where t is not null and btrim(t) <> ''
    ), '[]'::jsonb),
    'decks', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',            p.id,
          'name',          p.name,
          'user_id',       p.user_id,
          'updated_at',    p.updated_at,
          'created_at',    p.created_at,
          'type',          p.type,
          'description',   p.description,
          'like_count',    p.like_count,
          'comment_count', p.comment_count,
          'card_count',    p.card_count,
          'deck_color_identity',
            case when cardinality(p.colors) = 0 then null else to_jsonb(p.colors) end
        )
        order by p.rn
      )
      from page p
      where p.rn > v_offset and p.rn <= v_offset + v_limit
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;

revoke execute on function public.get_community_decks(text, text, text[], text, int, text[], text, int, int) from public;
grant execute on function public.get_community_decks(text, text, text[], text, int, text[], text, int, int) to anon, authenticated;

notify pgrst, 'reload schema';

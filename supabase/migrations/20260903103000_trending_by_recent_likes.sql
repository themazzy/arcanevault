-- Make "Trending" mean trending, and restore deck_modified_at to this RPC.
--
-- Two separate problems, both in get_community_decks, fixed together because
-- they touch the same function.
--
-- ── 1. Trending ranked all-time likes and filtered on the wrong timestamp ────
--
-- p_sort = 'trending' ordered by total like_count with no time component, so it
-- was an all-time leaderboard. The 30-day window lived in the CLIENT, applied
-- AFTER the RPC had already truncated to p_limit rows, with no backfill — so
-- dropping a stale row left the headliner short rather than promoting the next
-- deck. On 2026-09-03 that rendered 2 tiles instead of 3.
--
-- Worse, the client's window measured when the deck was last EDITED, not when
-- it was last LIKED. The most-liked deck in the app ("Dinos", 2 likes) had been
-- liked that morning and was excluded because its card list had not changed in
-- 41 days — the exact deck the section exists to show.
--
-- deck_likes.created_at has been recorded since the table was created and was
-- never read. Trending now ranks on likes inside the window, ties broken by
-- all-time likes.
--
-- p_recent_days does the filtering, and is deliberately NOT inferred from
-- p_sort: 'trending' is also a user-selectable sort for the whole community
-- grid, and hiding every deck without a recent like would empty that list. The
-- 3-tile headliner passes it; the sort dropdown does not, and just gets the
-- better ordering.
--
-- ── 2. deck_modified_at was dropped from this function by accident ───────────
--
-- 20260716105158_meaningful_deck_modified_at added folders.deck_modified_at
-- precisely because folders.updated_at is touched by metadata backfills,
-- cover-art caching, bracket analysis and rollup refreshes. That migration's
-- version of this function selected it, ordered by it, and returned it. The two
-- 2026-08-02 rewrites (tag filter, then color rollup) rebuilt the function from
-- an older copy and silently lost all three.
--
-- Consequences, both live until now:
--   * the client's `deck.deck_modified_at || deck.updated_at` fell through to
--     updated_at on every row, because the field was no longer in the payload;
--   * the community "Recent" sort (which lands on the fallthrough ordering)
--     ranked partly by background maintenance writes.

-- Supports the windowed count below. Note deck_likes_deck_idx (deck_id) is
-- already redundant with the primary key (deck_id, user_id) and is now doubly
-- so; left in place rather than dropped as part of an unrelated change.
create index if not exists deck_likes_deck_created_idx
  on public.deck_likes (deck_id, created_at desc);

-- The signature gains a parameter, so the 9-arg version has to go rather than
-- be left behind as an overload PostgREST could resolve to.
drop function if exists public.get_community_decks(text, text, text[], text, int, text[], text, int, int);

create or replace function public.get_community_decks(
  p_search      text    default null,
  p_format      text    default null,
  p_colors      text[]  default null,
  p_color_mode  text    default 'includes',
  p_bracket     int     default null,
  p_tags        text[]  default null,
  p_sort        text    default 'recent',
  p_limit       int     default 24,
  p_offset      int     default 0,
  p_recent_days int     default null
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
  -- Window used for RANKING. Always applied, so the trending sort is
  -- time-aware even when the caller does not ask for filtering.
  v_days   int  := least(greatest(coalesce(p_recent_days, 30), 1), 365);
  -- Window used for FILTERING. Only when the caller explicitly asked.
  v_recent_only boolean := p_recent_days is not null;
  v_since  timestamptz;
begin
  v_since := now() - make_interval(days => v_days);

  with base as (
    select
      f.id, f.name, f.user_id, f.updated_at, f.deck_modified_at, f.created_at, f.type,
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
      -- Likes inside the window: what "trending" actually means.
      (
        select count(*)::int from public.deck_likes dl
        where dl.deck_id = f.id and dl.created_at >= v_since
      ) as recent_like_count,
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
      -- Applied here, before the limit and before 'total', so a caller asking
      -- for a fixed number of trending decks gets that many whenever they exist.
      and (not v_recent_only or b.recent_like_count > 0)
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
          -- Recent likes first, all-time likes only as the tiebreak.
          case when p_sort = 'trending'  then cf.recent_like_count end desc nulls last,
          case when p_sort = 'trending'  then cf.like_count        end desc nulls last,
          case when p_sort = 'commented' then cf.comment_count     end desc nulls last,
          case when p_sort = 'name'      then cf.name              end asc,
          case when p_sort = 'created'   then cf.created_at        end desc,
          -- Meaningful deck recency, NOT folders.updated_at: the latter moves
          -- on metadata backfills, cover-art caching and rollup refreshes.
          cf.deck_modified_at desc
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
          'id',                p.id,
          'name',              p.name,
          'user_id',           p.user_id,
          'updated_at',        p.updated_at,
          'deck_modified_at',  p.deck_modified_at,
          'created_at',        p.created_at,
          'type',              p.type,
          'description',       p.description,
          'like_count',        p.like_count,
          'recent_like_count', p.recent_like_count,
          'comment_count',     p.comment_count,
          'card_count',        p.card_count,
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

revoke execute on function public.get_community_decks(text, text, text[], text, int, text[], text, int, int, int) from public;
grant execute on function public.get_community_decks(text, text, text[], text, int, text[], text, int, int, int) to anon, authenticated;

notify pgrst, 'reload schema';

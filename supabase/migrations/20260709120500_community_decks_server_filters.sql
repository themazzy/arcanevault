-- Server-side filtering, sorting, and pagination for the community deck
-- browser. Replaces the zero-arg get_community_decks() (which capped the feed
-- at the 100 most recent decks and forced all filtering client-side).
--
-- Returns: { "total": <matching deck count>, "decks": [ ... ] }
-- Deck payload matches the old function plus card_count.
-- Color modes ('includes' | 'exact' | 'at_most') mirror matchColorIdentity in
-- src/lib/deckIndexFilters.js — a deck with no colors is treated as {C} so the
-- colorless pip works.

drop function if exists public.get_community_decks();

create or replace function public.get_community_decks(
  p_search     text    default null,
  p_format     text    default null,
  p_colors     text[]  default null,
  p_color_mode text    default 'includes',
  p_bracket    int     default null,
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
      coalesce((
        select array_agg(distinct ci order by ci)
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
      ), '{}'::text[]) as colors
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

revoke execute on function public.get_community_decks(text, text, text[], text, int, text, int, int) from public;
grant execute on function public.get_community_decks(text, text, text[], text, int, text, int, int) to anon, authenticated;

notify pgrst, 'reload schema';

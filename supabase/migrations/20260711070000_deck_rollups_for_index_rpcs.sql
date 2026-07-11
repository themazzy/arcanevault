-- Deck rollups: cache color identity + card count per deck on the folders row.
--
-- get_community_decks / get_my_decks recomputed both aggregates on every call
-- by joining every deck card to card_prints (~87k buffer touches for 44
-- decks). Warm that runs in ~150ms, but during an I/O storm (autovacuum on
-- card_prints/card_prices right after the nightly price sync) the cold run
-- took ~4s and blew the statement timeout — 500s on the Builder index
-- (2026-07-11 06:05 UTC). Aggregates now update on WRITE (statement-level
-- triggers on deck_cards/deck_allocations, one recompute per touched deck),
-- and the index RPCs read the cached columns.
--
-- Color identity is an oracle property (identical across printings), so
-- printing swaps never change it; add/remove/qty changes are all these
-- triggers need to see.

alter table public.folders
  add column if not exists deck_color_identity text[] not null default '{}'::text[],
  add column if not exists deck_card_count int not null default 0;

-- ── Rollup recompute ──────────────────────────────────────────────────────────
create or replace function public.refresh_deck_rollups(p_deck_ids uuid[])
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.folders f set
    deck_color_identity = coalesce((
      select array_agg(distinct ci order by ci)
      from (
        select unnest(cp.color_identity) as ci
        from public.deck_cards dc
        join public.card_prints cp on cp.id = dc.card_print_id
        where dc.deck_id = f.id
        union
        select unnest(cp.color_identity) as ci
        from public.deck_allocations da
        join public.cards c on c.id = da.card_id
        join public.card_prints cp on cp.id = c.card_print_id
        where da.deck_id = f.id
      ) colors
      where ci in ('W','U','B','R','G','C')
    ), '{}'::text[]),
    deck_card_count = case f.type
      when 'builder_deck' then coalesce((select sum(dc.qty)::int from public.deck_cards dc where dc.deck_id = f.id), 0)
      else coalesce((select sum(da.qty)::int from public.deck_allocations da where da.deck_id = f.id), 0)
    end
  where f.id = any(p_deck_ids);
$$;

revoke all on function public.refresh_deck_rollups(uuid[]) from public, anon, authenticated;

-- ── Statement-level triggers ──────────────────────────────────────────────────
-- Transition-table names are fixed per trigger, so INSERT/DELETE/UPDATE each
-- get a small dedicated function. All three work for any table with a deck_id
-- column (deck_cards and deck_allocations).
create or replace function public.deck_rollup_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.refresh_deck_rollups(array(select distinct deck_id from new_rows where deck_id is not null));
  return null;
end;
$$;

create or replace function public.deck_rollup_on_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.refresh_deck_rollups(array(select distinct deck_id from old_rows where deck_id is not null));
  return null;
end;
$$;

create or replace function public.deck_rollup_on_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.refresh_deck_rollups(array(
    select distinct deck_id from (
      select deck_id from new_rows
      union all
      select deck_id from old_rows
    ) x
    where deck_id is not null
  ));
  return null;
end;
$$;

revoke all on function public.deck_rollup_on_insert() from public, anon, authenticated;
revoke all on function public.deck_rollup_on_delete() from public, anon, authenticated;
revoke all on function public.deck_rollup_on_update() from public, anon, authenticated;

drop trigger if exists deck_cards_rollup_ins on public.deck_cards;
drop trigger if exists deck_cards_rollup_del on public.deck_cards;
drop trigger if exists deck_cards_rollup_upd on public.deck_cards;
create trigger deck_cards_rollup_ins
  after insert on public.deck_cards
  referencing new table as new_rows
  for each statement execute function public.deck_rollup_on_insert();
create trigger deck_cards_rollup_del
  after delete on public.deck_cards
  referencing old table as old_rows
  for each statement execute function public.deck_rollup_on_delete();
create trigger deck_cards_rollup_upd
  after update on public.deck_cards
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.deck_rollup_on_update();

drop trigger if exists deck_allocations_rollup_ins on public.deck_allocations;
drop trigger if exists deck_allocations_rollup_del on public.deck_allocations;
drop trigger if exists deck_allocations_rollup_upd on public.deck_allocations;
create trigger deck_allocations_rollup_ins
  after insert on public.deck_allocations
  referencing new table as new_rows
  for each statement execute function public.deck_rollup_on_insert();
create trigger deck_allocations_rollup_del
  after delete on public.deck_allocations
  referencing old table as old_rows
  for each statement execute function public.deck_rollup_on_delete();
create trigger deck_allocations_rollup_upd
  after update on public.deck_allocations
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.deck_rollup_on_update();

-- ── Backfill existing decks ───────────────────────────────────────────────────
select public.refresh_deck_rollups(array(
  select id from public.folders where type in ('builder_deck','deck')
));

-- ── get_community_decks: read the cached rollups ─────────────────────────────
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
      f.deck_card_count as card_count,
      f.deck_color_identity as colors
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

-- ── get_my_decks: read the cached rollups ────────────────────────────────────
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
      'card_count', f.deck_card_count,
      'deck_color_identity',
        case when cardinality(f.deck_color_identity) = 0 then null
             else to_jsonb(f.deck_color_identity) end
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

notify pgrst, 'reload schema';

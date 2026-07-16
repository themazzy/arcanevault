-- Keep deck-index recency separate from folders.updated_at. The latter is an
-- internal sync/maintenance timestamp and is intentionally touched by metadata
-- backfills, cover-art caching, bracket analysis, and rollup refreshes.
--
-- deck_modified_at advances only when:
--   * the deck name changes;
--   * public/private visibility changes; or
--   * a meaningful deck_cards/deck_allocations row changes.

alter table public.folders
  add column if not exists deck_modified_at timestamptz;

update public.folders
set deck_modified_at = coalesce(updated_at, created_at, now())
where deck_modified_at is null;

alter table public.folders
  alter column deck_modified_at set default now(),
  alter column deck_modified_at set not null;

create or replace function public.mark_deck_modified_from_folder_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  v_old_public boolean := coalesce(public.safe_jsonb(old.description)->>'is_public' = 'true', false);
  v_new_public boolean := coalesce(public.safe_jsonb(new.description)->>'is_public' = 'true', false);
begin
  if new.type in ('builder_deck', 'deck')
     and (
       old.name is distinct from new.name
       or v_old_public is distinct from v_new_public
     ) then
    new.deck_modified_at := now();
  end if;
  return new;
end;
$function$;

revoke all on function public.mark_deck_modified_from_folder_change() from public, anon, authenticated;

drop trigger if exists folders_meaningful_deck_change on public.folders;
create trigger folders_meaningful_deck_change
  before update on public.folders
  for each row execute function public.mark_deck_modified_from_folder_change();

-- Transition-table triggers keep this statement-level: bulk imports, syncs,
-- and removals advance a deck once, regardless of how many rows they touch.
create or replace function public.mark_decks_modified_on_card_insert()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  update public.folders f
  set deck_modified_at = now()
  where f.id in (select distinct deck_id from new_rows where deck_id is not null)
    and (
      (tg_table_name = 'deck_cards' and f.type = 'builder_deck')
      or (tg_table_name = 'deck_allocations' and f.type = 'deck')
    );
  return null;
end;
$function$;

create or replace function public.mark_decks_modified_on_card_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  update public.folders f
  set deck_modified_at = now()
  where f.id in (select distinct deck_id from old_rows where deck_id is not null)
    and (
      (tg_table_name = 'deck_cards' and f.type = 'builder_deck')
      or (tg_table_name = 'deck_allocations' and f.type = 'deck')
    );
  return null;
end;
$function$;

create or replace function public.mark_decks_modified_on_card_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  update public.folders f
  set deck_modified_at = now()
  where f.id in (
    select distinct changed.deck_id
    from (
      select o.deck_id
      from old_rows o
      full join new_rows n using (id)
      where (to_jsonb(o) - array['created_at', 'updated_at'])
        is distinct from
        (to_jsonb(n) - array['created_at', 'updated_at'])
      union
      select n.deck_id
      from old_rows o
      full join new_rows n using (id)
      where (to_jsonb(o) - array['created_at', 'updated_at'])
        is distinct from
        (to_jsonb(n) - array['created_at', 'updated_at'])
    ) changed
    where changed.deck_id is not null
  )
    and (
      (tg_table_name = 'deck_cards' and f.type = 'builder_deck')
      or (tg_table_name = 'deck_allocations' and f.type = 'deck')
    );
  return null;
end;
$function$;

revoke all on function public.mark_decks_modified_on_card_insert() from public, anon, authenticated;
revoke all on function public.mark_decks_modified_on_card_delete() from public, anon, authenticated;
revoke all on function public.mark_decks_modified_on_card_update() from public, anon, authenticated;

drop trigger if exists deck_cards_meaningful_ins on public.deck_cards;
drop trigger if exists deck_cards_meaningful_del on public.deck_cards;
drop trigger if exists deck_cards_meaningful_upd on public.deck_cards;
create trigger deck_cards_meaningful_ins
  after insert on public.deck_cards
  referencing new table as new_rows
  for each statement execute function public.mark_decks_modified_on_card_insert();
create trigger deck_cards_meaningful_del
  after delete on public.deck_cards
  referencing old table as old_rows
  for each statement execute function public.mark_decks_modified_on_card_delete();
create trigger deck_cards_meaningful_upd
  after update on public.deck_cards
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.mark_decks_modified_on_card_update();

drop trigger if exists deck_allocations_meaningful_ins on public.deck_allocations;
drop trigger if exists deck_allocations_meaningful_del on public.deck_allocations;
drop trigger if exists deck_allocations_meaningful_upd on public.deck_allocations;
create trigger deck_allocations_meaningful_ins
  after insert on public.deck_allocations
  referencing new table as new_rows
  for each statement execute function public.mark_decks_modified_on_card_insert();
create trigger deck_allocations_meaningful_del
  after delete on public.deck_allocations
  referencing old table as old_rows
  for each statement execute function public.mark_decks_modified_on_card_delete();
create trigger deck_allocations_meaningful_upd
  after update on public.deck_allocations
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.mark_decks_modified_on_card_update();

-- Community index: recent order and its tie-breakers use meaningful changes.
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
          cf.deck_modified_at desc
      ) as rn
    from color_filtered cf
  )
  select jsonb_build_object(
    'total', (select count(*) from color_filtered),
    'decks', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',               p.id,
          'name',             p.name,
          'user_id',          p.user_id,
          'updated_at',       p.updated_at,
          'deck_modified_at', p.deck_modified_at,
          'created_at',       p.created_at,
          'type',             p.type,
          'description',      p.description,
          'like_count',       p.like_count,
          'comment_count',    p.comment_count,
          'card_count',       p.card_count,
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

-- My Decks: expose both timestamps for compatibility, but order by the
-- meaningful one. The client also uses deck_modified_at for local sorting.
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
      'deck_modified_at',    f.deck_modified_at,
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
    order by f.deck_modified_at desc
  ) into v_result
  from folders f
  cross join lateral public.safe_jsonb(f.description) meta
  where f.user_id = v_user_id
    and f.type in ('builder_deck', 'deck')
    and (meta->>'isGroup')         is distinct from 'true'
    and (meta->>'hideFromBuilder') is distinct from 'true'
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

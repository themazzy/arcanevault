-- Atomic deck metadata writes. folders.description remains text for backwards
-- compatibility, but every mutation below locks the row and patches only the
-- intended JSON keys so concurrent UI actions cannot overwrite each other.

create or replace function public.patch_deck_meta(
  p_folder_id uuid,
  p_patch jsonb default '{}'::jsonb,
  p_remove_keys text[] default '{}'::text[]
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_owner uuid;
  v_meta jsonb;
  v_key text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select f.user_id, public.safe_jsonb(f.description)
  into v_owner, v_meta
  from public.folders f
  where f.id = p_folder_id
  for update;

  if v_owner is null or v_owner is distinct from auth.uid() then
    raise exception 'Deck not found' using errcode = '42501';
  end if;

  v_meta := coalesce(v_meta, '{}'::jsonb) || coalesce(p_patch, '{}'::jsonb);
  foreach v_key in array coalesce(p_remove_keys, '{}'::text[]) loop
    v_meta := v_meta - v_key;
  end loop;

  update public.folders
  set description = v_meta::text,
      updated_at = now()
  where id = p_folder_id
    and user_id = auth.uid();

  if not found then
    raise exception 'Deck metadata update failed' using errcode = '42501';
  end if;

  return v_meta;
end;
$function$;

revoke all on function public.patch_deck_meta(uuid, jsonb, text[]) from public;
grant execute on function public.patch_deck_meta(uuid, jsonb, text[]) to authenticated;

create or replace function public.link_deck_pair(
  p_builder_id uuid,
  p_collection_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_builder public.folders%rowtype;
  v_collection public.folders%rowtype;
  v_builder_meta jsonb;
  v_collection_meta jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_builder_id = p_collection_id then
    raise exception 'A deck cannot link to itself' using errcode = '22023';
  end if;

  -- Stable lock ordering avoids deadlocks when two requests touch the pair.
  perform 1
  from public.folders f
  where f.id in (p_builder_id, p_collection_id)
  order by f.id
  for update;

  select * into v_builder from public.folders where id = p_builder_id;
  select * into v_collection from public.folders where id = p_collection_id;

  if v_builder.id is null or v_collection.id is null
     or v_builder.user_id is distinct from auth.uid()
     or v_collection.user_id is distinct from auth.uid() then
    raise exception 'Deck pair not found' using errcode = '42501';
  end if;
  if v_builder.type <> 'builder_deck' or v_collection.type <> 'deck' then
    raise exception 'Invalid deck pair types' using errcode = '22023';
  end if;

  v_builder_meta := public.safe_jsonb(v_builder.description);
  v_collection_meta := public.safe_jsonb(v_collection.description);

  if nullif(v_builder_meta->>'linked_deck_id', '') is not null
     and v_builder_meta->>'linked_deck_id' <> p_collection_id::text then
    raise exception 'Builder deck is already linked to another deck' using errcode = '23505';
  end if;
  if nullif(v_collection_meta->>'linked_builder_id', '') is not null
     and v_collection_meta->>'linked_builder_id' <> p_builder_id::text then
    raise exception 'Collection deck is already linked to another builder' using errcode = '23505';
  end if;

  v_builder_meta := v_builder_meta || jsonb_build_object('linked_deck_id', p_collection_id::text);
  v_collection_meta := v_collection_meta || jsonb_build_object('linked_builder_id', p_builder_id::text);

  update public.folders
  set description = case id
        when p_builder_id then v_builder_meta::text
        else v_collection_meta::text
      end,
      updated_at = now()
  where id in (p_builder_id, p_collection_id)
    and user_id = auth.uid();

  if (select count(*) from public.folders where id in (p_builder_id, p_collection_id) and user_id = auth.uid()) <> 2 then
    raise exception 'Deck pair update failed' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'builder_id', p_builder_id,
    'collection_id', p_collection_id,
    'builder_meta', v_builder_meta,
    'collection_meta', v_collection_meta
  );
end;
$function$;

revoke all on function public.link_deck_pair(uuid, uuid) from public;
grant execute on function public.link_deck_pair(uuid, uuid) to authenticated;

create or replace function public.set_linked_deck_visibility(
  p_deck_id uuid,
  p_is_public boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_source public.folders%rowtype;
  v_counterpart public.folders%rowtype;
  v_source_meta jsonb;
  v_counterpart_meta jsonb;
  v_counterpart_id uuid;
  v_reverse_ids uuid[];
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_source
  from public.folders
  where id = p_deck_id;

  if v_source.id is null or v_source.user_id is distinct from auth.uid()
     or v_source.type not in ('builder_deck', 'deck') then
    raise exception 'Deck not found' using errcode = '42501';
  end if;

  v_source_meta := public.safe_jsonb(v_source.description);
  if v_source.type = 'builder_deck' then
    select f.id into v_counterpart_id
    from public.folders f
    where f.id::text = nullif(v_source_meta->>'linked_deck_id', '')
      and f.user_id = auth.uid()
      and f.type = 'deck';

    if v_counterpart_id is null then
      select array_agg(f.id order by f.id) into v_reverse_ids
      from public.folders f
      where f.user_id = auth.uid()
        and f.type = 'deck'
        and public.safe_jsonb(f.description)->>'linked_builder_id' = p_deck_id::text;
    end if;
  else
    select f.id into v_counterpart_id
    from public.folders f
    where f.id::text = nullif(v_source_meta->>'linked_builder_id', '')
      and f.user_id = auth.uid()
      and f.type = 'builder_deck';

    if v_counterpart_id is null then
      select array_agg(f.id order by f.id) into v_reverse_ids
      from public.folders f
      where f.user_id = auth.uid()
        and f.type = 'builder_deck'
        and public.safe_jsonb(f.description)->>'linked_deck_id' = p_deck_id::text;
    end if;
  end if;

  if v_counterpart_id is null and coalesce(array_length(v_reverse_ids, 1), 0) > 1 then
    raise exception 'Deck has multiple linked counterparts' using errcode = '23505';
  end if;
  v_counterpart_id := coalesce(v_counterpart_id, v_reverse_ids[1]);

  perform 1
  from public.folders f
  where f.id = p_deck_id or f.id = v_counterpart_id
  order by f.id
  for update;

  -- Re-read after locking so the patch is based on the latest metadata.
  select * into v_source from public.folders where id = p_deck_id;
  v_source_meta := public.safe_jsonb(v_source.description)
    || jsonb_build_object('is_public', p_is_public);

  if v_counterpart_id is not null then
    select * into v_counterpart from public.folders where id = v_counterpart_id;
    if v_counterpart.id is null or v_counterpart.user_id is distinct from auth.uid() then
      raise exception 'Linked counterpart not found' using errcode = '42501';
    end if;
    v_counterpart_meta := public.safe_jsonb(v_counterpart.description)
      || jsonb_build_object('is_public', p_is_public);
  end if;

  update public.folders
  set description = v_source_meta::text,
      updated_at = now()
  where id = p_deck_id and user_id = auth.uid();

  if v_counterpart_id is not null then
    update public.folders
    set description = v_counterpart_meta::text,
        updated_at = now()
    where id = v_counterpart_id and user_id = auth.uid();
    if not found then
      raise exception 'Linked visibility update failed' using errcode = '42501';
    end if;
  end if;

  return jsonb_build_object(
    'deck_id', p_deck_id,
    'deck_meta', v_source_meta,
    'counterpart_id', v_counterpart_id,
    'counterpart_meta', v_counterpart_meta
  );
end;
$function$;

revoke all on function public.set_linked_deck_visibility(uuid, boolean) from public;
grant execute on function public.set_linked_deck_visibility(uuid, boolean) to authenticated;

-- Keep My Decks deduplicated even if legacy data has only the collection side
-- of a pair. The collection tile remains canonical and navigates to its builder.
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
    and (meta->>'isGroup') is distinct from 'true'
    and (meta->>'hideFromBuilder') is distinct from 'true'
    and not (
      f.type = 'builder_deck'
      and exists (
        select 1
        from public.folders collection
        where collection.user_id = v_user_id
          and collection.type = 'deck'
          and (
            collection.id::text = nullif(meta->>'linked_deck_id', '')
            or public.safe_jsonb(collection.description)->>'linked_builder_id' = f.id::text
          )
      )
    )
  limit 500;

  return coalesce(v_result, '[]'::jsonb);
end;
$function$;

revoke execute on function public.get_my_decks() from public;
revoke execute on function public.get_my_decks() from anon;
grant execute on function public.get_my_decks() to authenticated;

notify pgrst, 'reload schema';

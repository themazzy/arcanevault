-- Rename a folder, carrying the name across a linked deck pair.
--
-- A builder deck and its collection deck are two `folders` rows. Every rename
-- entry point wrote `name` to one row, so renaming from DeckBuilder left the
-- collection deck (and the /builder index tile, which renders the collection
-- side of a linked pair) on the old name. The mismatch was invisible from the
-- collection side, where the rename happens to be the row those surfaces read.
--
-- Same counterpart resolution as set_linked_deck_visibility / _bracket: follow
-- the id in the description blob, fall back to a reverse lookup for a
-- half-written link, and refuse when the reverse lookup is ambiguous rather
-- than renaming an arbitrary deck.
--
-- Accepts any folder type so a single client helper covers binders and
-- wishlists too; propagation only ever applies to deck pairs.
create or replace function public.rename_folder(
  p_folder_id uuid,
  p_name text
)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_source         public.folders%rowtype;
  v_source_meta    jsonb;
  v_counterpart_id uuid;
  v_reverse_ids    uuid[];
  v_name           text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  v_name := btrim(coalesce(p_name, ''));
  if v_name = '' then
    raise exception 'Name cannot be empty' using errcode = '22023';
  end if;
  v_name := left(v_name, 100);

  select * into v_source from public.folders where id = p_folder_id;
  if v_source.id is null or v_source.user_id is distinct from auth.uid() then
    raise exception 'Folder not found' using errcode = '42501';
  end if;

  if v_source.type in ('builder_deck', 'deck') then
    v_source_meta := public.safe_jsonb(v_source.description);
    if v_source.type = 'builder_deck' then
      select f.id into v_counterpart_id
      from public.folders f
      where f.id = public.safe_uuid(nullif(v_source_meta->>'linked_deck_id', ''))
        and f.user_id = auth.uid()
        and f.type = 'deck';

      if v_counterpart_id is null then
        select array_agg(f.id order by f.id) into v_reverse_ids
        from public.folders f
        where f.user_id = auth.uid()
          and f.type = 'deck'
          and public.safe_jsonb(f.description)->>'linked_builder_id' = p_folder_id::text;
      end if;
    else
      select f.id into v_counterpart_id
      from public.folders f
      where f.id = public.safe_uuid(nullif(v_source_meta->>'linked_builder_id', ''))
        and f.user_id = auth.uid()
        and f.type = 'builder_deck';

      if v_counterpart_id is null then
        select array_agg(f.id order by f.id) into v_reverse_ids
        from public.folders f
        where f.user_id = auth.uid()
          and f.type = 'builder_deck'
          and public.safe_jsonb(f.description)->>'linked_deck_id' = p_folder_id::text;
      end if;
    end if;

    if v_counterpart_id is null and coalesce(array_length(v_reverse_ids, 1), 0) > 1 then
      raise exception 'Deck has multiple linked counterparts' using errcode = '23505';
    end if;
    v_counterpart_id := coalesce(v_counterpart_id, v_reverse_ids[1]);
  end if;

  update public.folders
  set name = v_name, updated_at = now()
  where id = p_folder_id and user_id = auth.uid();

  if v_counterpart_id is not null then
    update public.folders
    set name = v_name, updated_at = now()
    where id = v_counterpart_id and user_id = auth.uid();
  end if;

  return jsonb_build_object(
    'folder_id', p_folder_id,
    'name', v_name,
    'counterpart_id', v_counterpart_id
  );
end;
$function$;

revoke execute on function public.rename_folder(uuid, text) from anon;
grant execute on function public.rename_folder(uuid, text) to authenticated;

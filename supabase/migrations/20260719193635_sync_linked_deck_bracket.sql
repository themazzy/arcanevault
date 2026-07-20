-- Keep Commander bracket metadata identical on both halves of a linked deck.
-- The builder deck remains the source of recalculation, while collection-deck
-- browsers read their own folder metadata for an instant badge render.

create or replace function public.set_linked_deck_bracket(
  p_deck_id uuid,
  p_bracket integer default null,
  p_manual boolean default false
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
  if p_bracket is not null and p_bracket not between 1 and 5 then
    raise exception 'Bracket must be between 1 and 5' using errcode = '22023';
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

  -- Re-read after locking so unrelated concurrent metadata edits are retained.
  select * into v_source from public.folders where id = p_deck_id;
  v_source_meta := public.safe_jsonb(v_source.description);
  if p_bracket is null then
    v_source_meta := v_source_meta - 'bracket' - 'bracketManual';
  else
    v_source_meta := v_source_meta || jsonb_build_object(
      'bracket', p_bracket,
      'bracketManual', coalesce(p_manual, false)
    );
  end if;

  if v_counterpart_id is not null then
    select * into v_counterpart from public.folders where id = v_counterpart_id;
    if v_counterpart.id is null or v_counterpart.user_id is distinct from auth.uid() then
      raise exception 'Linked counterpart not found' using errcode = '42501';
    end if;
    v_counterpart_meta := public.safe_jsonb(v_counterpart.description);
    if p_bracket is null then
      v_counterpart_meta := v_counterpart_meta - 'bracket' - 'bracketManual';
    else
      v_counterpart_meta := v_counterpart_meta || jsonb_build_object(
        'bracket', p_bracket,
        'bracketManual', coalesce(p_manual, false)
      );
    end if;
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
      raise exception 'Linked bracket update failed' using errcode = '42501';
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

revoke all on function public.set_linked_deck_bracket(uuid, integer, boolean) from public;
grant execute on function public.set_linked_deck_bracket(uuid, integer, boolean) to authenticated;

-- Backfill collection halves of existing linked pairs. Builder metadata wins
-- because it is where the bracket analyzer and manual override live.
update public.folders as collection
set description = (
      public.safe_jsonb(collection.description)
      || jsonb_build_object(
        'bracket', public.safe_jsonb(builder.description)->'bracket',
        'bracketManual', coalesce(
          public.safe_jsonb(builder.description)->'bracketManual',
          'false'::jsonb
        )
      )
    )::text,
    updated_at = now()
from public.folders as builder
where collection.type = 'deck'
  and builder.type = 'builder_deck'
  and collection.user_id = builder.user_id
  and (
    public.safe_jsonb(collection.description)->>'linked_builder_id' = builder.id::text
    or public.safe_jsonb(builder.description)->>'linked_deck_id' = collection.id::text
  )
  and public.safe_jsonb(builder.description)->'bracket' is not null
  and (
    public.safe_jsonb(collection.description)->'bracket'
      is distinct from public.safe_jsonb(builder.description)->'bracket'
    or public.safe_jsonb(collection.description)->'bracketManual'
      is distinct from coalesce(
        public.safe_jsonb(builder.description)->'bracketManual',
        'false'::jsonb
      )
  );

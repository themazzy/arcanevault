-- link_deck_pair: carry recorded games onto the builder identity when a pair forms.
--
-- The Deck Builder is the superset of a user's decks — theorycrafted, built, or
-- partly built — while a collection deck holds only cards they physically own. The
-- life tracker therefore offers the /builder list, and a collection deck with no
-- builder counterpart is played against its own folder id, because that is the only
-- identity it has.
--
-- Pairing it later used to orphan that history: the tracker starts attributing to
-- the builder id, and /builder/:id reads win rates with
-- `game_results.deck_id = <builder folder id>`, so the earlier games vanish from the
-- deck's win rate while still sitting in Stats under the collection id.
--
-- Repointing here rather than in the client covers every path that creates a link
-- (Make Collection Deck, Edit in Builder, and the adopt-on-name-conflict flow) plus
-- any added later, and it happens in the same transaction as the link itself.
--
-- deck_name is deliberately left alone: it is the historical label for that game.

create or replace function public.link_deck_pair(p_builder_id uuid, p_collection_id uuid)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_builder public.folders%rowtype;
  v_collection public.folders%rowtype;
  v_builder_meta jsonb;
  v_collection_meta jsonb;
  v_migrated_results integer := 0;
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

  -- Games recorded against the collection deck belong to the paired builder deck
  -- from here on. Scoped to the caller's own rows; game_results RLS is owner-only
  -- and this function runs as the caller, not as definer.
  update public.game_results
  set deck_id = p_builder_id
  where deck_id = p_collection_id
    and user_id = auth.uid();
  get diagnostics v_migrated_results = row_count;

  return jsonb_build_object(
    'builder_id', p_builder_id,
    'collection_id', p_collection_id,
    'builder_meta', v_builder_meta,
    'collection_meta', v_collection_meta,
    'migrated_results', v_migrated_results
  );
end;
$function$;

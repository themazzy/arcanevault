begin;

-- Preserve the touched rows for the duration of this session. Any failed
-- precondition aborts the transaction before production data changes commit.
create temp table deck_pair_repair_before on commit preserve rows as
select f.id, f.user_id, f.name, f.type, f.description
from public.folders f
where f.type in ('builder_deck', 'deck')
  and (
    nullif(public.safe_jsonb(f.description)->>'linked_deck_id', '') is not null
    or nullif(public.safe_jsonb(f.description)->>'linked_builder_id', '') is not null
  );

do $preflight$
begin
  if exists (
    select 1
    from public.folders builder
    join public.folders collection
      on public.safe_jsonb(collection.description)->>'linked_builder_id' = builder.id::text
    where builder.type = 'builder_deck'
      and collection.type = 'deck'
      and builder.user_id = collection.user_id
    group by builder.id
    having count(*) > 1
  ) then
    raise exception 'Repair blocked: a builder has multiple collection counterparts';
  end if;

  if exists (
    select 1
    from public.folders collection
    join public.folders builder
      on public.safe_jsonb(builder.description)->>'linked_deck_id' = collection.id::text
    where builder.type = 'builder_deck'
      and collection.type = 'deck'
      and builder.user_id = collection.user_id
    group by collection.id
    having count(*) > 1
  ) then
    raise exception 'Repair blocked: a collection deck has multiple builder counterparts';
  end if;
end;
$preflight$;

-- Remove links to deleted or invalid counterparts. Sync state is meaningless
-- without a pair and would otherwise keep the deck looking linked.
update public.folders builder
set description = (
      public.safe_jsonb(builder.description)
      - 'linked_deck_id'
      - 'sync_state'
      - 'last_sync_at'
      - 'last_sync_snapshot'
      - 'unsynced_builder'
      - 'unsynced_collection'
    )::text,
    updated_at = now()
where builder.type = 'builder_deck'
  and nullif(public.safe_jsonb(builder.description)->>'linked_deck_id', '') is not null
  and not exists (
    select 1
    from public.folders collection
    where collection.id::text = public.safe_jsonb(builder.description)->>'linked_deck_id'
      and collection.type = 'deck'
      and collection.user_id = builder.user_id
  );

update public.folders collection
set description = (
      public.safe_jsonb(collection.description)
      - 'linked_builder_id'
      - 'sync_state'
      - 'last_sync_at'
      - 'last_sync_snapshot'
      - 'unsynced_builder'
      - 'unsynced_collection'
    )::text,
    updated_at = now()
where collection.type = 'deck'
  and nullif(public.safe_jsonb(collection.description)->>'linked_builder_id', '') is not null
  and not exists (
    select 1
    from public.folders builder
    where builder.id::text = public.safe_jsonb(collection.description)->>'linked_builder_id'
      and builder.type = 'builder_deck'
      and builder.user_id = collection.user_id
  );

-- Restore the missing side when one valid side identifies an unambiguous pair.
update public.folders builder
set description = (
      public.safe_jsonb(builder.description)
      || jsonb_build_object('linked_deck_id', collection.id::text)
    )::text,
    updated_at = now()
from public.folders collection
where builder.type = 'builder_deck'
  and collection.type = 'deck'
  and builder.user_id = collection.user_id
  and public.safe_jsonb(collection.description)->>'linked_builder_id' = builder.id::text
  and nullif(public.safe_jsonb(builder.description)->>'linked_deck_id', '') is null;

update public.folders collection
set description = (
      public.safe_jsonb(collection.description)
      || jsonb_build_object('linked_builder_id', builder.id::text)
    )::text,
    updated_at = now()
from public.folders builder
where collection.type = 'deck'
  and builder.type = 'builder_deck'
  and collection.user_id = builder.user_id
  and public.safe_jsonb(builder.description)->>'linked_deck_id' = collection.id::text
  and nullif(public.safe_jsonb(collection.description)->>'linked_builder_id', '') is null;

create temp table deck_pair_visibility on commit preserve rows as
select
  builder.id as builder_id,
  collection.id as collection_id,
  case latest.detail
    when 'Made public' then true
    when 'Made private' then false
    else false
  end as is_public,
  latest.detail as source_action
from public.folders builder
join public.folders collection
  on collection.id::text = public.safe_jsonb(builder.description)->>'linked_deck_id'
 and public.safe_jsonb(collection.description)->>'linked_builder_id' = builder.id::text
 and collection.user_id = builder.user_id
 and collection.type = 'deck'
left join lateral (
  select changes.detail
  from public.deck_changes changes
  where changes.action = 'Visibility'
    and changes.user_id = builder.user_id
    and changes.deck_id in (builder.id, collection.id)
  order by changes.created_at desc
  limit 1
) latest on true
where builder.type = 'builder_deck';

-- Latest recorded user action wins. Pairs without history default to private.
update public.folders folder
set description = (
      public.safe_jsonb(folder.description)
      || jsonb_build_object('is_public', pair.is_public)
    )::text,
    updated_at = now()
from deck_pair_visibility pair
where folder.id in (pair.builder_id, pair.collection_id);

commit;

select jsonb_build_object(
  'captured_rows', (select count(*) from deck_pair_repair_before),
  'repaired_pairs', (select count(*) from deck_pair_visibility),
  'public_pairs', (select count(*) from deck_pair_visibility where is_public),
  'private_fallback_pairs', (select count(*) from deck_pair_visibility where source_action is null),
  'broken_links_remaining', (
    with decks as (
      select f.id, f.user_id, f.type, public.safe_jsonb(f.description) meta
      from public.folders f
      where f.type in ('builder_deck', 'deck')
    )
    select count(*)
    from decks source
    left join decks target on target.id::text = case
      when source.type = 'builder_deck' then source.meta->>'linked_deck_id'
      else source.meta->>'linked_builder_id'
    end
    where (
      source.type = 'builder_deck' and nullif(source.meta->>'linked_deck_id', '') is not null
      and (target.id is null or target.meta->>'linked_builder_id' is distinct from source.id::text)
    ) or (
      source.type = 'deck' and nullif(source.meta->>'linked_builder_id', '') is not null
      and (target.id is null or target.meta->>'linked_deck_id' is distinct from source.id::text)
    )
  )
) as repair_result;

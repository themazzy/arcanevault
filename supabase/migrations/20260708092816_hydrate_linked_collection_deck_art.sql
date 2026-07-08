-- Hydrate linked collection-deck tiles with commander/art metadata from their
-- paired builder deck without mutating either folder row. This keeps the
-- collection deck canonical in My Decks while allowing legacy linked pairs
-- whose collection side lacks commanderName/coverArtUri to render correctly.
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
        display_meta
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
  left join folders linked_builder
    on f.type = 'deck'
   and linked_builder.user_id = v_user_id
   and linked_builder.type = 'builder_deck'
   and linked_builder.id::text = nullif(meta->>'linked_builder_id', '')
  cross join lateral public.safe_jsonb(linked_builder.description) linked_meta
  cross join lateral (
    select meta || jsonb_strip_nulls(jsonb_build_object(
      'commanderName',
        case
          when nullif(meta->>'commanderName', '') is null
          then to_jsonb(nullif(linked_meta->>'commanderName', ''))
          else null
        end,
      'commanderScryfallId',
        case
          when nullif(meta->>'commanderScryfallId', '') is null
          then to_jsonb(nullif(linked_meta->>'commanderScryfallId', ''))
          else null
        end,
      'commanderColorIdentity',
        case
          when not (meta ? 'commanderColorIdentity')
          then linked_meta->'commanderColorIdentity'
          else null
        end,
      'coverArtUri',
        case
          when nullif(meta->>'coverArtUri', '') is null
          then to_jsonb(nullif(linked_meta->>'coverArtUri', ''))
          else null
        end,
      'commanders',
        case
          when jsonb_typeof(meta->'commanders') = 'array'
           and jsonb_array_length(meta->'commanders') > 0
          then null
          else linked_meta->'commanders'
        end
    )) as display_meta
  ) display
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

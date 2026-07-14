-- First-class Attraction deck support. Scryfall's attraction_lights is a
-- printing property: variants with the same oracle_id can light different
-- numbers, so it belongs on card_prints rather than oracle_cards.

alter table public.card_prints
  add column if not exists attraction_lights smallint[];

alter table public.card_prints
  drop constraint if exists card_prints_attraction_lights_valid;
alter table public.card_prints
  add constraint card_prints_attraction_lights_valid
  check (
    attraction_lights is null
    or attraction_lights <@ array[1,2,3,4,5,6]::smallint[]
  );

alter table public.deck_cards
  drop constraint if exists deck_cards_board_check;
alter table public.deck_cards
  add constraint deck_cards_board_check
  check (board in ('main', 'attraction', 'side', 'maybe'));

create or replace view public.owned_cards_view
with (security_invoker = true)
as
select
  c.id, c.user_id, c.card_print_id,
  cp.scryfall_id, cp.name, cp.set_code, cp.collector_number,
  c.qty, c.foil, c.condition, c.language, c.purchase_price, c.currency,
  c.misprint, c.altered, c.added_at, c.updated_at,
  cp.type_line, cp.mana_cost, cp.cmc, cp.color_identity,
  cp.image_uri, cp.art_crop_uri, cp.attraction_lights
from public.cards c
join public.card_prints cp on cp.id = c.card_print_id;

create or replace view public.deck_cards_view
with (security_invoker = true)
as
select
  dc.id, dc.deck_id, dc.user_id, dc.card_print_id,
  cp.scryfall_id, cp.name, cp.set_code, cp.collector_number,
  cp.type_line, cp.mana_cost, cp.cmc, cp.color_identity,
  cp.image_uri, cp.art_crop_uri,
  dc.qty, dc.foil, dc.is_commander, dc.board,
  dc.created_at, dc.updated_at, dc.category_id,
  cp.attraction_lights
from public.deck_cards dc
join public.card_prints cp on cp.id = dc.card_print_id;

create or replace view public.list_items_view
with (security_invoker = true)
as
select
  li.id, li.folder_id, li.user_id, li.card_print_id,
  cp.scryfall_id, cp.name, cp.set_code, cp.collector_number,
  li.foil, li.qty, li.added_at,
  cp.type_line, cp.mana_cost, cp.cmc, cp.color_identity,
  cp.image_uri, cp.art_crop_uri, cp.attraction_lights
from public.list_items li
join public.card_prints cp on cp.id = li.card_print_id;

create or replace view public.deck_allocations_view
with (security_invoker = true)
as
select
  da.id, da.deck_id, da.user_id, da.card_id, da.qty,
  da.created_at, da.updated_at,
  c.card_print_id, cp.scryfall_id, cp.name, cp.set_code,
  cp.collector_number, c.foil, c.condition, c.language,
  cp.type_line, cp.mana_cost, cp.cmc, cp.color_identity,
  cp.image_uri, cp.art_crop_uri,
  cp.attraction_lights,
  case when cp.type_line ~* '\mAttraction\M' then 'attraction' else 'main' end as board
from public.deck_allocations da
join public.cards c on c.id = da.card_id
join public.card_prints cp on cp.id = c.card_print_id;

grant select on public.owned_cards_view to anon, authenticated;
grant select on public.deck_cards_view to anon, authenticated;
grant select on public.list_items_view to anon, authenticated;
grant select on public.deck_allocations_view to anon, authenticated;

create or replace function public.get_deck_cards_for_view(p_deck_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_result jsonb;
  v_user_id uuid;
  v_meta jsonb;
begin
  select f.user_id, public.safe_jsonb(f.description)
    into v_user_id, v_meta
  from public.folders f where f.id = p_deck_id;

  if v_user_id is null then return '[]'::jsonb; end if;
  if coalesce(v_meta->>'is_public', 'false') <> 'true'
     and v_user_id is distinct from auth.uid() then
    return '[]'::jsonb;
  end if;

  select jsonb_agg(jsonb_build_object(
    'id', dc.id, 'deck_id', dc.deck_id, 'user_id', dc.user_id,
    'card_print_id', dc.card_print_id, 'scryfall_id', cp.scryfall_id,
    'name', cp.name, 'set_code', cp.set_code,
    'collector_number', cp.collector_number, 'type_line', cp.type_line,
    'mana_cost', cp.mana_cost, 'cmc', cp.cmc,
    'color_identity', coalesce(cp.color_identity, '{}'::text[]),
    'image_uri', cp.image_uri, 'art_crop_uri', cp.art_crop_uri,
    'attraction_lights', cp.attraction_lights,
    'qty', dc.qty, 'foil', dc.foil, 'is_commander', dc.is_commander,
    'board', dc.board, 'category_id', dc.category_id,
    'category_name', dcat.name, 'category_sort_order', dcat.sort_order,
    'created_at', dc.created_at, 'updated_at', dc.updated_at
  ) order by dc.is_commander desc, coalesce(dcat.sort_order, 999), cp.name)
  into v_result
  from public.deck_cards dc
  left join public.card_prints cp on cp.id = dc.card_print_id
  left join public.deck_categories dcat on dcat.id = dc.category_id
  where dc.deck_id = p_deck_id;

  if v_result is not null and jsonb_array_length(v_result) > 0 then
    return v_result;
  end if;
  if v_user_id is distinct from auth.uid() then return '[]'::jsonb; end if;

  select jsonb_agg(jsonb_build_object(
    'id', da.id, 'deck_id', da.deck_id, 'user_id', da.user_id,
    'card_print_id', c.card_print_id, 'scryfall_id', cp.scryfall_id,
    'name', cp.name, 'set_code', cp.set_code,
    'collector_number', cp.collector_number, 'type_line', cp.type_line,
    'mana_cost', cp.mana_cost, 'cmc', cp.cmc,
    'color_identity', coalesce(cp.color_identity, '{}'::text[]),
    'image_uri', cp.image_uri, 'art_crop_uri', cp.art_crop_uri,
    'attraction_lights', cp.attraction_lights,
    'qty', da.qty, 'foil', c.foil, 'is_commander', false,
    'board', case when cp.type_line ~* '\mAttraction\M' then 'attraction' else 'main' end,
    'category_id', null, 'category_name', null,
    'created_at', da.created_at, 'updated_at', da.updated_at
  ) order by cp.name)
  into v_result
  from public.deck_allocations da
  join public.cards c on c.id = da.card_id
  join public.card_prints cp on cp.id = c.card_print_id
  where da.deck_id = p_deck_id;

  return coalesce(v_result, '[]'::jsonb);
end;
$function$;

revoke execute on function public.get_deck_cards_for_view(uuid) from public;
grant execute on function public.get_deck_cards_for_view(uuid) to anon, authenticated;

-- Cached deck counts describe the normal deck, not supplementary Attractions.
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
        where dc.deck_id = f.id and dc.board = 'main'
        union
        select unnest(cp.color_identity) as ci
        from public.deck_allocations da
        join public.cards c on c.id = da.card_id
        join public.card_prints cp on cp.id = c.card_print_id
        where da.deck_id = f.id and cp.type_line !~* '\mAttraction\M'
      ) colors where ci in ('W','U','B','R','G','C')
    ), '{}'::text[]),
    deck_card_count = case f.type
      when 'builder_deck' then coalesce((
        select sum(dc.qty)::int from public.deck_cards dc
        where dc.deck_id = f.id and dc.board = 'main'
      ), 0)
      else coalesce((
        select sum(da.qty)::int
        from public.deck_allocations da
        join public.cards c on c.id = da.card_id
        join public.card_prints cp on cp.id = c.card_print_id
        where da.deck_id = f.id and cp.type_line !~* '\mAttraction\M'
      ), 0)
    end
  where f.id = any(p_deck_ids);
$$;

revoke all on function public.refresh_deck_rollups(uuid[]) from public, anon, authenticated;

select public.refresh_deck_rollups(array(
  select id from public.folders where type in ('builder_deck', 'deck')
));

create or replace function public.get_deck_og_meta(p_deck_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_user_id uuid; v_name text; v_meta jsonb; v_format text;
  v_commander text; v_total int; v_art text; v_nick text;
begin
  select f.user_id, f.name, public.safe_jsonb(f.description)
    into v_user_id, v_name, v_meta
  from public.folders f where f.id = p_deck_id;
  if v_user_id is null or coalesce(v_meta->>'is_public', 'false') <> 'true' then
    return null;
  end if;
  v_format := nullif(v_meta->>'format', '');
  v_commander := nullif(coalesce(
    (select string_agg(c->>'name', ' + ')
     from jsonb_array_elements(coalesce(v_meta->'commanders', '[]'::jsonb)) c
     where coalesce(c->>'name', '') <> ''),
    v_meta->>'commanderName'
  ), '');

  select coalesce(sum(dc.qty) filter (where dc.board = 'main'), 0),
         (array_agg(coalesce(cp.art_crop_uri, cp.image_uri)
          order by dc.is_commander desc, cp.cmc desc nulls last, cp.name)
          filter (where dc.board = 'main' and coalesce(cp.art_crop_uri, cp.image_uri) is not null))[1]
    into v_total, v_art
  from public.deck_cards dc
  left join public.card_prints cp on cp.id = dc.card_print_id
  where dc.deck_id = p_deck_id;

  if v_commander is null then
    select string_agg(cp.name, ' + ') into v_commander
    from public.deck_cards dc join public.card_prints cp on cp.id = dc.card_print_id
    where dc.deck_id = p_deck_id and dc.is_commander;
  end if;

  if coalesce(v_total, 0) = 0 then
    select coalesce(sum(da.qty) filter (where cp.type_line !~* '\mAttraction\M'), 0),
           (array_agg(coalesce(cp.art_crop_uri, cp.image_uri) order by cp.cmc desc nulls last, cp.name)
            filter (where cp.type_line !~* '\mAttraction\M' and coalesce(cp.art_crop_uri, cp.image_uri) is not null))[1]
      into v_total, v_art
    from public.deck_allocations da
    join public.cards c on c.id = da.card_id
    join public.card_prints cp on cp.id = c.card_print_id
    where da.deck_id = p_deck_id;
  end if;

  begin v_nick := public.get_user_nickname(v_user_id);
  exception when others then v_nick := null; end;
  return jsonb_build_object(
    'name', v_name, 'format', v_format, 'commander', nullif(v_commander, ''),
    'total_cards', coalesce(v_total, 0), 'art', v_art,
    'creator', nullif(v_nick, '')
  );
end;
$function$;

revoke execute on function public.get_deck_og_meta(uuid) from public;
grant execute on function public.get_deck_og_meta(uuid) to anon, authenticated;

notify pgrst, 'reload schema';

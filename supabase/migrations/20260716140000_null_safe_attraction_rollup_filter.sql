-- Null-safe Attraction exclusion in deck rollups + OG meta.
--
-- Collection-deck counts (folders.deck_card_count for type='deck') and the
-- deck OG-meta fallback sum cards from deck_allocations while excluding
-- supplementary Attractions via `cp.type_line !~* '\mAttraction\M'`. In SQL a
-- NULL type_line makes that predicate evaluate to NULL (not TRUE), so any
-- allocated card whose card_prints.type_line is NULL was silently dropped from
-- the count — e.g. "Command Tower // Command Tower" (rex #26) and 157 other
-- prints currently carrying a NULL type_line. This made a full 100-card
-- collection deck report 99 in the /builder tile while the builder view
-- (which counts deck_cards main-board rows regardless of type_line) showed 100.
--
-- A NULL type_line is not an Attraction, so it must count. Wrap the predicate in
-- coalesce(type_line, '') so unknown-type cards are treated as normal cards.
-- The builder_deck branch counts board='main' and needs no change.

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
        where da.deck_id = f.id and coalesce(cp.type_line, '') !~* '\mAttraction\M'
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
        where da.deck_id = f.id and coalesce(cp.type_line, '') !~* '\mAttraction\M'
      ), 0)
    end
  where f.id = any(p_deck_ids);
$$;

revoke all on function public.refresh_deck_rollups(uuid[]) from public, anon, authenticated;

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
    select coalesce(sum(da.qty) filter (where coalesce(cp.type_line, '') !~* '\mAttraction\M'), 0),
           (array_agg(coalesce(cp.art_crop_uri, cp.image_uri) order by cp.cmc desc nulls last, cp.name)
            filter (where coalesce(cp.type_line, '') !~* '\mAttraction\M' and coalesce(cp.art_crop_uri, cp.image_uri) is not null))[1]
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

-- Recompute cached rollups for every deck so existing undercounts self-heal.
select public.refresh_deck_rollups(array(
  select id from public.folders where type in ('builder_deck', 'deck')
));

notify pgrst, 'reload schema';

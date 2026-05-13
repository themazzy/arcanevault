-- Include public deck-builder category labels in shared deck card payloads.

create or replace function public.get_deck_cards_for_view(p_deck_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_result  jsonb;
  v_user_id uuid;
  v_meta    jsonb;
begin
  select f.user_id, public.safe_jsonb(f.description)
  into v_user_id, v_meta
  from public.folders f
  where f.id = p_deck_id;

  if v_user_id is null then
    return '[]'::jsonb;
  end if;

  if coalesce(v_meta->>'is_public', 'false') <> 'true'
     and v_user_id is distinct from auth.uid() then
    return '[]'::jsonb;
  end if;

  -- Builder decks: expose print metadata and public category display data.
  select jsonb_agg(
    jsonb_build_object(
      'id',                  dc.id,
      'deck_id',             dc.deck_id,
      'user_id',             dc.user_id,
      'card_print_id',       dc.card_print_id,
      'scryfall_id',         cp.scryfall_id,
      'name',                cp.name,
      'set_code',            cp.set_code,
      'collector_number',    cp.collector_number,
      'type_line',           cp.type_line,
      'mana_cost',           cp.mana_cost,
      'cmc',                 cp.cmc,
      'color_identity',      coalesce(cp.color_identity, '{}'::text[]),
      'image_uri',           cp.image_uri,
      'art_crop_uri',        cp.art_crop_uri,
      'qty',                 dc.qty,
      'foil',                dc.foil,
      'is_commander',        dc.is_commander,
      'board',               dc.board,
      'category_id',         dc.category_id,
      'category_name',       dcat.name,
      'category_sort_order', dcat.sort_order,
      'created_at',          dc.created_at,
      'updated_at',          dc.updated_at
    )
    order by dc.is_commander desc, coalesce(dcat.sort_order, 999), cp.name
  ) into v_result
  from public.deck_cards dc
  left join public.card_prints cp on cp.id = dc.card_print_id
  left join public.deck_categories dcat on dcat.id = dc.category_id
  where dc.deck_id = p_deck_id;

  if v_result is not null and jsonb_array_length(v_result) > 0 then
    return v_result;
  end if;

  -- Allocations fallback: only run for the deck owner.
  if v_user_id is distinct from auth.uid() then
    return '[]'::jsonb;
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'id',               da.id,
      'deck_id',          da.deck_id,
      'user_id',          da.user_id,
      'card_print_id',    c.card_print_id,
      'scryfall_id',      cp.scryfall_id,
      'name',             cp.name,
      'set_code',         cp.set_code,
      'collector_number', cp.collector_number,
      'type_line',        cp.type_line,
      'mana_cost',        cp.mana_cost,
      'cmc',              cp.cmc,
      'color_identity',   coalesce(cp.color_identity, '{}'::text[]),
      'image_uri',        cp.image_uri,
      'art_crop_uri',     cp.art_crop_uri,
      'qty',              da.qty,
      'foil',             c.foil,
      'is_commander',     false,
      'board',            'main',
      'category_id',      null,
      'category_name',    null,
      'created_at',       da.created_at,
      'updated_at',       da.updated_at
    )
    order by cp.name
  ) into v_result
  from public.deck_allocations da
  join public.cards c on c.id = da.card_id
  join public.card_prints cp on cp.id = c.card_print_id
  where da.deck_id = p_deck_id;

  return coalesce(v_result, '[]'::jsonb);
end;
$function$;

revoke execute on function public.get_deck_cards_for_view(uuid) from public;
grant execute on function public.get_deck_cards_for_view(uuid) to anon, authenticated;

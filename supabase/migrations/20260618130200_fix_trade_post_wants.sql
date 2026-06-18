-- Fix get_trade_post: list_items has no inline card columns; it references
-- card_print_id. Join card_prints to resolve names/art/sets for the wants,
-- the same way the haves are resolved.
create or replace function public.get_trade_post(p_username text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '15s'
as $function$
declare
  v_uid uuid; v_open boolean; v_nick text; v_accent text;
  v_wants_json jsonb; v_want_ids uuid[]; v_binder uuid; v_haves jsonb; v_wants jsonb;
begin
  select user_id, trade_open, nickname, profile_accent, trade_wants
    into v_uid, v_open, v_nick, v_accent, v_wants_json
  from user_settings where lower(nickname) = lower(p_username) limit 1;
  if v_uid is null then return null; end if;
  if not coalesce(v_open, false) then
    return jsonb_build_object('open', false, 'nickname', v_nick);
  end if;

  select coalesce(array_agg(f.id), '{}') into v_want_ids
  from folders f
  where f.user_id = v_uid and f.type = 'list'
    and f.id::text in (select jsonb_array_elements_text(coalesce(v_wants_json, '[]'::jsonb)));

  select f.id into v_binder from folders f
  where f.user_id = v_uid and f.type = 'binder'
    and (public.safe_jsonb(f.description)->>'isTradeBinder') = 'true' limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'name', cp.name, 'set_code', cp.set_code, 'collector_number', cp.collector_number,
           'image_uri', cp.image_uri, 'scryfall_id', cp.scryfall_id, 'foil', c.foil, 'qty', fc.qty,
           'price', case when c.foil then coalesce(pr.price_foil_eur, pr.price_regular_eur)
                         else coalesce(pr.price_regular_eur, pr.price_foil_eur) end
         ) order by cp.name), '[]'::jsonb) into v_haves
  from folder_cards fc
  join cards c on c.id = fc.card_id
  join card_prints cp on cp.id = c.card_print_id
  left join card_prices pr on pr.scryfall_id = cp.scryfall_id and pr.snapshot_date = current_date
  where v_binder is not null and fc.folder_id = v_binder;

  select coalesce(jsonb_agg(jsonb_build_object(
           'name', cp.name, 'set_code', cp.set_code, 'collector_number', cp.collector_number,
           'image_uri', cp.image_uri, 'scryfall_id', cp.scryfall_id, 'foil', li.foil, 'qty', li.qty
         ) order by cp.name), '[]'::jsonb) into v_wants
  from list_items li
  join card_prints cp on cp.id = li.card_print_id
  where li.folder_id = any(v_want_ids);

  return jsonb_build_object('open', true, 'nickname', v_nick, 'accent', coalesce(v_accent, ''),
    'haves', coalesce(v_haves, '[]'::jsonb), 'wants', coalesce(v_wants, '[]'::jsonb));
end;
$function$;

notify pgrst, 'reload schema';

-- Change the identity of owned copies, scoped to one location.
--
-- `cards` is keyed by (user_id, card_print_id, foil, language, condition) — all
-- five describe *which* card the row is, and a row can be placed in several
-- folders at once. The collection grid fans one row out into one tile per
-- placement, so a card owned 8× across a binder and two decks looks like three
-- independent cards. Editing any identity column on the row therefore changed
-- all 8 copies at once: correct for the row, wrong for what the UI implies.
--
-- This splits instead. The copies that live in the given folder take on the new
-- identity; everything else stays as it was.
--
-- Atomic on purpose: the operation touches cards + folder_cards/deck_allocations
-- and has to keep `cards.qty` equal to the sum of its placements. Done as
-- separate client calls, a mid-way failure would silently invent or destroy
-- copies.
--
-- Merge rule: when the target identity is already owned, its copies are merged
-- only if that row is already in the same folder. Anywhere else the change is
-- refused — the unique index means the alternative would be dragging unrelated
-- copies across folders behind the user's back.
--
-- Null parameters mean "keep this column as it is", so callers can move one
-- attribute without restating the rest.
drop function if exists public.change_owned_card_printing(uuid, uuid, uuid, integer);

create or replace function public.change_owned_card_identity(
  p_card_id uuid,
  p_new_print_id uuid default null,
  p_foil boolean default null,
  p_language text default null,
  p_condition text default null,
  p_folder_id uuid default null,
  p_qty integer default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_src         cards%rowtype;
  v_target      cards%rowtype;
  v_has_target  boolean := false;
  v_folder_type text;
  v_place_qty   integer;
  v_move        integer;
  v_result_id   uuid;
  v_merged      boolean := false;
  v_print       uuid;
  v_foil        boolean;
  v_language    text;
  v_condition   text;
begin
  select * into v_src from cards where id = p_card_id for update;
  if not found then
    raise exception 'Owned card not found.' using errcode = 'P0002';
  end if;

  v_print     := coalesce(p_new_print_id, v_src.card_print_id);
  v_foil      := coalesce(p_foil, v_src.foil);
  v_language  := coalesce(p_language, v_src.language);
  v_condition := coalesce(p_condition, v_src.condition);

  if p_new_print_id is not null and not exists (select 1 from card_prints where id = p_new_print_id) then
    raise exception 'That printing could not be found.' using errcode = 'P0002';
  end if;

  if v_print = v_src.card_print_id
     and v_foil is not distinct from v_src.foil
     and v_language is not distinct from v_src.language
     and v_condition is not distinct from v_src.condition then
    return jsonb_build_object('card_id', v_src.id, 'moved_qty', 0, 'merged', false, 'split', false);
  end if;

  -- How many copies this location holds. A folder the row has no placement in
  -- (a builder deck, say) is treated as no location at all rather than an
  -- error, so callers that pass a folder id loosely still get whole-row
  -- behaviour.
  if p_folder_id is not null then
    select type into v_folder_type from folders where id = p_folder_id;
    if v_folder_type = 'deck' then
      select qty into v_place_qty from deck_allocations where deck_id = p_folder_id and card_id = v_src.id;
    elsif v_folder_type is not null then
      select qty into v_place_qty from folder_cards where folder_id = p_folder_id and card_id = v_src.id;
    end if;
    if v_place_qty is null then
      p_folder_id := null;
      v_folder_type := null;
    end if;
  end if;

  v_move := least(greatest(coalesce(p_qty, v_place_qty, v_src.qty), 1), v_src.qty);

  -- The unique index is NULLS NOT DISTINCT over exactly these columns, so this
  -- finds the one row a re-point would collide with.
  select * into v_target from cards
   where user_id = v_src.user_id
     and id <> v_src.id
     and card_print_id = v_print
     and foil is not distinct from v_foil
     and language is not distinct from v_language
     and condition is not distinct from v_condition
   for update;
  v_has_target := found;

  if v_has_target then
    if p_folder_id is null or not (
         (v_folder_type = 'deck' and exists (
            select 1 from deck_allocations where deck_id = p_folder_id and card_id = v_target.id))
      or (v_folder_type <> 'deck' and exists (
            select 1 from folder_cards where folder_id = p_folder_id and card_id = v_target.id))
    ) then
      raise exception 'You already own that version somewhere else. Move those copies here first, or pick different details.'
        using errcode = '23505';
    end if;
  end if;

  -- Whole row moves and nothing to merge into: change it in place so the card
  -- id and every placement survive untouched.
  if not v_has_target and (p_folder_id is null or v_move >= v_src.qty) then
    update cards
       set card_print_id = v_print, foil = v_foil, language = v_language,
           condition = v_condition, updated_at = now()
     where id = v_src.id;
    return jsonb_build_object('card_id', v_src.id, 'moved_qty', v_src.qty, 'merged', false, 'split', false);
  end if;

  if v_has_target then
    update cards set qty = qty + v_move, updated_at = now() where id = v_target.id;
    v_result_id := v_target.id;
    v_merged := true;
  else
    insert into cards (user_id, card_print_id, qty, foil, language, condition, purchase_price, currency)
    values (v_src.user_id, v_print, v_move, v_foil, v_language, v_condition,
            v_src.purchase_price, v_src.currency)
    returning id into v_result_id;
  end if;

  update cards set qty = qty - v_move, updated_at = now() where id = v_src.id;

  -- The moved copies leave the source row's slot in this folder and land on the
  -- target row's. An emptied slot is deleted outright rather than decremented
  -- to zero: deck_allocations_qty_check forbids a zero-quantity placement.
  if v_folder_type = 'deck' then
    if v_place_qty - v_move <= 0 then
      delete from deck_allocations where deck_id = p_folder_id and card_id = v_src.id;
    else
      update deck_allocations set qty = qty - v_move, updated_at = now()
       where deck_id = p_folder_id and card_id = v_src.id;
    end if;
    insert into deck_allocations (deck_id, user_id, card_id, qty)
    values (p_folder_id, v_src.user_id, v_result_id, v_move)
    on conflict (deck_id, card_id) do update
      set qty = deck_allocations.qty + excluded.qty, updated_at = now();
  else
    if v_place_qty - v_move <= 0 then
      delete from folder_cards where folder_id = p_folder_id and card_id = v_src.id;
    else
      update folder_cards set qty = qty - v_move, updated_at = now()
       where folder_id = p_folder_id and card_id = v_src.id;
    end if;
    insert into folder_cards (folder_id, card_id, qty)
    values (p_folder_id, v_result_id, v_move)
    on conflict (folder_id, card_id) do update
      set qty = folder_cards.qty + excluded.qty, updated_at = now();
  end if;

  -- A source row with no copies left owns nothing; its placements cascade away.
  delete from cards where id = v_src.id and qty <= 0;

  return jsonb_build_object('card_id', v_result_id, 'moved_qty', v_move, 'merged', v_merged, 'split', true);
end;
$$;

revoke execute on function public.change_owned_card_identity(uuid, uuid, boolean, text, text, uuid, integer) from anon;
grant execute on function public.change_owned_card_identity(uuid, uuid, boolean, text, text, uuid, integer) to authenticated;

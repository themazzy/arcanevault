create or replace function public.reconcile_owned_card_after_trade(p_user_id uuid, p_card_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total_qty integer;
  v_card public.cards%rowtype;
  v_deleted_id uuid;
begin
  select
    coalesce((
      select sum(fc.qty)::integer
      from public.folder_cards fc
      join public.folders f on f.id = fc.folder_id
      where fc.card_id = p_card_id
        and f.user_id = p_user_id
    ), 0)
    +
    coalesce((
      select sum(da.qty)::integer
      from public.deck_allocations da
      where da.card_id = p_card_id
        and da.user_id = p_user_id
    ), 0)
  into v_total_qty;

  if v_total_qty > 0 then
    update public.cards
    set qty = v_total_qty
    where id = p_card_id
      and user_id = p_user_id
    returning * into v_card;

    return jsonb_build_object(
      'card', to_jsonb(v_card),
      'deleted_card_id', null
    );
  end if;

  delete from public.cards
  where id = p_card_id
    and user_id = p_user_id
  returning id into v_deleted_id;

  return jsonb_build_object(
    'card', null,
    'deleted_card_id', v_deleted_id
  );
end;
$$;

create or replace function public.commit_trade(
  p_offer_items jsonb,
  p_want_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_offer_item jsonb;
  v_want_item jsonb;
  v_offer_card_id uuid;
  v_offer_source_id uuid;
  v_offer_source_type text;
  v_offer_qty integer;
  v_card_row public.cards%rowtype;
  v_want_qty integer;
  v_want_foil boolean;
  v_want_name text;
  v_want_set_code text;
  v_want_collector_number text;
  v_want_scryfall_id text;
  v_recent_binder public.folders%rowtype;
  v_folder_row public.folder_cards%rowtype;
  v_deck_row public.deck_allocations%rowtype;
  v_reconcile jsonb;
  v_card_print_id uuid;
  v_changed_card_ids uuid[] := '{}';
  v_deleted_card_ids uuid[] := '{}';
  v_changed_folder_card_ids uuid[] := '{}';
  v_deleted_folder_card_ids uuid[] := '{}';
  v_changed_deck_allocation_ids uuid[] := '{}';
  v_deleted_deck_allocation_ids uuid[] := '{}';
begin
  if v_user_id is null then
    raise exception 'You must be signed in to save a trade.';
  end if;

  if coalesce(jsonb_array_length(coalesce(p_offer_items, '[]'::jsonb)), 0) = 0
     and coalesce(jsonb_array_length(coalesce(p_want_items, '[]'::jsonb)), 0) = 0 then
    raise exception 'Trade must include at least one card.';
  end if;

  insert into public.folders (user_id, type, name, description)
  values (v_user_id, 'binder', 'Recently Traded', '{}')
  on conflict (user_id, name, type) do update
    set updated_at = now()
  returning * into v_recent_binder;

  for v_offer_item in
    select value from jsonb_array_elements(coalesce(p_offer_items, '[]'::jsonb))
  loop
    v_offer_card_id := (v_offer_item->>'card_id')::uuid;
    v_offer_source_id := (v_offer_item->>'source_id')::uuid;
    v_offer_source_type := coalesce(v_offer_item->>'source_type', '');
    v_offer_qty := greatest(coalesce((v_offer_item->>'qty')::integer, 0), 0);

    if v_offer_card_id is null or v_offer_source_id is null or v_offer_qty < 1 then
      raise exception 'Trade offer rows must include card, source, and qty.';
    end if;

    select *
    into v_card_row
    from public.cards
    where id = v_offer_card_id
      and user_id = v_user_id
    for update;

    if not found then
      raise exception 'One of the offered cards no longer exists.';
    end if;

    if v_offer_source_type = 'deck' then
      select *
      into v_deck_row
      from public.deck_allocations
      where deck_id = v_offer_source_id
        and card_id = v_offer_card_id
        and user_id = v_user_id
      for update;

      if not found then
        raise exception 'Selected trade source is no longer available.';
      end if;

      if coalesce(v_deck_row.qty, 0) < v_offer_qty then
        raise exception 'Offered quantity exceeds the selected source quantity.';
      end if;

      if v_deck_row.qty = v_offer_qty then
        v_deleted_deck_allocation_ids := array_append(v_deleted_deck_allocation_ids, v_deck_row.id);
        delete from public.deck_allocations where id = v_deck_row.id;
      else
        update public.deck_allocations
        set qty = v_deck_row.qty - v_offer_qty
        where id = v_deck_row.id
        returning * into v_deck_row;
        v_changed_deck_allocation_ids := array_append(v_changed_deck_allocation_ids, v_deck_row.id);
      end if;
    elsif v_offer_source_type in ('binder', 'list') then
      select fc.*
      into v_folder_row
      from public.folder_cards fc
      join public.folders f on f.id = fc.folder_id
      where fc.folder_id = v_offer_source_id
        and fc.card_id = v_offer_card_id
        and f.user_id = v_user_id
        and f.type = v_offer_source_type
      for update;

      if not found then
        raise exception 'Selected trade source is no longer available.';
      end if;

      if coalesce(v_folder_row.qty, 0) < v_offer_qty then
        raise exception 'Offered quantity exceeds the selected source quantity.';
      end if;

      if v_folder_row.qty = v_offer_qty then
        v_deleted_folder_card_ids := array_append(v_deleted_folder_card_ids, v_folder_row.id);
        delete from public.folder_cards where id = v_folder_row.id;
      else
        update public.folder_cards
        set qty = v_folder_row.qty - v_offer_qty
        where id = v_folder_row.id
        returning * into v_folder_row;
        v_changed_folder_card_ids := array_append(v_changed_folder_card_ids, v_folder_row.id);
      end if;
    else
      raise exception 'Unsupported trade source type.';
    end if;

    v_reconcile := public.reconcile_owned_card_after_trade(v_user_id, v_offer_card_id);
    if (v_reconcile->>'deleted_card_id') is not null then
      v_deleted_card_ids := array_append(v_deleted_card_ids, (v_reconcile->>'deleted_card_id')::uuid);
    elsif (v_reconcile->'card') is not null then
      v_changed_card_ids := array_append(v_changed_card_ids, ((v_reconcile->'card')->>'id')::uuid);
    end if;
  end loop;

  for v_want_item in
    select value from jsonb_array_elements(coalesce(p_want_items, '[]'::jsonb))
  loop
    v_want_qty := greatest(coalesce((v_want_item->>'qty')::integer, 0), 0);
    v_want_foil := coalesce((v_want_item->>'foil')::boolean, false);
    v_want_name := nullif(v_want_item->>'name', '');
    v_want_set_code := nullif(v_want_item->>'set_code', '');
    v_want_collector_number := nullif(v_want_item->>'collector_number', '');
    v_want_scryfall_id := nullif(v_want_item->>'scryfall_id', '');

    if v_want_qty < 1 or v_want_name is null or v_want_set_code is null then
      raise exception 'Received cards must include name, set code, and qty.';
    end if;

    select id
    into v_card_print_id
    from public.card_prints
    where scryfall_id = v_want_scryfall_id
    limit 1;

    select *
    into v_card_row
    from public.cards
    where user_id = v_user_id
      and set_code = v_want_set_code
      and collector_number is not distinct from v_want_collector_number
      and foil = v_want_foil
      and language = 'en'
      and condition = 'near_mint'
    limit 1
    for update;

    if found then
      update public.cards
      set qty = coalesce(v_card_row.qty, 0) + v_want_qty,
          scryfall_id = coalesce(v_card_row.scryfall_id, v_want_scryfall_id),
          card_print_id = coalesce(v_card_row.card_print_id, v_card_print_id),
          purchase_price = coalesce((v_want_item->>'purchase_price')::numeric, v_card_row.purchase_price),
          currency = coalesce(nullif(v_want_item->>'currency', ''), v_card_row.currency)
      where id = v_card_row.id
      returning * into v_card_row;
    else
      insert into public.cards (
        user_id,
        card_print_id,
        scryfall_id,
        name,
        set_code,
        collector_number,
        foil,
        qty,
        condition,
        language,
        purchase_price,
        currency
      )
      values (
        v_user_id,
        v_card_print_id,
        v_want_scryfall_id,
        v_want_name,
        v_want_set_code,
        v_want_collector_number,
        v_want_foil,
        v_want_qty,
        'near_mint',
        'en',
        coalesce((v_want_item->>'purchase_price')::numeric, 0),
        coalesce(nullif(v_want_item->>'currency', ''), 'EUR')
      )
      returning * into v_card_row;
    end if;

    v_changed_card_ids := array_append(v_changed_card_ids, v_card_row.id);

    select *
    into v_folder_row
    from public.folder_cards
    where folder_id = v_recent_binder.id
      and card_id = v_card_row.id
    for update;

    if found then
      update public.folder_cards
      set qty = coalesce(v_folder_row.qty, 0) + v_want_qty
      where id = v_folder_row.id
      returning * into v_folder_row;
    else
      insert into public.folder_cards (folder_id, card_id, qty)
      values (v_recent_binder.id, v_card_row.id, v_want_qty)
      returning * into v_folder_row;
    end if;

    v_changed_folder_card_ids := array_append(v_changed_folder_card_ids, v_folder_row.id);
    v_reconcile := public.reconcile_owned_card_after_trade(v_user_id, v_card_row.id);
    if (v_reconcile->'card') is not null then
      v_changed_card_ids := array_append(v_changed_card_ids, ((v_reconcile->'card')->>'id')::uuid);
    end if;
  end loop;

  return jsonb_build_object(
    'binder', to_jsonb(v_recent_binder),
    'cards', coalesce((
      select jsonb_agg(to_jsonb(c))
      from public.cards c
      where c.id = any(array(select distinct unnest(v_changed_card_ids)))
    ), '[]'::jsonb),
    'deleted_card_ids', to_jsonb(coalesce(array(select distinct unnest(v_deleted_card_ids)), '{}'::uuid[])),
    'folder_cards', coalesce((
      select jsonb_agg(to_jsonb(fc))
      from public.folder_cards fc
      where fc.id = any(array(select distinct unnest(v_changed_folder_card_ids)))
    ), '[]'::jsonb),
    'deleted_folder_card_ids', to_jsonb(coalesce(array(select distinct unnest(v_deleted_folder_card_ids)), '{}'::uuid[])),
    'deck_allocations', coalesce((
      select jsonb_agg(to_jsonb(da))
      from public.deck_allocations da
      where da.id = any(array(select distinct unnest(v_changed_deck_allocation_ids)))
    ), '[]'::jsonb),
    'deleted_deck_allocation_ids', to_jsonb(coalesce(array(select distinct unnest(v_deleted_deck_allocation_ids)), '{}'::uuid[]))
  );
end;
$$;

grant execute on function public.reconcile_owned_card_after_trade(uuid, uuid) to authenticated;
grant execute on function public.commit_trade(jsonb, jsonb) to authenticated;

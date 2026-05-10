-- Phase 5d reconciliation: production had the compatibility/prep and
-- inner-join view migrations applied, but still retained the redundant
-- denormalized print columns on cards/deck_cards/list_items.
--
-- Keep the current view definitions intact, drop only the base-table columns,
-- and explicitly preserve SECURITY INVOKER behavior on the views.

do $$
begin
  if exists (
    select 1
    from public.cards c
    left join public.card_prints cp on cp.id = c.card_print_id
    where c.card_print_id is null or cp.id is null
  ) then
    raise exception 'phase5d reconcile blocked: cards contains missing or orphaned card_print_id values';
  end if;

  if exists (
    select 1
    from public.deck_cards dc
    left join public.card_prints cp on cp.id = dc.card_print_id
    where dc.card_print_id is null or cp.id is null
  ) then
    raise exception 'phase5d reconcile blocked: deck_cards contains missing or orphaned card_print_id values';
  end if;

  if exists (
    select 1
    from public.list_items li
    left join public.card_prints cp on cp.id = li.card_print_id
    where li.card_print_id is null or cp.id is null
  ) then
    raise exception 'phase5d reconcile blocked: list_items contains missing or orphaned card_print_id values';
  end if;
end $$;

drop index if exists public.cards_name_idx;
drop index if exists public.cards_scryfall_id_idx;
drop index if exists public.cards_set_code_idx;
drop index if exists public.deck_cards_scryfall_id_idx;

alter table public.cards
  drop column if exists scryfall_id,
  drop column if exists name,
  drop column if exists set_code,
  drop column if exists collector_number;

alter table public.deck_cards
  drop column if exists scryfall_id,
  drop column if exists name,
  drop column if exists set_code,
  drop column if exists collector_number,
  drop column if exists type_line,
  drop column if exists mana_cost,
  drop column if exists cmc,
  drop column if exists color_identity,
  drop column if exists image_uri;

alter table public.list_items
  drop column if exists scryfall_id,
  drop column if exists name,
  drop column if exists set_code,
  drop column if exists collector_number;

alter view public.owned_cards_view set (security_invoker = true);
alter view public.deck_cards_view set (security_invoker = true);
alter view public.list_items_view set (security_invoker = true);
alter view public.deck_allocations_view set (security_invoker = true);

grant select on public.owned_cards_view to anon, authenticated;
grant select on public.deck_cards_view to anon, authenticated;
grant select on public.list_items_view to anon, authenticated;
grant select on public.deck_allocations_view to anon, authenticated;

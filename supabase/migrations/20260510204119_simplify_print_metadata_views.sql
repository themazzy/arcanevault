-- Phase 5d removed the denormalized print metadata columns from base tables.
-- Rebuild the compatibility views as direct card_prints passthroughs while
-- preserving security_invoker behavior.

create or replace view public.owned_cards_view
with (security_invoker = true)
as
select
  c.id,
  c.user_id,
  c.card_print_id,
  cp.scryfall_id,
  cp.name,
  cp.set_code,
  cp.collector_number,
  c.qty,
  c.foil,
  c.condition,
  c.language,
  c.purchase_price,
  c.currency,
  c.misprint,
  c.altered,
  c.added_at,
  c.updated_at,
  cp.type_line,
  cp.mana_cost,
  cp.cmc,
  cp.color_identity,
  cp.image_uri,
  cp.art_crop_uri
from public.cards c
join public.card_prints cp on cp.id = c.card_print_id;

create or replace view public.deck_cards_view
with (security_invoker = true)
as
select
  dc.id,
  dc.deck_id,
  dc.user_id,
  dc.card_print_id,
  cp.scryfall_id,
  cp.name,
  cp.set_code,
  cp.collector_number,
  cp.type_line,
  cp.mana_cost,
  cp.cmc,
  cp.color_identity,
  cp.image_uri,
  cp.art_crop_uri,
  dc.qty,
  dc.foil,
  dc.is_commander,
  dc.board,
  dc.created_at,
  dc.updated_at,
  dc.category_id
from public.deck_cards dc
join public.card_prints cp on cp.id = dc.card_print_id;

create or replace view public.list_items_view
with (security_invoker = true)
as
select
  li.id,
  li.folder_id,
  li.user_id,
  li.card_print_id,
  cp.scryfall_id,
  cp.name,
  cp.set_code,
  cp.collector_number,
  li.foil,
  li.qty,
  li.added_at,
  cp.type_line,
  cp.mana_cost,
  cp.cmc,
  cp.color_identity,
  cp.image_uri,
  cp.art_crop_uri
from public.list_items li
join public.card_prints cp on cp.id = li.card_print_id;

create or replace view public.deck_allocations_view
with (security_invoker = true)
as
select
  da.id,
  da.deck_id,
  da.user_id,
  da.card_id,
  da.qty,
  da.created_at,
  da.updated_at,
  c.card_print_id,
  cp.scryfall_id,
  cp.name,
  cp.set_code,
  cp.collector_number,
  c.foil,
  c.condition,
  c.language,
  cp.type_line,
  cp.mana_cost,
  cp.cmc,
  cp.color_identity,
  cp.image_uri,
  cp.art_crop_uri
from public.deck_allocations da
join public.cards c on c.id = da.card_id
join public.card_prints cp on cp.id = c.card_print_id;

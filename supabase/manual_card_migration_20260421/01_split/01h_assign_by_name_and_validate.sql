-- Chunk 01h: assign card_print_id by unique name-only fallback and validate backfill
-- Run after the previous 01 split chunk completes successfully.

with unique_prints as (
  select name, (array_agg(id order by id))[1] as id
  from public.card_prints
  where scryfall_id is null
    and set_code is null
    and collector_number is null
  group by name
  having count(*) = 1
)
update public.cards c
set card_print_id = up.id
from unique_prints up
where c.card_print_id is null
  and c.scryfall_id is null
  and c.set_code is null
  and c.collector_number is null
  and c.name = up.name;

with unique_prints as (
  select name, (array_agg(id order by id))[1] as id
  from public.card_prints
  where scryfall_id is null
    and set_code is null
    and collector_number is null
  group by name
  having count(*) = 1
)
update public.deck_cards dc
set card_print_id = up.id
from unique_prints up
where dc.card_print_id is null
  and dc.scryfall_id is null
  and dc.set_code is null
  and dc.collector_number is null
  and dc.name = up.name;

with unique_prints as (
  select name, (array_agg(id order by id))[1] as id
  from public.card_prints
  where scryfall_id is null
    and set_code is null
    and collector_number is null
  group by name
  having count(*) = 1
)
update public.list_items li
set card_print_id = up.id
from unique_prints up
where li.card_print_id is null
  and li.scryfall_id is null
  and li.set_code is null
  and li.collector_number is null
  and li.name = up.name;

insert into public.card_schema_migration_audit (phase, details)
select 'card_print_backfill',
  jsonb_build_object(
    'cards_missing', (select count(*) from public.cards where card_print_id is null),
    'deck_cards_missing', (select count(*) from public.deck_cards where card_print_id is null),
    'list_items_missing', (select count(*) from public.list_items where card_print_id is null)
  );

do $$
begin
  if exists (select 1 from public.cards where card_print_id is null) then
    raise exception 'cards.card_print_id backfill is incomplete';
  end if;
  if exists (select 1 from public.deck_cards where card_print_id is null) then
    raise exception 'deck_cards.card_print_id backfill is incomplete';
  end if;
  if exists (select 1 from public.list_items where card_print_id is null) then
    raise exception 'list_items.card_print_id backfill is incomplete';
  end if;
end $$;

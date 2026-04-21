-- Chunk 01c: backfill card_prints from Scryfall-backed rows
-- Run after the previous 01 split chunk completes successfully.

create index if not exists deck_cards_card_print_id_idx on public.deck_cards(card_print_id);
create index if not exists list_items_card_print_id_idx on public.list_items(card_print_id);

with src as (
  select c.scryfall_id, null::text as oracle_id, c.name, c.set_code, c.collector_number,
         null::text as type_line, null::text as mana_cost, null::numeric as cmc,
         '{}'::text[] as color_identity, null::text as image_uri, null::text as art_crop_uri, 10 as source_rank
  from public.cards c
  where c.scryfall_id is not null

  union all
  select dc.scryfall_id, null::text, dc.name, dc.set_code, dc.collector_number,
         dc.type_line, dc.mana_cost, dc.cmc, coalesce(dc.color_identity, '{}'::text[]),
         dc.image_uri, null::text, 0
  from public.deck_cards dc
  where dc.scryfall_id is not null

  union all
  select li.scryfall_id, null::text, li.name, li.set_code, li.collector_number,
         null::text, null::text, null::numeric, '{}'::text[], null::text, null::text, 20
  from public.list_items li
  where li.scryfall_id is not null

  union all
  select ch.scryfall_id, ch.oracle_id, ch.name, ch.set_code, ch.collector_number,
         null::text, null::text, null::numeric, '{}'::text[], ch.image_uri, ch.art_crop_uri, 5
  from public.card_hashes ch
  where ch.scryfall_id is not null

  union all
  select cp.scryfall_id, null::text, concat_ws(' ', cp.set_code, '#' || cp.collector_number),
         cp.set_code, cp.collector_number, null::text, null::text, null::numeric,
         '{}'::text[], null::text, null::text, 30
  from public.card_prices cp
  where cp.scryfall_id is not null
),
deduped as (
  select distinct on (scryfall_id)
    scryfall_id, oracle_id, name, set_code, collector_number, type_line, mana_cost,
    cmc, color_identity, image_uri, art_crop_uri
  from src
  order by scryfall_id, source_rank
)
insert into public.card_prints (
  scryfall_id, oracle_id, name, set_code, collector_number, type_line, mana_cost,
  cmc, color_identity, image_uri, art_crop_uri
)
select
  scryfall_id, oracle_id, coalesce(nullif(name, ''), concat_ws(' ', set_code, '#' || collector_number)),
  set_code, collector_number, type_line, mana_cost, cmc, coalesce(color_identity, '{}'::text[]),
  image_uri, art_crop_uri
from deduped
on conflict (scryfall_id) do update
set
  oracle_id = coalesce(excluded.oracle_id, public.card_prints.oracle_id),
  name = coalesce(excluded.name, public.card_prints.name),
  set_code = coalesce(excluded.set_code, public.card_prints.set_code),
  collector_number = coalesce(excluded.collector_number, public.card_prints.collector_number),
  type_line = coalesce(excluded.type_line, public.card_prints.type_line),
  mana_cost = coalesce(excluded.mana_cost, public.card_prints.mana_cost),
  cmc = coalesce(excluded.cmc, public.card_prints.cmc),
  color_identity = case
    when coalesce(array_length(excluded.color_identity, 1), 0) > 0 then excluded.color_identity
    else public.card_prints.color_identity
  end,
  image_uri = coalesce(excluded.image_uri, public.card_prints.image_uri),
  art_crop_uri = coalesce(excluded.art_crop_uri, public.card_prints.art_crop_uri),
  updated_at = now();

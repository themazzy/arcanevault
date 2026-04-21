-- Chunk 01e: backfill fallback card_prints by name-only rows
-- Run after the previous 01 split chunk completes successfully.

with fallback as (
  select distinct on (name)
    name
  from (
    select name, set_code, collector_number, scryfall_id from public.cards
    union all
    select name, set_code, collector_number, scryfall_id from public.deck_cards
    union all
    select name, set_code, collector_number, scryfall_id from public.list_items
  ) src
  where scryfall_id is null
    and set_code is null
    and collector_number is null
    and nullif(name, '') is not null
  order by name
)
insert into public.card_prints (scryfall_id, name, set_code, collector_number)
select null, name, null, null
from fallback f
where not exists (
  select 1
  from public.card_prints cp
  where cp.scryfall_id is null
    and cp.set_code is null
    and cp.collector_number is null
    and cp.name = f.name
);

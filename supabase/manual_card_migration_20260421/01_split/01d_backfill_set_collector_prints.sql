-- Chunk 01d: backfill fallback card_prints by set and collector number
-- Run after the previous 01 split chunk completes successfully.
-- This intentionally uses only user-facing tables. card_hashes/card_prices can
-- be very large and are not needed to satisfy card_print_id constraints.

with fallback as (
  select distinct on (set_code, collector_number)
    null::text as scryfall_id,
    name,
    set_code,
    collector_number
  from (
    select name, set_code, collector_number from public.cards
    union all
    select name, set_code, collector_number from public.deck_cards
    union all
    select name, set_code, collector_number from public.list_items
  ) src
  where set_code is not null
    and collector_number is not null
  order by set_code, collector_number, name nulls last
)
insert into public.card_prints (scryfall_id, name, set_code, collector_number)
select null, coalesce(nullif(name, ''), concat_ws(' ', set_code, '#' || collector_number)), set_code, collector_number
from fallback f
where not exists (
  select 1
  from public.card_prints cp
  where cp.set_code is not distinct from f.set_code
    and cp.collector_number is not distinct from f.collector_number
);

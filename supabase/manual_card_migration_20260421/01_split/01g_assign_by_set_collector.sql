-- Chunk 01g: assign card_print_id by unique set and collector number
-- Run after the previous 01 split chunk completes successfully.

with unique_prints as (
  select set_code, collector_number, (array_agg(id order by id))[1] as id
  from public.card_prints
  where set_code is not null
    and collector_number is not null
  group by set_code, collector_number
  having count(*) = 1
)
update public.cards c
set card_print_id = up.id
from unique_prints up
where c.card_print_id is null
  and c.set_code is not distinct from up.set_code
  and c.collector_number is not distinct from up.collector_number;

with unique_prints as (
  select set_code, collector_number, (array_agg(id order by id))[1] as id
  from public.card_prints
  where set_code is not null
    and collector_number is not null
  group by set_code, collector_number
  having count(*) = 1
)
update public.deck_cards dc
set card_print_id = up.id
from unique_prints up
where dc.card_print_id is null
  and dc.set_code is not distinct from up.set_code
  and dc.collector_number is not distinct from up.collector_number;

with unique_prints as (
  select set_code, collector_number, (array_agg(id order by id))[1] as id
  from public.card_prints
  where set_code is not null
    and collector_number is not null
  group by set_code, collector_number
  having count(*) = 1
)
update public.list_items li
set card_print_id = up.id
from unique_prints up
where li.card_print_id is null
  and li.set_code is not distinct from up.set_code
  and li.collector_number is not distinct from up.collector_number;

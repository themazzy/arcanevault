-- Chunk 01f: assign card_print_id by scryfall_id
-- Run after the previous 01 split chunk completes successfully.

update public.cards c
set card_print_id = cp.id
from public.card_prints cp
where c.card_print_id is null
  and c.scryfall_id is not null
  and cp.scryfall_id = c.scryfall_id;

update public.deck_cards dc
set card_print_id = cp.id
from public.card_prints cp
where dc.card_print_id is null
  and dc.scryfall_id is not null
  and cp.scryfall_id = dc.scryfall_id;

update public.list_items li
set card_print_id = cp.id
from public.card_prints cp
where li.card_print_id is null
  and li.scryfall_id is not null
  and cp.scryfall_id = li.scryfall_id;

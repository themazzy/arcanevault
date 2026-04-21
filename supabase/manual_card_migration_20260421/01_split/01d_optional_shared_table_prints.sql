-- Optional: backfill fallback card_prints from shared card_hashes/card_prices.
-- Run only after the main migration succeeds, and only if you want extra shared
-- metadata coverage. This is intentionally separate because these tables can be
-- large enough to timeout in Supabase SQL Editor.

with fallback as (
  select distinct on (set_code, collector_number)
    null::text as scryfall_id,
    name,
    set_code,
    collector_number
  from (
    select name, set_code, collector_number
    from public.card_hashes
    where set_code is not null
      and collector_number is not null
    union all
    select concat_ws(' ', set_code, '#' || collector_number), set_code, collector_number
    from public.card_prices
    where set_code is not null
      and collector_number is not null
  ) src
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

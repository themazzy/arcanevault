-- Chunk 02: merge duplicate owned card rows while preserving placement quantities
-- Run after the previous numbered chunk completes successfully.

create temporary table tmp_duplicate_card_groups on commit drop as
select
  user_id,
  card_print_id,
  foil,
  coalesce(language, 'en') as language_key,
  condition,
  (array_agg(id order by added_at nulls last, id))[1] as survivor_id,
  sum(qty) as total_qty,
  count(*) as row_count
from public.cards
group by user_id, card_print_id, foil, coalesce(language, 'en'), condition
having count(*) > 1;

create temporary table tmp_duplicate_card_map on commit drop as
select c.id as old_id, g.survivor_id
from public.cards c
join tmp_duplicate_card_groups g
  on g.user_id = c.user_id
 and g.card_print_id = c.card_print_id
 and g.foil is not distinct from c.foil
 and g.language_key is not distinct from coalesce(c.language, 'en')
 and g.condition is not distinct from c.condition;

create temporary table tmp_folder_cards_merged on commit drop as
select fc.folder_id, m.survivor_id as card_id, sum(fc.qty) as qty, max(fc.updated_at) as updated_at
from public.folder_cards fc
join tmp_duplicate_card_map m on m.old_id = fc.card_id
group by fc.folder_id, m.survivor_id;

delete from public.folder_cards fc
using tmp_duplicate_card_map m
where fc.card_id = m.old_id;

insert into public.folder_cards (folder_id, card_id, qty, updated_at)
select folder_id, card_id, qty, coalesce(updated_at, now())
from tmp_folder_cards_merged
on conflict (folder_id, card_id) do update
set qty = public.folder_cards.qty + excluded.qty,
    updated_at = now();

create temporary table tmp_deck_allocations_merged on commit drop as
select da.deck_id, da.user_id, m.survivor_id as card_id, sum(da.qty) as qty, min(da.created_at) as created_at, max(da.updated_at) as updated_at
from public.deck_allocations da
join tmp_duplicate_card_map m on m.old_id = da.card_id
group by da.deck_id, da.user_id, m.survivor_id;

delete from public.deck_allocations da
using tmp_duplicate_card_map m
where da.card_id = m.old_id;

insert into public.deck_allocations (deck_id, user_id, card_id, qty, created_at, updated_at)
select deck_id, user_id, card_id, qty, coalesce(created_at, now()), coalesce(updated_at, now())
from tmp_deck_allocations_merged
on conflict (deck_id, card_id) do update
set qty = public.deck_allocations.qty + excluded.qty,
    updated_at = now();

update public.cards c
set qty = g.total_qty,
    updated_at = now()
from tmp_duplicate_card_groups g
where c.id = g.survivor_id;

delete from public.cards c
using tmp_duplicate_card_map m
where c.id = m.old_id
  and c.id <> m.survivor_id;

insert into public.card_schema_migration_audit (phase, details)
select 'duplicate_cards_merged',
  jsonb_build_object(
    'groups', coalesce(sum(row_count), 0),
    'survivors', count(*)
  )
from tmp_duplicate_card_groups;

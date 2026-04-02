insert into public.deck_allocations (
  deck_id,
  user_id,
  card_id,
  qty
)
select
  fc.folder_id as deck_id,
  f.user_id,
  fc.card_id,
  fc.qty
from public.folder_cards fc
join public.folders f on f.id = fc.folder_id
where f.type = 'deck'
on conflict (deck_id, card_id) do update
set
  qty = excluded.qty,
  updated_at = now();

-- Give every newly recorded owned card a cost basis.
--
-- `cards.purchase_price` is what P&L subtracts from the current market price
-- (Stats.jsx, filterCore.js), so a row at 0 is not "free" — it is invisible to
-- every profit/loss surface in the app. Three insert paths left it at 0:
-- the scanner never sent the column at all, plain decklist imports have no
-- price to send, and `commit_trade` falls back to 0 for an unpriced want.
-- A 400-card scanned binder was therefore untrackable.
--
-- Filling it here rather than at each call site is deliberate: the trigger
-- covers the scanner, AddCardModal, ImportModal, commit_trade,
-- deckBuilderWrites and anything added later, with no extra round trip — the
-- price is already in the database, one index lookup away.
--
-- EUR, always. Every one of the ~19.7k rows that already carries a price is in
-- EUR, `cards.currency` defaults to 'EUR' and nothing reads it, and
-- filterCore's P&L sort is hardcoded to 'cardmarket_trend'. price_regular_eur /
-- price_foil_eur are exactly that source (scripts/sync-card-prices.mjs maps
-- them from Scryfall's prices.eur / prices.eur_foil).
--
-- No foil -> non-foil fallback, matching getPriceWithMeta: a foil printing with
-- no foil price yields no market price anywhere in the app, and inventing one
-- from the non-foil price would make its P&L wrong rather than absent.

create or replace function public.fill_purchase_price_from_market()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_price numeric;
begin
  -- Today's snapshot preferred, yesterday's accepted: card_prices retains only
  -- those two, and the daily sync runs at 03:20 UTC, so a card added just
  -- before it would otherwise find nothing.
  select s.px
    into v_price
  from (
    select case when new.foil then p.price_foil_eur else p.price_regular_eur end as px,
           p.snapshot_date
    from public.card_prints cp
    join public.card_prices p on p.scryfall_id = cp.scryfall_id
    where cp.id = new.card_print_id
      and p.snapshot_date >= current_date - 1
  ) s
  where s.px is not null
    and s.px > 0
  order by s.snapshot_date desc
  limit 1;

  -- Cards with no market price at all (~13% of prints) stay at 0. That is the
  -- same thing the UI shows for them, and it keeps them out of P&L rather than
  -- feeding it a made-up number.
  if v_price is not null then
    new.purchase_price := v_price;
    new.currency := coalesce(new.currency, 'EUR');
  end if;

  return new;
end;
$$;

comment on function public.fill_purchase_price_from_market() is
  'BEFORE INSERT on cards: fills purchase_price from the latest card_prices EUR snapshot when the caller supplied none. A price the user typed always wins (the trigger only fires on 0/null).';

drop trigger if exists cards_default_purchase_price on public.cards;

-- WHEN, not an IF inside the function: a caller-supplied price must never even
-- reach the lookup, and rows that already carry one skip the index probe.
create trigger cards_default_purchase_price
  before insert on public.cards
  for each row
  when (coalesce(new.purchase_price, 0) = 0)
  execute function public.fill_purchase_price_from_market();

-- One-off backfill of the rows that predate the trigger (2,628 across 9 users
-- at the time of writing, ~98% priceable).
--
-- This necessarily uses *today's* price as the cost basis for a card acquired
-- weeks ago, because card_prices keeps two days and the history simply does not
-- exist. P&L for those cards therefore starts near zero and tracks forward,
-- which is strictly better than the 0 that hid them from it entirely.
-- A LATERAL in an UPDATE ... FROM cannot see the update target, so the price
-- is resolved per row in a CTE first. The `px is not null` join is what keeps
-- an unpriceable card at 0 instead of overwriting it with NULL.
with priced as (
  select oc.id as card_id,
         (
           select case when oc.foil then p.price_foil_eur else p.price_regular_eur end
           from public.card_prints cp
           join public.card_prices p on p.scryfall_id = cp.scryfall_id
           where cp.id = oc.card_print_id
             and p.snapshot_date >= current_date - 1
             and (case when oc.foil then p.price_foil_eur else p.price_regular_eur end) > 0
           order by p.snapshot_date desc
           limit 1
         ) as px
  from public.cards oc
  where coalesce(oc.purchase_price, 0) = 0
)
update public.cards c
set purchase_price = priced.px,
    currency = coalesce(c.currency, 'EUR')
from priced
where priced.card_id = c.id
  and priced.px is not null;

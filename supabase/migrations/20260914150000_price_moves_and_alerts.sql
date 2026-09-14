-- Daily price movers, computed once for everyone.
--
-- The shape is the whole point. Alerts could be computed per user — join each
-- account's cards against the history and diff — but that is 40 collections of
-- up to 17k rows a day, and the kind of per-row work that has repeatedly blown
-- statement timeouts here. Instead the ingest job, which already holds every
-- series in memory, writes the movers ONCE for the whole catalogue, and each
-- client intersects that short list against the collection it already has in
-- IDB. Per-user server cost is zero.
--
-- FLOOR, not threshold: rows are stored at >=10% AND >=0.50, deliberately
-- looser than any sane alert setting, so a user tightening their own threshold
-- is a client-side filter over data we already computed. Measured 2026-09-14
-- across 87,163 priced printings, one day of EUR moves:
--
--     >=10% alone          6,751 rows   (noise: EUR 0.02 -> 0.03 is +50%)
--     >=10% and >=EUR 0.50    60 rows
--     >=20% and >=EUR 1        9 rows
--     >=25% and >=EUR 2        2 rows
--
-- The absolute gate does nearly all the work, which is why it is not optional.
-- ~60-150 rows/day across both currencies and finishes, pruned to 7 days.
--
-- Interpolated days are excluded by the job, not here: a price nobody published
-- must never produce an alert.

create table if not exists public.card_price_moves (
  scryfall_id text not null,
  move_date   date not null,
  currency    text not null check (currency in ('eur', 'usd')),
  finish      text not null check (finish in ('normal', 'foil')),
  price_from  real not null,
  price_to    real not null,
  delta       real not null,
  pct         real not null,
  primary key (scryfall_id, move_date, currency, finish)
);

create index if not exists card_price_moves_date_idx
  on public.card_price_moves (move_date desc);

comment on table public.card_price_moves is
  'Printings whose price moved at least 10% and 0.50 in a day. Written by scripts/sync-price-history.mjs for the whole catalogue; clients filter it against their own collection and their own thresholds. Never contains a move involving an interpolated day.';

alter table public.card_price_moves enable row level security;

-- Public reference data, like card_prints: a signed-out visitor never reads it,
-- but there is nothing user-specific in it and gating it would mean a bespoke
-- policy for no benefit.
drop policy if exists "card_price_moves readable by everyone" on public.card_price_moves;
create policy "card_price_moves readable by everyone"
  on public.card_price_moves for select
  to anon, authenticated
  using (true);

grant select on public.card_price_moves to anon, authenticated;

-- ── Alert notifications ─────────────────────────────────────────────────────
-- Same self-insert trick as milestones and announcements: the client detects
-- the alert and writes its own row, deduped by the existing
-- UNIQUE (user_id, milestone_id). Keys are `price:<scryfall_id>:<date>`, so a
-- card that moves twice in a week produces two alerts and the same card seen
-- from two devices produces one.
drop policy if exists "insert own milestone notifications" on public.notifications;

create policy "insert own milestone notifications"
  on public.notifications for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and type in ('milestone', 'announcement', 'price_alert')
    and milestone_id is not null
    and actor_id is null
    and deck_id is null
    and comment_id is null
  );

-- ── Settings ────────────────────────────────────────────────────────────────
-- SettingsContext writes an explicit column list, so these have to exist before
-- the client can save them. Defaults match the measured recommendation: 20% and
-- 1 unit of the user's own currency, which was 9 movers across the entire
-- catalogue on the day it was measured.
alter table public.user_settings
  add column if not exists price_alerts_enabled  boolean not null default true,
  add column if not exists price_alert_pct       integer not null default 20,
  add column if not exists price_alert_min_value numeric not null default 1,
  add column if not exists price_alert_days      integer not null default 7;

comment on column public.user_settings.price_alert_min_value is
  'Minimum absolute move, in the currency of the user''s price_source. Without it a percentage threshold fires on penny cards: 6,751 printings moved 10% on one measured day, of which only 60 also moved 0.50.';

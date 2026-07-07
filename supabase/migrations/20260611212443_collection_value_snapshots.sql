-- Collection value history: one row per user per day, upserted by the client
-- when Stats computes totals. Powers the portfolio value-over-time chart.
-- One tiny row/user/day keeps this viable on the free tier (per-card price
-- history would not be).
create table if not exists public.collection_value_snapshots (
  user_id        uuid not null references auth.users(id) on delete cascade,
  snapshot_date  date not null,
  total_eur      numeric(12,2) not null default 0,
  total_usd      numeric(12,2) not null default 0,
  card_count     integer not null default 0,
  created_at     timestamptz not null default now(),
  primary key (user_id, snapshot_date)
);

alter table public.collection_value_snapshots enable row level security;

create policy "users manage own value snapshots"
  on public.collection_value_snapshots
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Public-schema GRANTs must be explicit (new-table auto-exposure is being
-- turned off platform-wide).
grant select, insert, update, delete on public.collection_value_snapshots to authenticated;

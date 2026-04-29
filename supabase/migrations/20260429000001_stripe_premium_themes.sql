alter table public.user_settings
  add column if not exists premium boolean default false,
  add column if not exists stripe_customer_id text,
  add column if not exists premium_unlocked_at timestamptz,
  add column if not exists premium_checkout_session_id text;

create table if not exists public.premium_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stripe_checkout_session_id text not null unique,
  stripe_customer_id text,
  stripe_payment_intent_id text,
  amount_total integer,
  currency text,
  status text,
  raw_event_id text,
  purchased_at timestamptz default now(),
  created_at timestamptz default now()
);

create index if not exists premium_purchases_user_id_idx
  on public.premium_purchases(user_id);

alter table public.premium_purchases enable row level security;

drop policy if exists "Users can read own premium purchases" on public.premium_purchases;
create policy "Users can read own premium purchases"
  on public.premium_purchases
  for select
  to authenticated
  using (auth.uid() = user_id);

revoke all on public.premium_purchases from anon;
grant select on public.premium_purchases to authenticated;

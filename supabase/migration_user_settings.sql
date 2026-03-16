-- Run this in Supabase SQL Editor if you get a 404 on user_settings
create table if not exists user_settings (
  user_id       uuid references auth.users on delete cascade primary key,
  currency      text default 'EUR',
  price_type    text default 'market',
  default_sort  text default 'name',
  grid_density  text default 'comfortable',
  show_price    boolean default true,
  cache_ttl_h   integer default 24,
  updated_at    timestamptz default now()
);
alter table user_settings enable row level security;

-- Drop existing policy if re-running
drop policy if exists "own settings" on user_settings;
create policy "own settings" on user_settings for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant all on user_settings to authenticated;

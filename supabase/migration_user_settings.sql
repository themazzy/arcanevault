-- Run this in Supabase SQL Editor if you get a 404 on user_settings
create table if not exists user_settings (
  user_id            uuid references auth.users on delete cascade primary key,
  currency           text default 'EUR',
  price_type         text default 'market',
  price_source       text default 'cardmarket_trend',
  default_sort       text default 'name',
  grid_density       text default 'comfortable',
  show_price         boolean default true,
  cache_ttl_h        integer default 24,
  binder_sort        text default 'name',
  deck_sort          text default 'name',
  list_sort          text default 'name',
  font_weight        integer default 420,
  font_size          integer default 16,
  theme              text default 'shadow',
  oled_mode          boolean default false,
  nickname           text default '',
  anonymize_email    boolean default false,
  reduce_motion      boolean default false,
  higher_contrast    boolean default false,
  card_name_size     text default 'default',
  default_grouping   text default 'type',
  keep_screen_awake  boolean default false,
  show_sync_errors   boolean default false,
  archive_background_mode text not null default 'random',
  archive_background_cards jsonb not null default '[]'::jsonb,
  updated_at         timestamptz default now()
);
alter table user_settings enable row level security;

-- Drop existing policy if re-running
drop policy if exists "own settings" on user_settings;
create policy "own settings" on user_settings for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant all on user_settings to authenticated;

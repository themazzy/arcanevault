-- ─── DECKLOOM SCHEMA v2 ───────────────────────────────────────────────────
-- Run in Supabase: Dashboard → SQL Editor → New query → Paste → Run
-- If you ran v1 schema before, run the cleanup block first.

-- ── CLEANUP (drop old tables if migrating from v1) ───────────────────────────
drop table if exists folder_cards cascade;
drop table if exists shared_folders cascade;
drop table if exists folders cascade;
drop table if exists cards cascade;
-- also drop old v1 tables
drop table if exists collections cascade;
drop table if exists decks cascade;
drop table if exists binders cascade;

-- ── CARDS ─────────────────────────────────────────────────────────────────────
create table cards (
  id                uuid default gen_random_uuid() primary key,
  user_id           uuid references auth.users on delete cascade not null,
  scryfall_id       text,
  name              text not null,
  set_code          text not null,
  collector_number  text,
  foil              boolean default false,
  qty               integer default 1 check (qty >= 0),
  condition         text,
  language          text default 'en',
  purchase_price    numeric(10,2) default 0,
  currency          text default 'EUR',
  misprint          boolean default false,
  altered           boolean default false,
  added_at          timestamptz default now(),
  updated_at        timestamptz default now(),
  -- prevent duplicate entries for same physical card
  unique (user_id, set_code, collector_number, foil, language, condition)
);

-- ── FOLDERS (binders, decks, lists) ──────────────────────────────────────────
create table folders (
  id         uuid default gen_random_uuid() primary key,
  user_id    uuid references auth.users on delete cascade not null,
  name       text not null,
  type       text not null check (type in ('binder', 'deck', 'list')),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, name, type)
);

-- ── FOLDER_CARDS ──────────────────────────────────────────────────────────────
create table folder_cards (
  id        uuid default gen_random_uuid() primary key,
  folder_id uuid references folders on delete cascade not null,
  card_id   uuid references cards on delete cascade not null,
  qty       integer default 1 check (qty >= 1),
  updated_at timestamptz default now(),
  unique (folder_id, card_id)
);

create table if not exists card_prices (
  scryfall_id        text not null,
  set_code           text not null,
  collector_number   text not null,
  snapshot_date      date not null,
  price_regular_eur  numeric(10,2),
  price_foil_eur     numeric(10,2),
  price_regular_usd  numeric(10,2),
  price_foil_usd     numeric(10,2),
  updated_at         timestamptz not null default now(),
  primary key (scryfall_id, snapshot_date)
);

create table if not exists card_prices_stage (
  scryfall_id        text not null,
  set_code           text not null,
  collector_number   text not null,
  snapshot_date      date not null,
  price_regular_eur  numeric(10,2),
  price_foil_eur     numeric(10,2),
  price_regular_usd  numeric(10,2),
  price_foil_usd     numeric(10,2),
  updated_at         timestamptz not null default now(),
  primary key (scryfall_id, snapshot_date)
);

create table if not exists card_hashes (
  scryfall_id        text primary key,
  name               text not null,
  set_code           text,
  collector_number   text,
  phash_hex          text,
  image_uri          text,
  art_crop_uri       text
);

-- ── SHARED FOLDERS (public read-only links) ───────────────────────────────────
create table shared_folders (
  id           uuid default gen_random_uuid() primary key,
  folder_id    uuid references folders on delete cascade not null unique,
  public_token text not null unique default encode(gen_random_bytes(16), 'hex'),
  created_at   timestamptz default now()
);

-- ── INDEXES ───────────────────────────────────────────────────────────────────
create index cards_user_id_idx           on cards(user_id);
create index cards_scryfall_id_idx       on cards(scryfall_id);
create index cards_set_code_idx          on cards(set_code);
create index cards_added_at_idx          on cards(added_at);
create index folders_user_id_idx         on folders(user_id);
create index folder_cards_folder_id_idx  on folder_cards(folder_id);
create index folder_cards_card_id_idx    on folder_cards(card_id);
create index folder_cards_updated_at_idx on folder_cards(updated_at);
create index card_prices_snapshot_date_idx on card_prices(snapshot_date);
create index card_prices_set_collector_snapshot_idx on card_prices(set_code, collector_number, snapshot_date);
create index card_prices_stage_snapshot_date_idx on card_prices_stage(snapshot_date);
create index card_prices_stage_set_collector_snapshot_idx on card_prices_stage(set_code, collector_number, snapshot_date);
create index if not exists card_hashes_phash_idx on card_hashes(phash_hex) where phash_hex is not null;

-- ── ROW LEVEL SECURITY ────────────────────────────────────────────────────────
alter table cards            enable row level security;
alter table folders          enable row level security;
alter table folder_cards     enable row level security;
alter table card_prices      enable row level security;
alter table card_prices_stage enable row level security;
alter table card_hashes      enable row level security;
alter table shared_folders   enable row level security;

-- cards: users own their cards
create policy "own cards"   on cards           for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own folders" on folders         for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "public read card_prices" on card_prices for select using (true);
create policy "public read card_hashes" on card_hashes for select using (true);

-- folder_cards: access if you own the folder
create policy "own folder_cards" on folder_cards for all
  using (exists (select 1 from folders where folders.id = folder_cards.folder_id and folders.user_id = auth.uid()))
  with check (exists (select 1 from folders where folders.id = folder_cards.folder_id and folders.user_id = auth.uid()));

-- shared_folders: owner can manage, anyone can read via public token
create policy "own shared_folders" on shared_folders for all
  using (exists (select 1 from folders where folders.id = shared_folders.folder_id and folders.user_id = auth.uid()));
create policy "public read shared_folders" on shared_folders for select
  using (true);

-- ── GRANTS ────────────────────────────────────────────────────────────────────
grant all on cards, folders, folder_cards, shared_folders to authenticated;
grant select on shared_folders to anon;
grant select on card_prices to authenticated, anon;
grant select on card_hashes to authenticated, anon;
revoke all on card_prices_stage from anon, authenticated;
revoke all on card_prices_stage from public;

create or replace function publish_card_prices(p_snapshot_date date, p_retention_cutoff date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.card_prices
  where snapshot_date = p_snapshot_date;

  insert into public.card_prices (
    scryfall_id,
    set_code,
    collector_number,
    snapshot_date,
    price_regular_eur,
    price_foil_eur,
    price_regular_usd,
    price_foil_usd,
    updated_at
  )
  select
    scryfall_id,
    set_code,
    collector_number,
    snapshot_date,
    price_regular_eur,
    price_foil_eur,
    price_regular_usd,
    price_foil_usd,
    updated_at
  from public.card_prices_stage
  where snapshot_date = p_snapshot_date;

  delete from public.card_prices
  where snapshot_date < p_retention_cutoff;

  delete from public.card_prices_stage
  where snapshot_date = p_snapshot_date;
end;
$$;

-- ── UPDATED_AT TRIGGER ────────────────────────────────────────────────────────
create or replace function update_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger cards_updated_at   before update on cards   for each row execute function update_updated_at();
create trigger folders_updated_at before update on folders for each row execute function update_updated_at();
create trigger folder_cards_updated_at before update on folder_cards for each row execute function update_updated_at();

-- ── USER SETTINGS ─────────────────────────────────────────────────────────────
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
  page_tips_seen     jsonb not null default '{}'::jsonb,
  archive_background_mode text not null default 'random',
  archive_background_cards jsonb not null default '[]'::jsonb,
  premium            boolean default false,
  stripe_customer_id text,
  premium_unlocked_at timestamptz,
  premium_checkout_session_id text,
  updated_at         timestamptz default now()
);

alter table user_settings enable row level security;
create policy "own settings" on user_settings for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Admins can update any user_settings" on user_settings
  for update to authenticated
  using (
    exists (
      select 1
      from admin_users
      where admin_users.user_id = auth.uid()
        and admin_users.active = true
    )
  );
create policy "Admins can insert user_settings" on user_settings
  for insert to authenticated
  with check (
    exists (
      select 1
      from admin_users
      where admin_users.user_id = auth.uid()
        and admin_users.active = true
    )
  );
grant all on user_settings to authenticated;

create table if not exists premium_purchases (
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
  on premium_purchases(user_id);

alter table premium_purchases enable row level security;
create policy "Users can read own premium purchases" on premium_purchases
  for select to authenticated
  using (auth.uid() = user_id);
revoke all on premium_purchases from anon;
grant select on premium_purchases to authenticated;

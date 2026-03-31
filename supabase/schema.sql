-- ─── ARCANEVAULT SCHEMA v2 ───────────────────────────────────────────────────
-- Run in Supabase: Dashboard → SQL Editor → New query → Paste → Run
-- If you ran v1 schema before, run the cleanup block first.

-- ── CLEANUP (drop old tables if migrating from v1) ───────────────────────────
drop table if exists folder_cards cascade;
drop table if exists shared_folders cascade;
drop table if exists price_snapshots cascade;
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

-- ── PRICE SNAPSHOTS ───────────────────────────────────────────────────────────
create table price_snapshots (
  id        uuid default gen_random_uuid() primary key,
  user_id   uuid references auth.users on delete cascade not null,
  value_eur numeric(10,2) not null,
  taken_at  timestamptz default now()
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
create index price_snapshots_user_id_idx on price_snapshots(user_id);
create index price_snapshots_taken_at_idx on price_snapshots(taken_at);

-- ── ROW LEVEL SECURITY ────────────────────────────────────────────────────────
alter table cards            enable row level security;
alter table folders          enable row level security;
alter table folder_cards     enable row level security;
alter table price_snapshots  enable row level security;
alter table shared_folders   enable row level security;

-- cards: users own their cards
create policy "own cards"   on cards           for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own folders" on folders         for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own snapshots" on price_snapshots for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

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
grant all on cards, folders, folder_cards, price_snapshots, shared_folders to authenticated;
grant select on shared_folders to anon;

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
  user_id       uuid references auth.users on delete cascade primary key,
  currency      text default 'EUR',
  price_type    text default 'market',   -- market | low | mid
  default_sort  text default 'name',
  grid_density  text default 'comfortable', -- comfortable | compact | cozy
  show_price    boolean default true,
  cache_ttl_h   integer default 24,
  updated_at    timestamptz default now()
);

alter table user_settings enable row level security;
create policy "own settings" on user_settings for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant all on user_settings to authenticated;

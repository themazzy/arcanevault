-- ── WISHLIST / LIST ITEMS ─────────────────────────────────────────────────────
-- Cards in "List" folders are wants, not owned cards.
-- They live here instead of the cards table.
create table if not exists list_items (
  id               uuid default gen_random_uuid() primary key,
  folder_id        uuid references folders on delete cascade not null,
  user_id          uuid references auth.users on delete cascade not null,
  name             text not null,
  set_code         text,
  collector_number text,
  scryfall_id      text,
  foil             boolean default false,
  qty              integer default 1 check (qty >= 1),
  added_at         timestamptz default now(),
  unique (folder_id, set_code, collector_number, foil)
);

alter table list_items enable row level security;
drop policy if exists "own list_items" on list_items;
create policy "own list_items" on list_items for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant all on list_items to authenticated;

create index if not exists list_items_folder_id_idx on list_items(folder_id);
create index if not exists list_items_user_id_idx   on list_items(user_id);

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
create or replace function sync_list_item_user_id()
returns trigger as $$
begin
  select user_id into new.user_id
  from folders
  where id = new.folder_id;

  return new;
end;
$$ language plpgsql;

drop trigger if exists list_items_sync_user_id on list_items;
create trigger list_items_sync_user_id
  before insert or update on list_items
  for each row execute function sync_list_item_user_id();

update list_items li
set user_id = f.user_id
from folders f
where f.id = li.folder_id
  and li.user_id is distinct from f.user_id;

drop policy if exists "own list_items" on list_items;
drop policy if exists "own list_items via folder" on list_items;
create policy "own list_items via folder" on list_items for all
  using (exists (
    select 1
    from folders
    where folders.id = list_items.folder_id
      and folders.user_id = auth.uid()
  ))
  with check (exists (
    select 1
    from folders
    where folders.id = list_items.folder_id
      and folders.user_id = auth.uid()
  ));
grant all on list_items to authenticated;

create index if not exists list_items_folder_id_idx on list_items(folder_id);
create index if not exists list_items_user_id_idx   on list_items(user_id);

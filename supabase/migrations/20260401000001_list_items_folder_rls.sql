create or replace function public.sync_list_item_user_id()
returns trigger as $$
begin
  select user_id into new.user_id
  from public.folders
  where id = new.folder_id;

  return new;
end;
$$ language plpgsql;

drop trigger if exists list_items_sync_user_id on public.list_items;
create trigger list_items_sync_user_id
  before insert or update on public.list_items
  for each row execute function public.sync_list_item_user_id();

update public.list_items li
set user_id = f.user_id
from public.folders f
where f.id = li.folder_id
  and li.user_id is distinct from f.user_id;

drop policy if exists "own list_items" on public.list_items;
drop policy if exists "own list_items via folder" on public.list_items;
create policy "own list_items via folder" on public.list_items for all
  using (exists (
    select 1
    from public.folders
    where folders.id = list_items.folder_id
      and folders.user_id = auth.uid()
  ))
  with check (exists (
    select 1
    from public.folders
    where folders.id = list_items.folder_id
      and folders.user_id = auth.uid()
  ));

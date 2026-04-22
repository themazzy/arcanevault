-- Pin trigger-function search paths so Supabase does not execute them with a
-- mutable caller-controlled path.

create or replace function public.sync_list_item_user_id()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  select user_id into new.user_id
  from public.folders
  where id = new.folder_id;

  return new;
end;
$$;

create or replace function public.prevent_deck_folder_cards()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from public.folders
    where id = new.folder_id
      and type = 'deck'
  ) then
    raise exception 'folder_cards cannot reference folders of type deck';
  end if;
  return new;
end;
$$;

create or replace function public.update_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Guard the cached deck rollups (folders.deck_color_identity / deck_card_count)
-- against direct client writes. They're maintained by refresh_deck_rollups
-- (SECURITY DEFINER, owned by postgres) via the deck_cards/deck_allocations
-- triggers. Because folders is owner-writable under RLS, a user could otherwise
-- PATCH these columns directly and cosmetically spoof their own deck's badge /
-- card count in the community list. No cross-user impact, but it defeats the
-- point of the cache — so we pin them to their prior value for any write that
-- comes from a browser-facing role.
--
-- The rollup function runs as postgres, so its inner UPDATE sees current_user =
-- postgres and passes through untouched; only 'authenticated'/'anon' (the only
-- roles a client can ever hold) are reverted.

create or replace function public.guard_folder_rollups()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.deck_color_identity := old.deck_color_identity;
    new.deck_card_count     := old.deck_card_count;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_folder_rollups() from public, anon, authenticated;

drop trigger if exists folders_guard_rollups on public.folders;
create trigger folders_guard_rollups
  before update on public.folders
  for each row
  execute function public.guard_folder_rollups();

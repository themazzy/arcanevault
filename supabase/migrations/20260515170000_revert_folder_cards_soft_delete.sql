-- Revert the folder_cards soft-delete machinery from 20260515150000. The
-- soft-delete only paid off if clients did incremental sync via the
-- get_folder_cards_changes RPC, but the client still does full fetches via
-- React Query — RLS-hidden tombstones look identical to absent rows on a
-- full fetch, while the table grows unboundedly with dead rows server-side.
-- Hard-delete is cleaner for storage.

-- 1. Hard-delete any tombstones first so the partial unique index can be
--    swapped back to a full unique constraint without conflicts.
delete from public.folder_cards where deleted_at is not null;

-- 2. Restore the unique constraint over (folder_id, card_id).
drop index if exists public.folder_cards_folder_id_card_id_active_key;
alter table public.folder_cards
  add constraint folder_cards_folder_id_card_id_key unique (folder_id, card_id);

-- 3. Restore the simple RLS policy (no deleted_at filter).
drop policy if exists "own folder_cards" on public.folder_cards;
create policy "own folder_cards"
  on public.folder_cards
  as permissive
  for all
  to public
  using (
    exists (
      select 1 from public.folders
      where folders.id = folder_cards.folder_id
        and folders.user_id = (select auth.uid())
    )
  );

-- 4. Drop the unused incremental-sync RPC.
drop function if exists public.get_folder_cards_changes(timestamptz);

-- 5. Drop the column and its index.
drop index if exists public.folder_cards_deleted_at_idx;
alter table public.folder_cards drop column if exists deleted_at;

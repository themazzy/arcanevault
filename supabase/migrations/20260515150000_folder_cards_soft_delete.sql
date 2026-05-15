-- Soft-delete folder_cards so the existing updated_at delta sync can carry
-- tombstones to clients. Drops the need for a periodic full reconcile.

alter table public.folder_cards
  add column if not exists deleted_at timestamptz;

create index if not exists folder_cards_deleted_at_idx
  on public.folder_cards (deleted_at)
  where deleted_at is not null;

-- Re-scope the unique constraint to live rows only so re-adding a card to a
-- folder after a soft-delete just inserts a new row alongside the tombstone.
alter table public.folder_cards
  drop constraint if exists folder_cards_folder_id_card_id_key;

create unique index if not exists folder_cards_folder_id_card_id_active_key
  on public.folder_cards (folder_id, card_id)
  where deleted_at is null;

-- Hide tombstones from regular reads. Splitting USING / WITH CHECK lets the
-- client UPDATE a live row INTO a tombstone (the old row passes USING; the
-- new row passes WITH CHECK because folder ownership is unchanged).
drop policy if exists "own folder_cards" on public.folder_cards;
create policy "own folder_cards"
  on public.folder_cards
  as permissive
  for all
  to public
  using (
    deleted_at is null
    and exists (
      select 1 from public.folders
      where folders.id = folder_cards.folder_id
        and folders.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.folders
      where folders.id = folder_cards.folder_id
        and folders.user_id = (select auth.uid())
    )
  );

-- Delta sync RPC that returns tombstones in addition to live rows. Runs as
-- definer so the policy above (which hides tombstones) doesn't filter them
-- out, but explicitly checks folder ownership.
create or replace function public.get_folder_cards_changes(p_updated_after timestamptz)
returns setof public.folder_cards
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select fc.*
  from public.folder_cards fc
  join public.folders f on f.id = fc.folder_id
  where f.user_id = auth.uid()
    and fc.updated_at > p_updated_after;
$$;

revoke all on function public.get_folder_cards_changes(timestamptz) from public;
grant execute on function public.get_folder_cards_changes(timestamptz) to authenticated;

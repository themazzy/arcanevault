-- Fix "Database error deleting user" on admin account deletion.
--
-- GoTrue's admin.deleteUser() runs as supabase_auth_admin, which intentionally
-- has no privileges on public tables. Deleting a row from auth.users fires the
-- ON DELETE CASCADE referential action against public.deck_cards and
-- public.deck_allocations. Postgres runs the cascading DELETE statement
-- unconditionally -- even when the user owns zero rows -- so the statement-level
-- AFTER DELETE trigger (deck_cards_meaningful_del / deck_allocations_meaningful_del)
-- always fires.
--
-- Referential actions switch to the referencing table's owner only for the RI
-- query itself; triggers on the cascaded table still execute as the invoking
-- role. mark_decks_modified_on_card_delete was SECURITY INVOKER, so its
-- "update public.folders" was permission-checked against supabase_auth_admin and
-- failed with "permission denied for table folders". GoTrue swallows the detail
-- and reports the opaque "Database error deleting user".
--
-- The sibling rollup triggers (deck_rollup_on_delete etc.) are already
-- SECURITY DEFINER for exactly this reason; the deck_modified_at family added in
-- 20260716122058 missed it. Only the DELETE variant is reachable from a cascade,
-- so the INSERT/UPDATE variants stay SECURITY INVOKER -- nothing but the app's
-- own authenticated writes ever fires those, and leaving them invoker keeps RLS
-- applied to them.
create or replace function public.mark_decks_modified_on_card_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  update public.folders f
  set deck_modified_at = now()
  where f.id in (
    select distinct deck_id
    from old_rows
    where deck_id is not null
  )
    and (
      (tg_table_name = 'deck_cards' and f.type in ('builder_deck', 'deck'))
      or (tg_table_name = 'deck_allocations' and f.type = 'deck')
    );

  return null;
end;
$function$;

revoke all on function public.mark_decks_modified_on_card_delete() from public, anon, authenticated;

-- Same class of latent failure on the account-deletion path: list_items.claimed_by
-- is ON DELETE SET NULL, so deleting an auth user issues an UPDATE on list_items,
-- whose BEFORE UPDATE trigger reads public.folders as supabase_auth_admin.
-- The trigger only exists to derive user_id from the parent folder, so skip the
-- lookup entirely when folder_id did not change. That removes the cascade failure
-- without granting the trigger elevated rights, and saves a lookup on every
-- ordinary list_items update.
create or replace function public.sync_list_item_user_id()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  if tg_op = 'UPDATE' and new.folder_id is not distinct from old.folder_id then
    return new;
  end if;

  select user_id into new.user_id
  from public.folders
  where id = new.folder_id;

  return new;
end;
$function$;

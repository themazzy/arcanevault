-- Repair live policy/grant drift after a partially-applied security hardening pass.
-- This migration is intentionally idempotent: it re-establishes the intended
-- end state for private collection tables, public deck access, and shared
-- card_prints writes even if prior migrations were applied manually.

-- Private collection tables should never be directly accessible to anon.
revoke all on public.cards            from anon;
revoke all on public.folder_cards     from anon;
revoke all on public.deck_allocations from anon;
revoke all on public.list_items       from anon;
revoke all on public.user_settings    from anon;
revoke all on public.deck_cards       from anon;

grant all on public.cards            to authenticated;
grant all on public.folder_cards     to authenticated;
grant all on public.deck_allocations to authenticated;
grant all on public.list_items       to authenticated;
grant all on public.user_settings    to authenticated;
grant all on public.deck_cards       to authenticated;

-- folders are public-readable only through RLS for intentionally-public decks.
revoke all on public.folders from anon;
grant select on public.folders to anon;
grant all on public.folders to authenticated;

drop policy if exists "Public read public deck folders" on public.folders;
create policy "Public read public deck folders"
  on public.folders for select
  using (
    type in ('deck', 'builder_deck')
    and public.safe_jsonb(description) ->> 'is_public' = 'true'
  );

-- deck_cards should only be readable by the owner or for public decks.
drop policy if exists "Public read deck_cards" on public.deck_cards;
create policy "Public read deck_cards"
  on public.deck_cards for select
  using (
    exists (
      select 1
      from public.folders f
      where f.id = deck_cards.deck_id
        and (
          f.user_id = auth.uid()
          or public.safe_jsonb(f.description) ->> 'is_public' = 'true'
        )
    )
  );

revoke all on public.deck_cards_view from anon;
grant select on public.deck_cards_view to authenticated;

-- card_prints should be world-readable, but authenticated users may only insert
-- prints that do not already exist.
revoke all on public.card_prints from anon;
grant select on public.card_prints to anon;
grant select, insert on public.card_prints to authenticated;
revoke update, delete, truncate on public.card_prints from authenticated;

drop policy if exists "authenticated insert card_prints" on public.card_prints;
drop policy if exists "authenticated insert card_prints new only" on public.card_prints;
drop policy if exists "authenticated update card_prints" on public.card_prints;

create policy "authenticated insert card_prints new only"
  on public.card_prints
  for insert
  to authenticated
  with check (
    (
      scryfall_id is not null
      and not exists (
        select 1
        from public.card_prints existing_cp
        where existing_cp.scryfall_id = public.card_prints.scryfall_id
      )
    )
    or
    (
      scryfall_id is null
      and not exists (
        select 1
        from public.card_prints existing_cp
        where existing_cp.scryfall_id is null
          and existing_cp.set_code = public.card_prints.set_code
          and existing_cp.collector_number = public.card_prints.collector_number
      )
    )
  );

-- Public function grants should match the hardened RPC surface.
revoke execute on function public.get_my_decks() from public;
revoke execute on function public.get_my_decks() from anon;
grant execute on function public.get_my_decks() to authenticated;

do $$
begin
  revoke execute on function public.get_my_decks(uuid) from authenticated;
exception
  when undefined_function then null;
end $$;

-- Storage bucket definitions are admin-only.
revoke all on storage.buckets from public;
revoke all on storage.buckets from anon;
revoke all on storage.buckets from authenticated;
grant select on storage.buckets to anon;
grant select on storage.buckets to authenticated;

-- Feedback attachments must stay path-scoped to the owner.
drop policy if exists "authenticated_user_upload" on storage.objects;
drop policy if exists "owner upload assets" on storage.objects;

create policy "owner upload assets"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'assets'
    and auth.uid()::text = (storage.foldername(name))[2]
  );

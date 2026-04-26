-- NEW-1: deck_cards had USING (true) — all builder deck contents were readable
-- by any unauthenticated caller who knew (or guessed) a deck UUID. Private
-- decks never shared were fully exposed.
--
-- NEW-3: Defensive revoke of the old get_my_decks(uuid) EXECUTE grant.
-- DROP FUNCTION removes the definition but not the ACL entry; this revoke
-- ensures the grant cannot be reactivated by a future function redefinition.

-- ── deck_cards SELECT policy ──────────────────────────────────────────────────

drop policy if exists "Public read deck_cards" on public.deck_cards;

create policy "Public read deck_cards"
  on public.deck_cards for select
  using (
    exists (
      select 1 from public.folders f
      where f.id = deck_cards.deck_id
        and (
          f.user_id = auth.uid()
          or public.safe_jsonb(f.description)->>'is_public' = 'true'
        )
    )
  );

-- ── Defensive revoke of old get_my_decks(uuid) grant ─────────────────────────

do $$ begin
  revoke execute on function get_my_decks(uuid) from authenticated;
exception when undefined_function then null; end $$;

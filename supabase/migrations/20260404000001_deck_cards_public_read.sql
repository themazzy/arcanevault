-- Allow unauthenticated users to read deck_cards and deck_cards_view.
-- Builder decks are publicly viewable by URL (no sharing token required),
-- so all deck_cards rows should be readable by anyone.

-- 1. Public read policy on the base table (security_invoker view needs this)
create policy "Public read deck_cards"
  on public.deck_cards for select
  using (true);

-- 2. Grant SELECT on the view to anon
grant select on public.deck_cards_view to anon;

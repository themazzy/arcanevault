-- Allow public read of deck folders used by shared/public deck URLs.
-- Deck metadata is required by /d/:id, and deck_cards are already public-readable.

create policy "Public read deck folders"
  on public.folders for select
  using (type in ('deck', 'builder_deck'));

grant select on public.folders to anon;

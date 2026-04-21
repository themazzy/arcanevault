-- Allow authenticated app clients to create/update shared card print metadata.
-- Deletes remain blocked; anon clients keep read-only access.

grant insert, update on public.card_prints to authenticated;

drop policy if exists "authenticated insert card_prints" on public.card_prints;
create policy "authenticated insert card_prints"
  on public.card_prints
  for insert
  to authenticated
  with check (true);

drop policy if exists "authenticated update card_prints" on public.card_prints;
create policy "authenticated update card_prints"
  on public.card_prints
  for update
  to authenticated
  using (true)
  with check (true);

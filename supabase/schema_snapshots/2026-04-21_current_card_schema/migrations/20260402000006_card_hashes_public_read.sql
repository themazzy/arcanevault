alter table public.card_hashes enable row level security;

drop policy if exists "public read card_hashes" on public.card_hashes;
create policy "public read card_hashes"
on public.card_hashes
for select
using (true);

grant select on public.card_hashes to authenticated, anon;

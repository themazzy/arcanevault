-- Deck-level action history (NOT per-card diffs): printing optimizations,
-- visibility toggles, bracket overrides, imports, commander/format changes, etc.
-- One small row per discrete action; capped at 100 rows per deck via trigger.
create table if not exists public.deck_changes (
  id         uuid primary key default gen_random_uuid(),
  deck_id    uuid not null references public.folders(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  action     text not null,
  detail     text,
  created_at timestamptz not null default now()
);

create index if not exists deck_changes_deck_id_created_idx
  on public.deck_changes (deck_id, created_at desc);

alter table public.deck_changes enable row level security;

create policy "users manage own deck changes"
  on public.deck_changes
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- New tables can inherit a default PUBLIC select grant; revoke so only the
-- authenticated owner (via RLS) ever reads this.
revoke all on public.deck_changes from anon, public;
grant select, insert, update, delete on public.deck_changes to authenticated;

-- Keep only the newest 100 entries per deck.
create or replace function public.prune_deck_changes()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  delete from public.deck_changes
  where deck_id = NEW.deck_id
    and id not in (
      select id from public.deck_changes
      where deck_id = NEW.deck_id
      order by created_at desc
      limit 100
    );
  return null;
end;
$function$;

drop trigger if exists trg_prune_deck_changes on public.deck_changes;
create trigger trg_prune_deck_changes
  after insert on public.deck_changes
  for each row execute function public.prune_deck_changes();

revoke execute on function public.prune_deck_changes() from public, anon, authenticated;

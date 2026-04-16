alter table public.game_results enable row level security;

drop policy if exists "Users read own game_results history" on public.game_results;
create policy "Users read own game_results history"
  on public.game_results for select
  using (auth.uid() = user_id);

drop policy if exists "Users insert own game_results history" on public.game_results;
create policy "Users insert own game_results history"
  on public.game_results for insert
  with check (
    auth.uid() = user_id
    or exists (
      select 1
      from public.tracked_games tg
      where tg.id = game_results.game_id
        and tg.host_user_id = auth.uid()
    )
  );

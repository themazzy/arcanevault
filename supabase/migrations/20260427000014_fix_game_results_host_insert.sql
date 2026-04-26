-- NEW-7: The "Users insert own game_results history" policy allows the session host
-- to insert a result row with any arbitrary user_id — including UUIDs that were never
-- in the session. This could be used to stuff fake win/loss records into other users'
-- history.
--
-- Fix: the host branch must also verify that the inserted user_id belongs to an actual
-- player in the same game session.

drop policy if exists "Users insert own game_results history" on public.game_results;

create policy "Users insert own game_results history"
  on public.game_results for insert
  with check (
    -- player inserts their own result
    auth.uid() = user_id
    or
    -- host inserts a result for a verified session participant
    exists (
      select 1
      from public.game_sessions gs
      join public.game_players gp
        on gp.session_id = gs.id
       and gp.user_id    = game_results.user_id
      where gs.id            = game_results.session_id
        and gs.host_user_id  = auth.uid()
    )
  );

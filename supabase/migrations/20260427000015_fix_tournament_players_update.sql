-- NEW-9: The "claim tournament slots" UPDATE policy has a USING clause but no
-- WITH CHECK clause. PostgreSQL reuses USING as WITH CHECK when the latter is
-- absent, but this still allows any user who satisfies USING (e.g. the current slot
-- owner) to set user_id to an arbitrary third-party UUID in the updated row.
--
-- Fix: add an explicit WITH CHECK that mirrors the USING expression, ensuring the
-- resulting row is either unclaimed or owned by the caller (host is exempt so they
-- can manage all slots).

drop policy if exists "claim tournament slots" on public.tournament_players;

create policy "claim tournament slots"
  on public.tournament_players for update
  using (
    (slot_kind = 'app' and (user_id is null or user_id = auth.uid()))
    or exists (
      select 1 from public.tournament_sessions s
      where s.id = session_id and s.host_user_id = auth.uid()
    )
  )
  with check (
    -- the resulting row must be unclaimed or owned by the caller, unless host
    (slot_kind = 'app' and (user_id is null or user_id = auth.uid()))
    or exists (
      select 1 from public.tournament_sessions s
      where s.id = session_id and s.host_user_id = auth.uid()
    )
  );

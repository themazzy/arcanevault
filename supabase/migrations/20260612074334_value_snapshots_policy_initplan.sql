-- The original policy used bare auth.uid(), which Postgres re-evaluates per
-- row (advisor lint 0003_auth_rls_initplan). Wrapping it in a sub-select
-- makes it an InitPlan evaluated once per query.
drop policy if exists "users manage own value snapshots" on public.collection_value_snapshots;

create policy "users manage own value snapshots"
  on public.collection_value_snapshots
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

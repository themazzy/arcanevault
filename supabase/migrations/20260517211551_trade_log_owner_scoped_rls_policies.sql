-- trade_log had RLS enabled but zero policies, so all client INSERT/SELECT
-- silently failed (caller catches the error). Trade Log tab has been showing
-- only pre-RLS rows since the policies were dropped. Restore owner-scoped
-- policies matching the rest of the schema.
drop policy if exists trade_log_select on public.trade_log;
create policy trade_log_select
on public.trade_log
for select
to authenticated
using (user_id = (select auth.uid()));

drop policy if exists trade_log_insert on public.trade_log;
create policy trade_log_insert
on public.trade_log
for insert
to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists trade_log_update on public.trade_log;
create policy trade_log_update
on public.trade_log
for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists trade_log_delete on public.trade_log;
create policy trade_log_delete
on public.trade_log
for delete
to authenticated
using (user_id = (select auth.uid()));;

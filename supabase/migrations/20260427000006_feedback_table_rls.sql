-- SEC-005 adjacent: the feedback table was created before the migration set
-- begins and its RLS state is not visible in any migration file. This migration
-- ensures RLS is enabled and applies the minimum required policies:
--   - any authenticated user can submit their own feedback (INSERT)
--   - anonymous users can also submit (the form supports unauthenticated users)
--   - no SELECT policy for non-admins (admin reads via service-role key only)

alter table public.feedback enable row level security;

-- drop any pre-existing permissive policies before creating scoped ones
drop policy if exists "allow_insert_feedback"   on public.feedback;
drop policy if exists "allow_select_feedback"   on public.feedback;
drop policy if exists "public insert feedback"  on public.feedback;
drop policy if exists "authenticated insert feedback" on public.feedback;

-- authenticated users can insert their own feedback rows
create policy "authenticated insert feedback"
  on public.feedback
  for insert
  to authenticated
  with check (auth.uid() = user_id);

-- anonymous users can also submit feedback (user_id will be null)
create policy "anon insert feedback"
  on public.feedback
  for insert
  to anon
  with check (user_id is null);

-- no SELECT policy: non-admin users cannot read feedback rows via the API.
-- admin access uses the service-role key which bypasses RLS entirely.

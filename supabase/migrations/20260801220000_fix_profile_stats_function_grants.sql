-- SECURITY FIX — privilege escalation via the default PUBLIC grant.
--
-- 20260801193000 tried to lock the refresh functions down with:
--   revoke execute on function ... from anon, authenticated;
-- which does NOTHING. Postgres grants EXECUTE to PUBLIC on every newly created
-- function, and anon/authenticated inherit that grant. Revoking from those roles
-- by name leaves the PUBLIC grant untouched.
--
-- Caught by the Supabase security advisor, then confirmed in the catalog: the
-- ACL read `{=X/postgres,postgres=X/postgres}` — that leading bare `=` IS the
-- PUBLIC grant, and has_function_privilege('anon', ..., 'EXECUTE') returned
-- true for all three.
--
-- Impact: an UNAUTHENTICATED caller could invoke refresh_all_profile_stats(), a
-- SECURITY DEFINER function that loops every user on the instance running a
-- 2-3s aggregate apiece. Repeat calls saturate CPU and I/O on a shared instance
-- whose whole working set already exceeds shared_buffers. That is a
-- compute-amplification denial of service. No data was exposed (the functions
-- return void and write only to profile_stats), so this is an availability
-- issue, not a confidentiality one.
--
-- The correct form is REVOKE ... FROM PUBLIC, then grant back explicitly.
-- record_daily_value_snapshots already had it right ({postgres=X/postgres});
-- copy that pattern for every SECURITY DEFINER function that is not meant to be
-- called from the client.
--
-- Verify after any change to a SECURITY DEFINER function:
--   select proname, proacl::text,
--          has_function_privilege('anon', oid, 'EXECUTE')
--   from pg_proc where proname = '...';
-- A bare `=X/...` entry in proacl means PUBLIC can execute it.

revoke execute on function public.refresh_profile_stats(uuid) from public, anon, authenticated;
revoke execute on function public.refresh_all_profile_stats() from public, anon, authenticated;
revoke execute on function public.refresh_my_profile_stats()  from public, anon, authenticated;

-- Only the owner-scoped entry point is reachable from the app, and only when
-- signed in. It re-checks auth.uid() internally and can only rebuild the
-- caller's own row. The pg_cron jobs run as `postgres`, which keeps EXECUTE as
-- the function owner, so the nightly sweep is unaffected.
grant execute on function public.refresh_my_profile_stats() to authenticated;

-- pgstattuple was installed into `public` while diagnosing the oracle_cards
-- bloat. Supabase keeps extensions in their own schema; leaving it in public
-- trips the extension_in_public advisor.
alter extension pgstattuple set schema extensions;

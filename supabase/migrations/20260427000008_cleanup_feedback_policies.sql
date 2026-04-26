-- The feedback table had a pre-existing permissive INSERT policy
-- "feedback submit public" applied to both anon and authenticated that
-- overrode the scoped policies added in migration 000006 (RLS policies
-- are OR'd — the least restrictive one wins). Drop it so the scoped
-- "anon insert feedback" and "authenticated insert feedback" actually apply.
--
-- Also drops one of two duplicate admin SELECT policies.

drop policy if exists "feedback submit public"       on public.feedback;
drop policy if exists "Admins can read all feedback" on public.feedback;

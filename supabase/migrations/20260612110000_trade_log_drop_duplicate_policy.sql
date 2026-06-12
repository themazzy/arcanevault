-- trade_log had two semantically identical permissive policy sets: the four
-- per-command trade_log_* policies (role: authenticated) and a blanket
-- "users manage own trades" FOR ALL (role: public). Postgres evaluates every
-- matching permissive policy on every query, so the duplicate just doubled
-- policy evaluation (flagged by the Supabase performance advisor). Keep the
-- per-command authenticated set; drop the blanket one.
drop policy if exists "users manage own trades" on public.trade_log;

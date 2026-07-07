-- Older projects may still apply broad default table privileges when a table
-- is created. Make oracle_cards explicitly read-only to browser roles; only the
-- service-role bulk sync may mutate this shared reference data.

revoke all privileges on table public.oracle_cards from public, anon, authenticated;

grant select on table public.oracle_cards to anon, authenticated;
grant select, insert, update, delete on table public.oracle_cards to service_role;

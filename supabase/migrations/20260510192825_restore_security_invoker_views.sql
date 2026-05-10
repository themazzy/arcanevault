-- Restore RLS-preserving view behavior after the Phase 5d view rebuilds.
-- CREATE VIEW defaults to SECURITY DEFINER semantics in Supabase's advisor
-- model unless security_invoker is explicitly set, so every recreate must
-- reapply this option.

alter view public.owned_cards_view set (security_invoker = true);
alter view public.deck_cards_view set (security_invoker = true);
alter view public.list_items_view set (security_invoker = true);
alter view public.deck_allocations_view set (security_invoker = true);

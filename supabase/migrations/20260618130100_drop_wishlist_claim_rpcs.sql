-- Phase 0 of the Trade Post work: retire the collaborative gift-wishlist
-- sharing (replaced by the per-user Trade Post). The /share/:token page no
-- longer renders list folders, so these RPCs are unused. list_items.claimed_by
-- / claimed_at columns are left in place (harmless) in case of rollback.
drop function if exists public.get_shared_wishlist(text);
drop function if exists public.toggle_wishlist_claim(text, uuid, boolean);
notify pgrst, 'reload schema';

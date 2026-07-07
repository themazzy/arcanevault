-- The og-deck edge function (rich Open Graph share previews) was removed:
-- deck share links now point directly at https://deckloom.app/d/<id> instead
-- of routing through *.supabase.co. This RPC existed solely to feed that
-- function deck metadata, so it goes with it.
drop function if exists public.get_deck_og_meta(uuid);

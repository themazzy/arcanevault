-- Now that scripts/backfill-card-prints.mjs has filled every existing row's
-- extended columns from Scryfall bulk data, clients no longer need to PATCH
-- card_prints to backfill missing fields. New inserts already carry all
-- extended fields. Drop the permissive update policy + identity-protection
-- trigger added in 20260515090918 so card_prints is insert-only for
-- authenticated users again.

drop trigger if exists card_prints_protect_identity on public.card_prints;
drop function if exists public.card_prints_protect_identity();

drop policy if exists "authenticated update card_prints" on public.card_prints;

revoke update on public.card_prints from authenticated;

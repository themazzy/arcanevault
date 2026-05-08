-- Phase 5d-prep — drop NOT NULL constraints on the about-to-be-dropped
-- denormalized columns (2026-05-08).
--
-- This migration is intentionally minimal and code-compatible: old code that
-- still includes `name` / `set_code` etc. in INSERT/UPSERT payloads keeps
-- working. New code that omits those columns also works (they default to
-- NULL). The follow-up `phase5d_finalize` migration drops the columns and
-- recreates the affected views without COALESCE.

alter table public.cards      alter column name     drop not null;
alter table public.cards      alter column set_code drop not null;
alter table public.deck_cards alter column name     drop not null;
alter table public.list_items alter column name     drop not null;

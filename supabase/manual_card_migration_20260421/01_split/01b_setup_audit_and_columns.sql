-- Chunk 01b: create audit table, enable RLS, add nullable card_print_id columns and indexes
-- Run after the previous 01 split chunk completes successfully.

-- Full card metadata and quantity migration.
-- This migration is intentionally idempotent. It preserves owned quantity by
-- summing duplicate buckets, moving legacy deck placements to deck_allocations,
-- and creating fallback "Unsorted" binder placements for unplaced copies.

create table if not exists public.card_schema_migration_audit (
  id          bigserial primary key,
  phase       text not null,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

alter table public.card_schema_migration_audit enable row level security;
revoke all on public.card_schema_migration_audit from anon, authenticated;

alter table public.card_prints
  alter column scryfall_id drop not null;

alter table public.cards
  add column if not exists card_print_id uuid references public.card_prints(id);

alter table public.deck_cards
  add column if not exists card_print_id uuid references public.card_prints(id);

alter table public.list_items
  add column if not exists card_print_id uuid references public.card_prints(id);


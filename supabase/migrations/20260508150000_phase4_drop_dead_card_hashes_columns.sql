-- Phase 4 — Drop dead card_hashes BIGINT columns (2026-05-08).
--
-- card_hashes carries both:
--   - phash_hex TEXT (64 hex chars)  ← what the client + seed script read
--   - hash_part_1..4 BIGINT          ← unused (BIGINT precision is lossy
--                                       across Supabase REST → JS Number)
--
-- Pre-flight verified all 104,523 rows have valid 64-char phash_hex.
-- The companion change in this migration:
--   scripts/generate-card-hashes.js no longer writes hash_part_*.
--   src/scanner/* never read them (CLAUDE.md doc: "Read phash_hex TEXT
--   exclusively. BigInt precision: Supabase BIGINT returned as JS Number
--   loses bits >53.").

alter table public.card_hashes
  drop column if exists hash_part_1,
  drop column if exists hash_part_2,
  drop column if exists hash_part_3,
  drop column if exists hash_part_4;

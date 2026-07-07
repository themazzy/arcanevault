-- Drop card_hashes (~75 MB, ~21% of the free-tier database).
--
-- Since the scanner hash pack (public/scanner/hashpack/, pipeline v7) the
-- table has no consumers: clients load the static pack, and the seed script
-- (scripts/generate-card-hashes.js) uses the pack itself as its incremental
-- state. The scanner's server footprint becomes zero.
--
-- ⚠ DO NOT APPLY until the v7 reseed has produced a verified pack and it is
-- committed + deployed — this table is the only other copy of the computed
-- hashes (recomputing from scratch costs a multi-hour seed run).

DROP TABLE IF EXISTS public.card_hashes;

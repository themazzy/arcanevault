-- Add oracle_text to the shared card_prints dictionary.
--
-- Oracle text was previously omitted from card_prints to stay under the
-- free-tier storage budget (it lived only in the Scryfall IDB cache). That left
-- a cold client cache unable to classify cards by rules text — the role-based
-- Build Assistant collapsed every spell into Synergy. card_prints is a shared,
-- deduplicated table (one row per printing for all users), so storing oracle
-- text here costs ~20-25 MB once (capped at 600 chars, the same cap the client
-- already applies) and fixes classification app-wide with no per-client fetch.
--
-- Additive + nullable: rows with NULL oracle_text fall back to the existing
-- Scryfall fetch path until the seed (scripts/backfill-oracle-text.mjs) fills
-- them. The column inherits card_prints' existing read grants/RLS.

ALTER TABLE public.card_prints ADD COLUMN IF NOT EXISTS oracle_text text;

-- PostgREST caches the schema; reload so the new column is selectable.
NOTIFY pgrst, 'reload schema';

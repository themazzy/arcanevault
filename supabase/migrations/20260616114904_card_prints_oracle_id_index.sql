-- Index oracle_id: the apply_card_oracle_text seed joins card_prints on
-- oracle_id, and without this each batched UPDATE seq-scans all ~119k rows
-- (which tripped statement_timeout mid-seed). Also useful for any future
-- "all printings of this card" lookups. Small, infrequently-written table.

CREATE INDEX IF NOT EXISTS idx_card_prints_oracle_id
  ON public.card_prints (oracle_id);

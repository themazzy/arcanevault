
DROP POLICY IF EXISTS "authenticated insert card_prints new only" ON card_prints;

CREATE POLICY "authenticated insert card_prints"
  ON card_prints
  FOR INSERT
  TO authenticated
  WITH CHECK (true);
;

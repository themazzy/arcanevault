-- The extended columns added in 20260515090918 blew past the free-tier 500 MB
-- storage budget once filled. Drop the four heaviest fields and fall back to
-- on-demand Scryfall fetches for deck-legality / oracle-text / hi-res images.
-- Kept: rarity, set_name, artist, power, toughness, produced_mana, keywords,
-- colors, card_faces — small fields that drive the filter bar.

alter table public.card_prints
  drop column if exists image_uri_small,
  drop column if exists image_uri_large,
  drop column if exists legalities,
  drop column if exists oracle_text;

-- VACUUM FULL must run separately (cannot run inside a transaction) — see
-- the post-migration step in scripts notes.

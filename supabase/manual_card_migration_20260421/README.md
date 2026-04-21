# Manual Card Migration Chunks

Run these in Supabase SQL Editor in numeric order. Stop if any chunk fails and report the error before running the next chunk.

1. 01_setup_and_card_print_backfill.sql
2. 02_merge_duplicate_owned_cards.sql
3. 03_legacy_deck_and_quantity_repair.sql
4. 04_dedupe_constraints_and_views.sql

After all four chunks succeed, run ../verify_post_migration.sql.

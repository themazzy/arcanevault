# Chunk 01 Micro-Split

Run in order. If 01a fails with "Failed to fetch", the problem is Supabase SQL Editor/network/browser, not this migration SQL.

1. 01a_connection_test.sql
2. 01b_setup_audit_and_columns.sql
3. 01c_backfill_scryfall_prints.sql
4. 01d_backfill_set_collector_prints.sql
5. 01e_backfill_name_only_prints.sql
6. 01f_assign_by_scryfall_id.sql
7. 01g_assign_by_set_collector.sql
8. 01h_assign_by_name_and_validate.sql

Then continue with ../02_merge_duplicate_owned_cards.sql, ../03_legacy_deck_and_quantity_repair.sql, ../04_dedupe_constraints_and_views.sql.

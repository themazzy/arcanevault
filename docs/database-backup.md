# Database backup and restore

The Supabase free plan keeps no backups. `.github/workflows/db-backup.yml` dumps the database every night at 02:40 UTC and stores it as an encrypted workflow artifact for 90 days.

## What is in a backup

- `roles.sql`, `schema.sql` and `data.sql` from `supabase db dump`. These cover tables, RLS policies, functions, triggers and `auth.users`.
- **Not included as data:**
  - `card_prices`, `card_price_moves` and `oracle_cards` (the sync workflows rebuild them from Scryfall)
  - Storage objects in the `assets` bucket (feedback screenshots and uploaded art)
  - Edge functions, which live in `supabase/functions/`
  - Auth provider and SMTP settings

## Setup (once)

Add two repository secrets under Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `SUPABASE_DB_URL` | The **Session pooler** connection string from Supabase → Connect, with the database password filled in. GitHub runners have no IPv6, so the direct connection string fails. |
| `BACKUP_PASSPHRASE` | A long random passphrase of at least 20 characters. Keep a copy outside GitHub, in a password manager: without it no backup can be opened. |

The repo is public, so anyone signed in to GitHub can download the artifacts. The encryption is what keeps them private.

## Restoring

1. Download the artifact for the date you want from the **Database Backup** workflow run in the Actions tab.
2. Decrypt and unpack it:

   ```bash
   unzip deckloom-db-YYYY-MM-DD.zip
   gpg -d deckloom-db-YYYY-MM-DD.tar.gz.gpg | tar -xz
   ```

3. Load it into an **empty** Supabase project, using that project's session-pooler URL:

   ```bash
   psql --single-transaction --variable ON_ERROR_STOP=1 \
     --file roles.sql --file schema.sql \
     --command 'SET session_replication_role = replica' \
     --file data.sql \
     --dbname "$NEW_DB_URL"
   ```

   If `roles.sql` fails on `cli_login_postgres` or `supabase_admin`, follow the troubleshooting notes in [Supabase's backup and restore guide](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).

4. Run the **Sync Oracle Card Data**, **Sync Card Prices** and **Sync Price History** workflows to refill the tables whose data was left out.
5. Redeploy the edge functions and set their secrets again. Then re-enable realtime publications on the lobby tables, and point the app's `VITE_SUPABASE_*` values at the new project.

Restoring over the live project is not the intended path. To recover single rows, restore into a scratch project and copy the rows across.

# Security Update Plan

Based on audit findings from 2026-04-26. Grouped into three phases by risk level.

---

## Phase 1 — High Priority (P0 / P1)

These are exploitable right now by any authenticated or anonymous user. Fix before next deploy.

---

### 1.1 Fix `get_my_decks` — add auth ownership check [SEC-001]

**File:** new migration `supabase/migrations/20260427000001_fix_get_my_decks_auth.sql`

The function accepts a caller-supplied `p_user_id` with no check that it matches `auth.uid()`. Any logged-in user can read another user's full private deck list.

**Fix:** Rewrite the function to use `auth.uid()` internally and remove the parameter entirely. This eliminates the class of bug rather than just adding a guard.

```sql
drop function if exists get_my_decks(uuid);

create or replace function get_my_decks()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;
  -- ... rest of body using v_user_id instead of p_user_id ...
end;
$$;

grant execute on function get_my_decks() to authenticated;
-- do NOT grant to anon
```

**Client change:** `src/pages/Builder.jsx` line ~241 — remove `{ p_user_id: user.id }` argument from the `sb.rpc('get_my_decks', ...)` call.

---

### 1.2 Remove `user_id` from `get_public_profile` response; gate value fields on profile config [SEC-002]

**File:** new migration `supabase/migrations/20260427000002_fix_get_public_profile_exposure.sql`

The RPC returns the raw `user_id` UUID and always includes `collection_value` + `top_card` regardless of the user's bento block config. The UUID enables the SEC-001 attack chain from unauthenticated callers.

**Fix:**
- Remove `user_id` from the returned JSON.
- Only include `collection_value` when the `value` block is present in `profile_config.blocks`.
- Only include `top_card` when the `top_card` block is present in `profile_config.blocks`.
- Any follow-up RPC calls that currently take `user_id` as input (`get_public_decks`) should be rewritten to accept `p_username text` and resolve the ID internally, keeping the UUID server-side.

---

### 1.3 Lock down `card_prints` write policies [SEC-003]

**File:** new migration `supabase/migrations/20260427000003_fix_card_prints_rls.sql`

Any authenticated user can UPDATE any row in `card_prints`, replacing image URIs with attacker-controlled URLs that load for all users.

**Fix:**
```sql
-- Remove the permissive update policy
drop policy if exists "authenticated update card_prints" on public.card_prints;
revoke update on public.card_prints from authenticated;

-- Scope insert to new scryfall_ids only (no overwrite)
drop policy if exists "authenticated insert card_prints" on public.card_prints;
create policy "authenticated insert card_prints new only"
  on public.card_prints for insert to authenticated
  with check (
    not exists (
      select 1 from public.card_prints cp
      where cp.scryfall_id = new.scryfall_id
    )
  );
```

No client changes needed — the app only inserts new card prints, never updates them.

---

### 1.4 Fix `feedback_attachments` read, insert, and storage policies [SEC-004, SEC-007, SEC-008]

**File:** new migration `supabase/migrations/20260427000004_fix_feedback_attachments_rls.sql`

Three separate issues in the same migration:
- SELECT policy uses `USING (true)` — all attachment metadata is world-readable.
- INSERT policy has `OR auth.uid() IS NULL` — unauthenticated callers can insert rows.
- Storage DELETE policy uses `auth.uid() IS NOT NULL` without path ownership — any authenticated user can delete any other user's file.

**Fix:**
```sql
-- feedback_attachments table

drop policy if exists "public_read_attachments" on public.feedback_attachments;
create policy "owner read attachments"
  on public.feedback_attachments for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "authenticated_user_insert" on public.feedback_attachments;
create policy "authenticated insert attachments"
  on public.feedback_attachments for insert to authenticated
  with check (auth.uid() is not null and auth.uid() = user_id);

-- storage.objects (assets bucket)

drop policy if exists "public_read_assets" on storage.objects;
create policy "owner read assets"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'assets'
    and auth.uid()::text = (storage.foldername(name))[2]
  );

drop policy if exists "user_delete_own_files" on storage.objects;
create policy "owner delete assets"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'assets'
    and auth.uid()::text = (storage.foldername(name))[2]
  );
```

---

## Phase 2 — Medium Priority (P2)

Real issues but require specific conditions or an already-authenticated attacker to trigger.

---

### 2.1 Guard `get_community_decks` against malformed `description` fields [SEC-005]

**File:** new migration `supabase/migrations/20260427000005_fix_community_decks_safe_jsonb.sql`

Direct `f.description::jsonb` cast throws an exception and returns HTTP 500 for all callers if any public folder has a non-JSON description string. One authenticated user can trigger this permanently.

**Fix:** Redefine `get_community_decks` replacing all `f.description::jsonb` casts with `public.safe_jsonb(f.description)`. Apply the same fix to `get_public_decks` in the same migration, which has the identical vulnerability.

Verify the final active definition of both functions uses `safe_jsonb` throughout (check that no later migration re-introduces a raw cast).

---

### 2.2 Strip internal sync state from `get_my_decks` response [SEC-006]

**Covered by migration in 1.1** — when rewriting `get_my_decks`, build the output JSON explicitly rather than returning the raw `description` string. Expose only these fields from the description blob:

- `is_public`
- `format`
- `commanderName`
- `commanderScryfallId`
- `commanderColorIdentity`
- `coverArtUri`
- `linked_deck_id`
- `linked_builder_id`

Exclude: `sync_state`, `last_sync_at`, `last_sync_snapshot`, `unsynced_builder`, `unsynced_collection`.

---

### 2.3 Verify RLS on `feedback` table [SEC-005 adjacent]

The `feedback` table is not visible in any migration. Confirm via the Supabase dashboard:
- RLS is **enabled** on the table.
- There is an authenticated INSERT policy scoped to `auth.uid() = user_id`.
- There is **no** SELECT policy granting reads to `authenticated` or `anon` (admin access only).

If RLS is off or policies are missing, add them in a new migration:
```sql
alter table public.feedback enable row level security;

create policy "authenticated insert feedback"
  on public.feedback for insert to authenticated
  with check (auth.uid() = user_id);
-- no select policy for non-admins
```

---

### 2.4 Add LIMIT clauses to aggregating RPCs [hardening]

**File:** include in relevant Phase 1 and Phase 2 migrations, or a dedicated migration.

All aggregating `security definer` functions (`get_community_decks`, `get_public_decks`, `get_my_decks`) have no row cap. A user with thousands of decks can cause them to time out, returning HTTP 500 for all callers.

**Fix:** Add explicit limits inside each function, e.g.:
- `get_community_decks`: `LIMIT 100` on the folder query
- `get_my_decks`: `LIMIT 200` on the folder query
- `get_public_decks`: `LIMIT 50` on the deck query

---

### 2.5 Audit `folders` table effective anon permissions [hardening]

Migration `20260404000002` issues `GRANT SELECT ON public.folders TO anon`. Migration `20260426000003` updates the RLS policy but does not issue a `REVOKE`. Confirm in the Supabase dashboard that the effective combined result matches intent:
- `anon` can only SELECT folders where `type = 'builder_deck' AND is_public = true` (or equivalent via the RLS policy).
- `anon` cannot SELECT binder, list, or deck folders belonging to any user.

If the effective grant is broader, add `REVOKE SELECT ON public.folders FROM anon` and re-apply only the minimum needed via RLS.

---

## Phase 3 — Low Priority (P3)

Lower exploitability or blast radius — schedule alongside regular development.

---

### 3.1 Revoke `anon` grant on `get_user_nickname` [SEC-009] ✅ DONE

**File:** `supabase/migrations/20260427000007_fix_get_user_nickname_grant.sql`

The function is granted to `anon`, enabling unauthenticated account-existence checks for any UUID. Combined with `get_public_profile` returning `user_id`, this creates a bidirectional enumeration oracle.

```sql
revoke execute on function get_user_nickname(uuid) from anon;
-- keep: grant execute on function get_user_nickname(uuid) to authenticated;
```

No client changes — all calls to `get_user_nickname` in `Builder.jsx` and `DeckView.jsx` are made by authenticated sessions.

---

### 3.2 Add authentication to `combo-proxy` edge function [SEC-010] ✅ DONE

**Files changed:** `supabase/functions/combo-proxy/index.ts`, `src/pages/DeckBuilder.jsx`

Added JWT verification via `createClient` + `auth.getUser()` (same pattern as admin functions), 50 KB body size limit, and JSON parse validation before forwarding. Client updated to send `session.access_token` instead of the anon key.

---

### 3.3 Move Pokemon TCG API calls to an edge function [SEC-011] ⏭ SKIPPED

Pokemon TCG feature is being moved to a separate project. SEC-011 will be resolved by the migration itself.

---

### 3.4 Add Content Security Policy headers [hardening] ⚠ KNOWN LIMITATION

GitHub Pages does not support custom response headers. CSP cannot be enforced without a reverse proxy in front. Options:
- Add Cloudflare (free tier) in front of the GitHub Pages URL and set CSP headers there.
- Accept as a known residual risk for the current deployment model.

No code change possible without infrastructure change.

Suggested CSP baseline:
```
Content-Security-Policy:
  default-src 'self';
  img-src 'self' https://cards.scryfall.io https://c1.scryfall.com https://api.scryfall.com data: blob:;
  connect-src 'self' https://*.supabase.co https://api.scryfall.com https://api.frankfurter.app https://backend.commanderspellbook.com;
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  frame-ancestors 'none';
```

---

## Verification Checklist

After each phase, run these checks before deploying:

**Phase 1:**
- [ ] Authenticated user cannot call `get_my_decks` with a different user's UUID
- [ ] `get_public_profile` response contains no `user_id` field
- [ ] `get_public_profile` omits `collection_value`/`top_card` when blocks are disabled
- [ ] Authenticated user cannot UPDATE a `card_prints` row
- [ ] Unauthenticated caller gets 0 rows from `feedback_attachments`
- [ ] Unauthenticated caller gets 403 downloading a file from the `assets` bucket
- [ ] User A cannot delete a file uploaded by user B

**Phase 2:**
- [ ] Inserting a folder with non-JSON description and calling `get_community_decks` returns valid JSON, not HTTP 500
- [ ] `get_my_decks` response contains no `sync_state` or `last_sync_snapshot` fields
- [ ] RLS is confirmed enabled on `feedback` table in Supabase dashboard
- [ ] Anon cannot SELECT non-public folders from the `folders` table

**Phase 3:**
- [ ] Unauthenticated call to `get_user_nickname` returns 401 or empty
- [ ] Unauthenticated call to `combo-proxy` returns 401
- [ ] Production JS bundle (`dist/`) contains no Pokemon TCG API key string

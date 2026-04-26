-- SEC-004: feedback_attachments SELECT used USING (true) — all attachment rows
-- (including user_email and file_key) were world-readable by unauthenticated callers.
--
-- SEC-007: INSERT policy had OR auth.uid() IS NULL, allowing unauthenticated inserts.
--
-- SEC-008: storage DELETE policy used auth.uid() IS NOT NULL without path ownership,
-- letting any authenticated user delete any other user's files.
-- storage SELECT policy made the entire assets bucket publicly readable.
--
-- Fix: scope all policies to the owning user via path-based ownership.

-- ── feedback_attachments table ────────────────────────────────────────────────

-- drop the permissive policies
drop policy if exists "public_read_attachments"   on public.feedback_attachments;
drop policy if exists "authenticated_user_insert"  on public.feedback_attachments;

-- owners can read their own attachments; admins access via service role
create policy "owner read attachments"
  on public.feedback_attachments
  for select
  to authenticated
  using (auth.uid() = user_id);

-- only authenticated users can insert, and only for their own user_id
create policy "authenticated insert attachments"
  on public.feedback_attachments
  for insert
  to authenticated
  with check (auth.uid() is not null and auth.uid() = user_id);

-- ── storage.objects (assets bucket) ──────────────────────────────────────────
-- Path structure is: feedback/<user_id>/<filename>
-- storage.foldername(name) returns an array of path segments, so [2] is the user_id segment.

drop policy if exists "public_read_assets"    on storage.objects;
drop policy if exists "user_delete_own_files" on storage.objects;

-- authenticated users can only read their own files
create policy "owner read assets"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'assets'
    and auth.uid()::text = (storage.foldername(name))[2]
  );

-- authenticated users can only delete their own files
create policy "owner delete assets"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'assets'
    and auth.uid()::text = (storage.foldername(name))[2]
  );

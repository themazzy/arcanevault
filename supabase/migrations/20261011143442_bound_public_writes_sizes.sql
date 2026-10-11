-- Size limits for the public write paths. Rationale and measurements: see
-- 20261011143421_bound_public_writes.sql.

-- ── Size limits ─────────────────────────────────────────────────────────────

-- feedback: empty when written.
alter table public.feedback
  add constraint feedback_size_check check (
        char_length(description) <= 10000
    and (contact    is null or char_length(contact)    <= 320)
    and (user_email is null or char_length(user_email) <= 320)
    and (device_info is null or pg_column_size(device_info) <= 16384)
  );

-- account_deletion_requests: largest row 638 B.
alter table public.account_deletion_requests
  add constraint account_deletion_requests_size_check check (
        (user_email     is null or char_length(user_email)     <= 320)
    and (request_reason is null or char_length(request_reason) <= 4000)
    and (request_meta   is null or pg_column_size(request_meta) <= 16384)
  );

-- trade_proposals: empty when written. 200 entries a side is far beyond any
-- real trade; each entry is a small {name, qty, ...} object.
alter table public.trade_proposals
  add constraint trade_proposals_size_check check (
        (note is null or char_length(note) <= 2000)
    and jsonb_typeof(requested) = 'array' and jsonb_array_length(requested) <= 200
    and jsonb_typeof(offered)   = 'array' and jsonb_array_length(offered)   <= 200
    and pg_column_size(requested) + pg_column_size(offered) <= 131072
  );

-- folders: name max 55, description max 51,838 (a builder deck's sync
-- snapshot lives in it, so it scales with deck size — hence 1 MB).
alter table public.folders
  add constraint folders_size_check check (
        char_length(name) <= 200
    and (description is null or char_length(description) <= 1000000)
  ) not valid;

-- user_settings: nickname max 20, bio 300, largest jsonb 2.1 KB, row 3.6 KB.
alter table public.user_settings
  add constraint user_settings_size_check check (
        (nickname       is null or char_length(nickname)       <= 64)
    and (profile_bio    is null or char_length(profile_bio)    <= 2000)
    and (profile_accent is null or char_length(profile_accent) <= 64)
    and (profile_config     is null or pg_column_size(profile_config)     <= 65536)
    and (page_tips_seen     is null or pg_column_size(page_tips_seen)     <= 65536)
    and (archive_background is null or pg_column_size(archive_background) <= 65536)
    and (trade_wants        is null or pg_column_size(trade_wants)        <= 65536)
  );

-- card_prints: name max 141, type_line 91, oracle_text 600 (capped by both
-- writers), card_faces 1.7 KB, set_name 54, artist 50.
--
-- Image URLs must point at Scryfall's CDN *for this row's scryfall_id*, or at
-- Scryfall's "coming soon" placeholder (9 real rows carry it). That is what
-- stops an inserted row from displaying an arbitrary image to other users.
create or replace function private.card_faces_images_ok(faces jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select faces is null
      or jsonb_typeof(faces) <> 'array'
      or not exists (
        select 1
        from jsonb_array_elements(faces) f,
             jsonb_each_text(case when jsonb_typeof(f -> 'image_uris') = 'object' then f -> 'image_uris' else '{}'::jsonb end) u
        where u.value is not null
          and u.value !~ '^https://(cards\.scryfall\.io|errors\.scryfall\.com)/'
      );
$$;

alter table public.card_prints
  add constraint card_prints_shape_check check (
        (scryfall_id is null or scryfall_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    and (image_uri is null
         or image_uri ~ '^https://errors\.scryfall\.com/'
         or (image_uri like 'https://cards.scryfall.io/%' and strpos(image_uri, scryfall_id) > 0))
    and (art_crop_uri is null
         or art_crop_uri ~ '^https://errors\.scryfall\.com/'
         or (art_crop_uri like 'https://cards.scryfall.io/%' and strpos(art_crop_uri, scryfall_id) > 0))
    and private.card_faces_images_ok(card_faces)
    and (card_faces is null or pg_column_size(card_faces) <= 32768)
    and char_length(name) <= 400
    and (type_line   is null or char_length(type_line)   <= 400)
    and (oracle_text is null or char_length(oracle_text) <= 4000)
    and (mana_cost   is null or char_length(mana_cost)   <= 200)
    and (set_name    is null or char_length(set_name)    <= 200)
    and (artist      is null or char_length(artist)      <= 400)
    and (set_code    is null or char_length(set_code)    <= 16)
    and (collector_number is null or char_length(collector_number) <= 32)
  ) not valid;
-- NOT VALID: checking 124k existing rows here would hold an ACCESS EXCLUSIVE
-- lock on the catalogue for the whole scan, blocking every card read in the
-- app. The existing rows were verified against these exact predicates before
-- this was written (0 violations). Both NOT VALID constraints were then
-- validated on 2026-10-11 with `alter table ... validate constraint`, which
-- takes a lock that does not block reads or writes.

-- ── Storage ─────────────────────────────────────────────────────────────────

-- The only uploader is FeedbackModal (screenshots, client cap 8 MB,
-- accept="image/*"). 5 objects existed when this was written, largest 178 KB.
update storage.buckets
set file_size_limit = 8388608,
    allowed_mime_types = array['image/*']
where id = 'assets';

-- At most 20 files per account in the bucket, at 8 MB each.
alter policy "owner upload assets" on storage.objects
  with check (
    bucket_id = 'assets'
    and (select auth.uid())::text = (storage.foldername(name))[2]
    and (
      select count(*) from storage.objects o
      where o.bucket_id = 'assets'
        and (storage.foldername(o.name))[2] = (select auth.uid())::text
    ) < 20
  );

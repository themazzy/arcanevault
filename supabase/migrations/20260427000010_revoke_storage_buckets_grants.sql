-- NEW-4: storage.buckets had INSERT/UPDATE/DELETE granted to anon and authenticated.
-- Application code never creates or modifies buckets at runtime — that is an admin
-- operation. Revoking prevents a malicious authenticated user from creating rogue
-- buckets or altering bucket policies (e.g. making a private bucket public).

revoke insert, update, delete on storage.buckets from anon;
revoke insert, update, delete on storage.buckets from authenticated;

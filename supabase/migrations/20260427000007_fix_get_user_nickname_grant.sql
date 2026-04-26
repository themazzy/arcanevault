-- SEC-009: get_user_nickname was granted to anon, enabling unauthenticated
-- account-existence checks for any UUID. Combined with get_public_profile
-- returning user_id (now fixed), this created a bidirectional enumeration
-- oracle. No client call to this function is made from an unauthenticated
-- context — all callers in Builder.jsx and DeckView.jsx are authenticated.

revoke execute on function get_user_nickname(uuid) from anon;
-- authenticated grant remains in place

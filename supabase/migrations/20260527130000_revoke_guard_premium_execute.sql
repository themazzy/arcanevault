-- guard_user_settings_premium() is a TRIGGER function attached to user_settings
-- — it's never meant to be called via the Data API. The default grant chain
-- left it executable as an RPC by both anon and authenticated, which the
-- security advisor flagged (lint 0028/0029). Revoke EXECUTE so /rest/v1/rpc/
-- can no longer reach it. The trigger itself runs under the table owner and
-- is unaffected by these grants.
revoke execute on function public.guard_user_settings_premium() from public;
revoke execute on function public.guard_user_settings_premium() from anon;
revoke execute on function public.guard_user_settings_premium() from authenticated;

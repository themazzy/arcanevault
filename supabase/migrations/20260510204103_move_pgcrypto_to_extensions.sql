-- Keep extensions out of the exposed public schema. The only app-owned
-- dependency on pgcrypto is shared_folders.public_token.

create schema if not exists extensions;

alter extension pgcrypto set schema extensions;

grant usage on schema extensions to anon, authenticated, service_role;

alter table public.shared_folders
  alter column public_token set default encode(extensions.gen_random_bytes(16), 'hex');

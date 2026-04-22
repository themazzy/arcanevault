-- Reduce broad policies flagged by Supabase Security Advisor while preserving
-- public card metadata reads and public feedback submission.

alter table if exists public.feedback_attachments
  alter column id set default gen_random_uuid();

drop extension if exists "uuid-ossp";

drop policy if exists "authenticated insert card_prints" on public.card_prints;
create policy "authenticated insert card_prints"
  on public.card_prints
  for insert
  to authenticated
  with check (
    nullif(btrim(name), '') is not null
  );

drop policy if exists "authenticated update card_prints" on public.card_prints;
create policy "authenticated update card_prints"
  on public.card_prints
  for update
  to authenticated
  using (
    nullif(btrim(name), '') is not null
  )
  with check (
    nullif(btrim(name), '') is not null
  );

do $$
declare
  policy_name text;
begin
  for policy_name in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'feedback'
      and cmd in ('SELECT', 'INSERT')
  loop
    execute format('drop policy if exists %I on public.feedback', policy_name);
  end loop;
end;
$$;

create policy "feedback submit public"
  on public.feedback
  for insert
  to anon, authenticated
  with check (
    type in ('bug', 'feature')
    and nullif(btrim(description), '') is not null
    and (
      user_id is null
      or user_id = auth.uid()
    )
  );

create policy "feedback owner select"
  on public.feedback
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "feedback admin select"
  on public.feedback
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.admin_users a
      where a.user_id = auth.uid()
        and a.active = true
    )
  );

drop policy if exists public_read_attachments on public.feedback_attachments;
drop policy if exists authenticated_user_insert on public.feedback_attachments;

create policy "feedback attachments insert own"
  on public.feedback_attachments
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.feedback f
      where f.id = feedback_id
        and f.user_id = auth.uid()
    )
  );

create policy "feedback attachments owner select"
  on public.feedback_attachments
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "feedback attachments admin select"
  on public.feedback_attachments
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.admin_users a
      where a.user_id = auth.uid()
        and a.active = true
    )
  );

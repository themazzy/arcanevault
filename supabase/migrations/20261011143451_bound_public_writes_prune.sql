-- Counters older than a week answer nothing. Same shape as the other prune
-- jobs (prune_deck_view_daily): a function, scheduled after the 04:xx jobs.
create or replace function private.prune_write_quota()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from private.write_quota where day < current_date - 7;
$$;
revoke all on function private.prune_write_quota() from public, anon, authenticated;

select cron.schedule('daily-write-quota-prune', '10 5 * * *', 'select private.prune_write_quota()');

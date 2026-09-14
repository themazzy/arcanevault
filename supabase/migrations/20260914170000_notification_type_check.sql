-- Let the two new notification types past the table's own CHECK constraint.
--
-- `announcement` and `price_alert` were added to the RLS insert policy and to
-- the client, but `notifications_type_check` enumerates the allowed types
-- independently — so every write failed with a 400 and
-- "violates check constraint notifications_type_check". The watchers swallow
-- errors by design, so the symptom was simply no notifications, ever, with
-- nothing in the UI to say why.
--
-- The lesson worth keeping: widening an RLS policy is not the same as widening
-- what the table accepts. A type column with a CHECK has two gates.

alter table public.notifications drop constraint if exists notifications_type_check;

alter table public.notifications
  add constraint notifications_type_check check (type = any (array[
    'like',
    'comment',
    'follow',
    'trade_proposal',
    'trade_response',
    'milestone',
    'announcement',
    'price_alert'
  ]));

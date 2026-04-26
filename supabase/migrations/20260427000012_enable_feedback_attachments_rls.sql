-- NEW-6: feedback_attachments had RLS policies defined in migration 000004 but RLS
-- was never explicitly enabled on the table, so the policies had no effect and every
-- row was readable/writable by anyone. Enable RLS so the owner-scoped policies apply.

alter table public.feedback_attachments enable row level security;

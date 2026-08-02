-- Trade proposal lifecycle: separate "we agreed to trade" from "the trade happened".
--
-- Accepting a proposal is a scheduling signal only — it never touches inventory.
-- A separate completion step records that the cards physically changed hands, and
-- each party then settles their OWN collection through the existing commit_trade
-- flow. Settlement is per-user by design:
--   * the `offered` side is free-text card names, so we cannot resolve the
--     proposer's inventory correctly even in principle;
--   * `cards` is RLS owner-only — one user's action must never write another
--     user's rows.
-- So `status` is the shared truth ("did this trade happen"), while
-- owner_settled / proposer_settled are private per-side bookkeeping that stop a
-- user from applying the same trade to their collection twice.

alter table public.trade_proposals drop constraint if exists trade_proposals_status_check;
alter table public.trade_proposals add constraint trade_proposals_status_check
  check (status = any (array['pending','accepted','declined','cancelled','completed']));

alter table public.trade_proposals
  add column if not exists owner_settled    boolean not null default false,
  add column if not exists proposer_settled boolean not null default false,
  add column if not exists completed_at     timestamptz;

-- Responses and completions notify the counterpart.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type = any (array['like','comment','follow','trade_proposal','milestone','trade_response']));

-- ── Inbox: both directions ───────────────────────────────────────────────────
-- Returns { incoming: [...], outgoing: [...] }. `requested`/`offered` stay in
-- proposer-relative terms (requested = what the proposer asked the owner for);
-- callers derive give/receive from is_owner so there is one mapping, used by
-- both the inbox UI and the Compare-tab prefill.
create or replace function public.get_trade_proposals()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_in  jsonb;
  v_out jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('incoming', '[]'::jsonb, 'outgoing', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id',              tp.id,
           'is_owner',        true,
           'counterpart',     us.nickname,
           'requested',       tp.requested,
           'offered',         tp.offered,
           'note',            tp.note,
           'status',          tp.status,
           'my_settled',      tp.owner_settled,
           'their_settled',   tp.proposer_settled,
           'created_at',      tp.created_at,
           'completed_at',    tp.completed_at
         ) order by tp.created_at desc), '[]'::jsonb)
    into v_in
  from trade_proposals tp
  left join user_settings us on us.user_id = tp.proposer_id
  where tp.owner_id = v_uid;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id',              tp.id,
           'is_owner',        false,
           'counterpart',     us.nickname,
           'requested',       tp.requested,
           'offered',         tp.offered,
           'note',            tp.note,
           'status',          tp.status,
           'my_settled',      tp.proposer_settled,
           'their_settled',   tp.owner_settled,
           'created_at',      tp.created_at,
           'completed_at',    tp.completed_at
         ) order by tp.created_at desc), '[]'::jsonb)
    into v_out
  from trade_proposals tp
  left join user_settings us on us.user_id = tp.owner_id
  where tp.proposer_id = v_uid;

  return jsonb_build_object('incoming', v_in, 'outgoing', v_out);
end;
$function$;

-- ── Owner responds (accept / decline) — notifies the proposer ────────────────
create or replace function public.respond_to_trade_proposal(p_id uuid, p_status text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid      uuid := auth.uid();
  v_proposer uuid;
begin
  if v_uid is null then
    raise exception 'Sign in to respond.';
  end if;
  if p_status not in ('accepted','declined') then
    raise exception 'Invalid status.';
  end if;

  update trade_proposals
    set status = p_status, updated_at = now()
  where id = p_id and owner_id = v_uid and status = 'pending'
  returning proposer_id into v_proposer;

  if v_proposer is null then
    raise exception 'Proposal not found or already resolved.';
  end if;

  -- Without this the proposer never learns the outcome.
  insert into notifications (user_id, actor_id, type)
  values (v_proposer, v_uid, 'trade_response');
end;
$function$;

-- ── Either party confirms the physical trade happened ────────────────────────
-- Only moves the proposal to 'completed'. No card ever moves here.
create or replace function public.complete_trade_proposal(p_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid   uuid := auth.uid();
  v_other uuid;
begin
  if v_uid is null then
    raise exception 'Sign in to confirm a trade.';
  end if;

  update trade_proposals
    set status = 'completed', completed_at = now(), updated_at = now()
  where id = p_id
    and status = 'accepted'
    and (owner_id = v_uid or proposer_id = v_uid)
  returning case when owner_id = v_uid then proposer_id else owner_id end into v_other;

  if v_other is null then
    raise exception 'Proposal not found, or it has not been accepted yet.';
  end if;

  insert into notifications (user_id, actor_id, type)
  values (v_other, v_uid, 'trade_response');
end;
$function$;

-- ── Caller records that THEY have applied this trade to their own collection ──
create or replace function public.mark_trade_settled(p_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_ok  boolean;
begin
  if v_uid is null then
    raise exception 'Sign in to update a trade.';
  end if;

  update trade_proposals
    set owner_settled    = case when owner_id    = v_uid then true else owner_settled    end,
        proposer_settled = case when proposer_id = v_uid then true else proposer_settled end,
        updated_at       = now()
  where id = p_id
    and status = 'completed'
    and (owner_id = v_uid or proposer_id = v_uid)
  returning true into v_ok;

  if not coalesce(v_ok, false) then
    raise exception 'Proposal not found, or it is not marked as traded yet.';
  end if;
end;
$function$;

-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, and revoking from
-- anon/authenticated does NOT undo that — the grant has to come off PUBLIC or
-- these stay world-callable. Every one of them already refuses a null auth.uid(),
-- so this is defence in depth rather than a fix for a live hole.
revoke execute on function public.get_trade_proposals()                 from public;
revoke execute on function public.respond_to_trade_proposal(uuid, text) from public;
revoke execute on function public.complete_trade_proposal(uuid)         from public;
revoke execute on function public.mark_trade_settled(uuid)              from public;

grant execute on function public.get_trade_proposals()                 to authenticated;
grant execute on function public.respond_to_trade_proposal(uuid, text) to authenticated;
grant execute on function public.complete_trade_proposal(uuid)         to authenticated;
grant execute on function public.mark_trade_settled(uuid)              to authenticated;

notify pgrst, 'reload schema';

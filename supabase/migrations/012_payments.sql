-- WANT payments (Stripe Connect, separate charges & transfers)
-- Apply once in the Supabase SQL Editor, after 011_categories.sql. Safe to re-run.
--
-- Flow (only when payments are switched on in app_config):
--   accept offer -> buyer pays (Stripe Checkout) -> money HELD by WANT
--   -> provider can start -> provider marks done -> buyer "Confirm & release"
--   -> transfer to provider minus WANT's fee.
--   Buyer can "Cancel & refund" until the provider starts the job.
--
-- Payments start SWITCHED OFF, so applying this changes nothing until you run:
--   update public.app_config set payments_enabled = true;
--
-- Money moves only in Edge Functions (server side, Stripe secret key never
-- reaches the browser). Clients can READ their own payments; they can never
-- write them. The internal_* functions below can only be called with the
-- service role key (used by the Edge Functions).

-- 1. Settings
create table if not exists public.app_config (
  id boolean primary key default true check (id),
  payments_enabled boolean not null default false,
  fee_percent numeric(5,2) not null default 10 check (fee_percent >= 0 and fee_percent < 50),
  currency text not null default 'usd'
);
insert into public.app_config (id) values (true) on conflict (id) do nothing;
alter table public.app_config enable row level security;
drop policy if exists "signed-in users read config" on public.app_config;
create policy "signed-in users read config" on public.app_config for select to authenticated using (true);
revoke all on public.app_config from anon, authenticated;
grant select on public.app_config to authenticated;

-- 2. Columns on intents
alter table public.intents add column if not exists payment_required boolean not null default false;

-- 3. Payments
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid not null unique references public.intents(id) on delete restrict,
  offer_id uuid not null references public.offers(id),
  buyer_id uuid not null references public.profiles(id),
  provider_id uuid not null references public.profiles(id),
  amount_cents integer not null check (amount_cents > 0),
  fee_cents integer not null check (fee_cents >= 0 and fee_cents < amount_cents),
  currency text not null default 'usd',
  status text not null default 'pending'
    check (status in ('pending','held','release_pending','released','refunded','void','failed')),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  stripe_charge_id text,
  stripe_transfer_id text,
  stripe_refund_id text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  released_at timestamptz,
  refunded_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists payments_provider_idx on public.payments (provider_id, status);

alter table public.payments enable row level security;
drop policy if exists "payment parties read" on public.payments;
create policy "payment parties read" on public.payments for select to authenticated
using (buyer_id = auth.uid() or provider_id = auth.uid());
revoke all on public.payments from anon, authenticated;
grant select on public.payments to authenticated;

-- 4. Provider payout accounts (Stripe Express). Private: only the owner reads.
create table if not exists public.payout_accounts (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  stripe_account_id text not null unique,
  details_submitted boolean not null default false,
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.payout_accounts enable row level security;
drop policy if exists "own payout account" on public.payout_accounts;
create policy "own payout account" on public.payout_accounts for select to authenticated using (user_id = auth.uid());
revoke all on public.payout_accounts from anon, authenticated;
grant select on public.payout_accounts to authenticated;

-- 5. Safety rules on WANT changes. Runs for every update, including the
--    existing SECURITY DEFINER functions (start_job, mark_job_done,
--    confirm_completed, cancel_intent), so they don't need rewriting.
create or replace function public.enforce_payment_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay text;
  v_internal boolean := coalesce(current_setting('want.paid_transition', true), '') = 'on';
begin
  -- When an offer is accepted, record whether this job needs payment.
  if old.status = 'open' and new.status = 'matched' then
    new.payment_required := coalesce((select payments_enabled from public.app_config limit 1), false);
  end if;

  if not new.payment_required then
    return new;
  end if;

  select status into v_pay from public.payments where intent_id = new.id;

  -- Work can't start (or be marked done) until the buyer has paid.
  if (old.started_at is null and new.started_at is not null)
     or (old.provider_done_at is null and new.provider_done_at is not null) then
    if coalesce(v_pay, '') <> 'held' then
      raise exception 'Waiting for the buyer''s payment before the job can start';
    end if;
  end if;

  -- Completing or cancelling a paid job must go through the payment functions
  -- (so money is released or refunded at the same time).
  if old.status = 'matched' and new.status in ('completed', 'cancelled') and not v_internal then
    if new.status = 'completed' then
      raise exception 'Use "Confirm & release payment" to complete a paid job';
    elsif v_pay = 'held' then
      raise exception 'Use "Cancel & refund" to cancel a paid job';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists intents_payment_rules on public.intents;
create trigger intents_payment_rules
before update on public.intents
for each row execute procedure public.enforce_payment_rules();

-- An unpaid checkout is voided if the WANT is cancelled.
create or replace function public.void_unpaid_on_cancel()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    update public.payments set status = 'void', updated_at = now()
    where intent_id = new.id and status = 'pending';
  end if;
  return new;
end;
$$;

drop trigger if exists intents_void_unpaid on public.intents;
create trigger intents_void_unpaid
after update on public.intents
for each row execute procedure public.void_unpaid_on_cancel();

revoke execute on function public.enforce_payment_rules() from public, anon, authenticated;
revoke execute on function public.void_unpaid_on_cancel() from public, anon, authenticated;

-- 6. Internal functions for the Edge Functions (service role only).

-- Buyer starts checkout: validate and create/reuse a pending payment row.
create or replace function public.internal_prepare_payment(p_intent_id uuid, p_buyer_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  i record; o record; cfg record; p record;
  v_amount int; v_fee int;
begin
  select * into cfg from public.app_config limit 1;
  select * into i from public.intents where id = p_intent_id for update;
  if not found or i.buyer_id <> p_buyer_id then raise exception 'WANT not found'; end if;
  if i.status <> 'matched' then raise exception 'This WANT is not waiting for payment'; end if;
  if not i.payment_required then raise exception 'This job does not need payment through WANT'; end if;
  select * into o from public.offers where id = i.accepted_offer_id;
  v_amount := round(o.amount * 100)::int;
  if v_amount < 50 then raise exception 'Amount is too small to pay online'; end if;
  v_fee := round(v_amount * cfg.fee_percent / 100)::int;

  select * into p from public.payments where intent_id = p_intent_id;
  if found then
    if p.status <> 'pending' then raise exception 'This job is already paid'; end if;
    update public.payments set amount_cents = v_amount, fee_cents = v_fee, updated_at = now() where id = p.id;
  else
    insert into public.payments(intent_id, offer_id, buyer_id, provider_id, amount_cents, fee_cents, currency)
    values (p_intent_id, o.id, i.buyer_id, o.provider_id, v_amount, v_fee, cfg.currency)
    returning * into p;
  end if;

  return json_build_object('payment_id', p.id, 'amount_cents', v_amount, 'fee_cents', v_fee,
    'currency', cfg.currency, 'description', left(i.description, 200));
end;
$$;

create or replace function public.internal_set_checkout_session(p_payment_id uuid, p_session_id text)
returns void language sql security definer set search_path = public as $$
  update public.payments set stripe_checkout_session_id = p_session_id, updated_at = now()
  where id = p_payment_id and status = 'pending';
$$;

-- Stripe webhook: checkout paid. Returns needs_refund when the WANT was
-- cancelled before the payment landed.
create or replace function public.internal_mark_paid(p_session_id text, p_payment_intent text, p_charge text, p_amount_cents int)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare p record; v_status text;
begin
  select * into p from public.payments where stripe_checkout_session_id = p_session_id for update;
  if not found then return json_build_object('ok', false, 'reason', 'unknown session'); end if;
  if p.status in ('held','release_pending','released','refunded') then
    return json_build_object('ok', true, 'duplicate', true);
  end if;
  if p_amount_cents <> p.amount_cents then
    update public.payments set status = 'failed', updated_at = now() where id = p.id;
    return json_build_object('ok', false, 'reason', 'amount mismatch', 'needs_refund', true, 'payment_intent', p_payment_intent);
  end if;

  select status into v_status from public.intents where id = p.intent_id;
  update public.payments
  set status = 'held', stripe_payment_intent_id = p_payment_intent, stripe_charge_id = p_charge,
      paid_at = now(), updated_at = now()
  where id = p.id;

  if v_status <> 'matched' then
    return json_build_object('ok', true, 'needs_refund', true, 'payment_id', p.id, 'payment_intent', p_payment_intent);
  end if;

  insert into public.notifications(user_id, kind, body, intent_id)
  values (p.provider_id, 'payment_held',
          'The buyer paid $' || trim(to_char(p.amount_cents / 100.0, 'FM999999990.00')) ||
          '. WANT holds it until the job is completed — you can start the job.', p.intent_id);
  return json_build_object('ok', true, 'payment_id', p.id);
end;
$$;

-- Buyer confirms completion: complete the WANT, mark payout pending.
create or replace function public.internal_complete_paid_job(p_intent_id uuid, p_buyer_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare i record; p record; a record;
begin
  select * into i from public.intents where id = p_intent_id for update;
  if not found or i.buyer_id <> p_buyer_id or i.status <> 'matched' then
    raise exception 'Only matched WANTs you own can be completed';
  end if;
  select * into p from public.payments where intent_id = p_intent_id for update;
  if not found or p.status <> 'held' then raise exception 'There is no held payment for this job'; end if;

  perform set_config('want.paid_transition', 'on', true);
  update public.intents set status = 'completed', completed_at = now(), updated_at = now() where id = p_intent_id;
  update public.payments set status = 'release_pending', updated_at = now() where id = p.id;

  insert into public.notifications(user_id, kind, body, intent_id)
  values (p.provider_id, 'job_completed',
          'The buyer confirmed the job is completed. Your payout of $' ||
          trim(to_char((p.amount_cents - p.fee_cents) / 100.0, 'FM999999990.00')) || ' is on its way.', p_intent_id);

  select * into a from public.payout_accounts where user_id = p.provider_id;
  return json_build_object('payment_id', p.id, 'transfer_cents', p.amount_cents - p.fee_cents,
    'currency', p.currency, 'charge_id', p.stripe_charge_id, 'intent_id', p_intent_id,
    'destination', case when a.payouts_enabled then a.stripe_account_id else null end);
end;
$$;

-- Pending payouts for a provider whose account just became ready.
create or replace function public.internal_pending_payouts(p_provider_id uuid)
returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object('payment_id', p.id, 'transfer_cents', p.amount_cents - p.fee_cents,
    'currency', p.currency, 'charge_id', p.stripe_charge_id, 'intent_id', p.intent_id)), '[]'::json)
  from public.payments p where p.provider_id = p_provider_id and p.status = 'release_pending';
$$;

create or replace function public.internal_record_transfer(p_payment_id uuid, p_transfer_id text)
returns void language sql security definer set search_path = public as $$
  update public.payments set status = 'released', stripe_transfer_id = p_transfer_id,
    released_at = now(), updated_at = now()
  where id = p_payment_id and status = 'release_pending';
$$;

-- Buyer cancels before the job started: validate (refund happens in Stripe first).
create or replace function public.internal_check_refundable(p_intent_id uuid, p_buyer_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare i record; p record;
begin
  select * into i from public.intents where id = p_intent_id;
  if not found or i.buyer_id <> p_buyer_id or i.status <> 'matched' then
    raise exception 'Only matched WANTs you own can be cancelled';
  end if;
  if i.started_at is not null then
    raise exception 'The provider already started this job. Message them, or contact WANT support for a refund.';
  end if;
  select * into p from public.payments where intent_id = p_intent_id;
  if not found or p.status <> 'held' then raise exception 'There is no held payment to refund'; end if;
  return json_build_object('payment_id', p.id, 'payment_intent', p.stripe_payment_intent_id, 'amount_cents', p.amount_cents);
end;
$$;

-- After Stripe refunded: record it and cancel the WANT (same effects as cancel_intent).
create or replace function public.internal_record_refund(p_payment_id uuid, p_refund_id text, p_cancel boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare p record;
begin
  select * into p from public.payments where id = p_payment_id for update;
  if not found then return; end if;
  update public.payments set status = 'refunded', stripe_refund_id = p_refund_id, refunded_at = now(), updated_at = now()
  where id = p_payment_id;
  if p_cancel then
    perform set_config('want.paid_transition', 'on', true);
    insert into public.notifications(user_id, kind, body, intent_id)
    select o.provider_id, 'want_cancelled', 'The buyer cancelled a job you were matched on. They were refunded.', p.intent_id
    from public.offers o where o.intent_id = p.intent_id and o.status in ('pending', 'accepted');
    update public.offers set status = 'declined' where intent_id = p.intent_id and status = 'pending';
    update public.intents set status = 'cancelled', cancelled_at = now(), updated_at = now()
    where id = p.intent_id and status = 'matched';
  end if;
end;
$$;

create or replace function public.internal_upsert_payout_account(p_user_id uuid, p_account_id text,
  p_details boolean, p_charges boolean, p_payouts boolean)
returns void language sql security definer set search_path = public as $$
  insert into public.payout_accounts(user_id, stripe_account_id, details_submitted, charges_enabled, payouts_enabled, updated_at)
  values (p_user_id, p_account_id, p_details, p_charges, p_payouts, now())
  on conflict (user_id) do update set stripe_account_id = excluded.stripe_account_id,
    details_submitted = excluded.details_submitted, charges_enabled = excluded.charges_enabled,
    payouts_enabled = excluded.payouts_enabled, updated_at = now();
$$;

create or replace function public.internal_update_payout_account(p_account_id text,
  p_details boolean, p_charges boolean, p_payouts boolean)
returns uuid language sql security definer set search_path = public as $$
  update public.payout_accounts set details_submitted = p_details, charges_enabled = p_charges,
    payouts_enabled = p_payouts, updated_at = now()
  where stripe_account_id = p_account_id
  returning user_id;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'internal_prepare_payment(uuid,uuid)', 'internal_set_checkout_session(uuid,text)',
    'internal_mark_paid(text,text,text,int)', 'internal_complete_paid_job(uuid,uuid)',
    'internal_pending_payouts(uuid)', 'internal_record_transfer(uuid,text)',
    'internal_check_refundable(uuid,uuid)', 'internal_record_refund(uuid,text,boolean)',
    'internal_upsert_payout_account(uuid,text,boolean,boolean,boolean)',
    'internal_update_payout_account(text,boolean,boolean,boolean)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function public.%s to service_role', f);
    end if;
  end loop;
end $$;

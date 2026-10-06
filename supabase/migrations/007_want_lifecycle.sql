-- WANT lifecycle: edit, cancel, and job completion
-- Apply once in the Supabase SQL Editor, after 006_notifications.sql. Safe to re-run.
--
-- Status flow:   open -> matched -> completed
--                open or matched -> cancelled
-- Completion is two-step and payment-ready: the provider marks the job done,
-- the buyer confirms. (Later, payment release will hang off the confirmation.)
-- The buyer can also confirm directly. All changes go through the functions
-- below; clients still cannot update intents/offers directly.

-- 1. Schema
alter table public.intents drop constraint if exists intents_status_check;
alter table public.intents add constraint intents_status_check
  check (status in ('open', 'matched', 'completed', 'closed', 'cancelled'));

alter table public.intents add column if not exists updated_at timestamptz;
alter table public.intents add column if not exists provider_done_at timestamptz;
alter table public.intents add column if not exists completed_at timestamptz;
alter table public.intents add column if not exists cancelled_at timestamptz;

-- Clients never write intents/offers directly (there were no policies for it;
-- this removes the unused grants too). Inserts keep working as before.
revoke update, delete on public.intents, public.offers from authenticated;

-- 2. Buyer edits an open WANT. Providers who already offered are told.
create or replace function public.edit_intent(
  p_intent_id uuid,
  p_description text,
  p_budget_max numeric,
  p_location text,
  p_deadline date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_desc text := btrim(coalesce(p_description, ''));
begin
  perform 1 from public.intents
  where id = p_intent_id and buyer_id = auth.uid() and status = 'open'
  for update;
  if not found then
    raise exception 'Only open WANTs you own can be edited';
  end if;

  if char_length(v_desc) < 1 or char_length(v_desc) > 1000 then
    raise exception 'Description must be 1 to 1000 characters';
  end if;
  if p_budget_max is not null and p_budget_max < 0 then
    raise exception 'Budget cannot be negative';
  end if;
  if char_length(coalesce(p_location, '')) > 120 then
    raise exception 'Location must be 120 characters or fewer';
  end if;
  if p_deadline is not null and p_deadline < current_date then
    raise exception 'Deadline cannot be in the past';
  end if;

  update public.intents
  set description = v_desc,
      budget_max = p_budget_max,
      location = nullif(btrim(coalesce(p_location, '')), ''),
      deadline = p_deadline,
      updated_at = now()
  where id = p_intent_id;

  insert into public.notifications(user_id, kind, body, intent_id)
  select provider_id, 'want_edited',
         'A WANT you made an offer on was edited by the buyer. Check that your offer still fits.',
         p_intent_id
  from public.offers
  where intent_id = p_intent_id and status = 'pending';
end;
$$;

-- 3. Buyer cancels an open or matched WANT.
create or replace function public.cancel_intent(p_intent_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_accepted uuid;
begin
  select status, accepted_offer_id into v_status, v_accepted
  from public.intents
  where id = p_intent_id and buyer_id = auth.uid()
  for update;

  if not found or v_status not in ('open', 'matched') then
    raise exception 'Only open or matched WANTs you own can be cancelled';
  end if;

  -- Tell everyone who is still waiting or was hired.
  insert into public.notifications(user_id, kind, body, intent_id)
  select provider_id, 'want_cancelled',
         case when status = 'accepted'
              then 'The buyer cancelled a job you were matched on.'
              else 'The buyer cancelled a WANT you made an offer on.' end,
         p_intent_id
  from public.offers
  where intent_id = p_intent_id and status in ('pending', 'accepted');

  update public.offers
  set status = 'declined'
  where intent_id = p_intent_id and status = 'pending';

  update public.intents
  set status = 'cancelled', cancelled_at = now(), updated_at = now()
  where id = p_intent_id;
end;
$$;

-- 4. Accepted provider marks the job as done (asks the buyer to confirm).
create or replace function public.mark_job_done(p_intent_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_buyer uuid;
begin
  select i.buyer_id into v_buyer
  from public.intents i
  join public.offers o on o.id = i.accepted_offer_id
  where i.id = p_intent_id
    and i.status = 'matched'
    and i.provider_done_at is null
    and o.provider_id = auth.uid()
  for update of i;

  if not found then
    raise exception 'Only the hired provider can mark an active job as done';
  end if;

  update public.intents
  set provider_done_at = now(), updated_at = now()
  where id = p_intent_id;

  insert into public.notifications(user_id, kind, body, intent_id)
  values (v_buyer, 'job_done',
          'Your provider marked the job as done. Please confirm it is completed.',
          p_intent_id);
end;
$$;

-- 5. Buyer confirms the job is completed.
create or replace function public.confirm_completed(p_intent_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_accepted uuid;
begin
  select accepted_offer_id into v_accepted
  from public.intents
  where id = p_intent_id and buyer_id = auth.uid() and status = 'matched'
  for update;

  if not found or v_accepted is null then
    raise exception 'Only matched WANTs you own can be marked completed';
  end if;

  update public.intents
  set status = 'completed', completed_at = now(), updated_at = now()
  where id = p_intent_id;

  insert into public.notifications(user_id, kind, body, intent_id)
  select provider_id, 'job_completed',
         'The buyer confirmed the job is completed. Great work!', p_intent_id
  from public.offers
  where id = v_accepted;
end;
$$;

-- 6. Only signed-in users may call these; each checks auth.uid() itself.
revoke execute on function public.edit_intent(uuid, text, numeric, text, date) from public, anon;
revoke execute on function public.cancel_intent(uuid) from public, anon;
revoke execute on function public.mark_job_done(uuid) from public, anon;
revoke execute on function public.confirm_completed(uuid) from public, anon;
grant execute on function public.edit_intent(uuid, text, numeric, text, date) to authenticated;
grant execute on function public.cancel_intent(uuid) to authenticated;
grant execute on function public.mark_job_done(uuid) to authenticated;
grant execute on function public.confirm_completed(uuid) to authenticated;

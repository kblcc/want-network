-- WANT: explicit "Start job" step
-- Apply once in the Supabase SQL Editor, after 007_want_lifecycle.sql. Safe to re-run.
--
-- Stages shown in the app (status stays 'matched' underneath, so messaging,
-- cancel and completion keep working unchanged):
--   matched, started_at null          -> "Matched"
--   started_at set, provider_done_at null -> "In progress"
--   provider_done_at set               -> "Awaiting confirmation"
--   status 'completed'                 -> "Completed"
-- Later, payment can sit between "Matched" and "In progress".

alter table public.intents add column if not exists started_at timestamptz;

-- Hired provider starts the job; buyer is notified.
create or replace function public.start_job(p_intent_id uuid)
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
    and i.started_at is null
    and o.provider_id = auth.uid()
  for update of i;

  if not found then
    raise exception 'Only the hired provider can start a matched job that has not started yet';
  end if;

  update public.intents
  set started_at = now(), updated_at = now()
  where id = p_intent_id;

  insert into public.notifications(user_id, kind, body, intent_id)
  values (v_buyer, 'job_started', 'Your provider started the job.', p_intent_id);
end;
$$;

-- Same as 007, except marking done also records a start time if the provider
-- skipped "Start job" (keeps older app versions working).
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
  set started_at = coalesce(started_at, now()),
      provider_done_at = now(),
      updated_at = now()
  where id = p_intent_id;

  insert into public.notifications(user_id, kind, body, intent_id)
  values (v_buyer, 'job_done',
          'Your provider marked the job as done. Please confirm it is completed.',
          p_intent_id);
end;
$$;

revoke execute on function public.start_job(uuid) from public, anon;
grant execute on function public.start_job(uuid) to authenticated;
revoke execute on function public.mark_job_done(uuid) from public, anon;
grant execute on function public.mark_job_done(uuid) to authenticated;

-- WANT visible notifications
-- Apply once in the Supabase SQL Editor, after 005_security_cleanup.sql. Safe to re-run.
--
-- * Notifications can link to the WANT they are about (new intent_id column).
-- * Users can mark their own notifications as read (read_at only), nothing else.
-- * New notification types: buyer gets "new offer", losing providers get "declined".
-- * Chatty conversations don't flood the bell: one unread "new message" per WANT.
-- * Notifications stream live to the app (Realtime, still filtered by RLS).
-- Existing notifications are kept as they are.

-- 1. Link a notification to its WANT.
alter table public.notifications
  add column if not exists intent_id uuid references public.intents(id) on delete cascade;

create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc);

-- 2. Users may only mark their own notifications as read.
drop policy if exists "own notifications mark read" on public.notifications;
create policy "own notifications mark read"
on public.notifications for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

-- Clients never create or delete notifications, and may only change read_at.
revoke insert, update, delete on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;

-- 3. Offer accepted -> accepted provider; other offers declined -> those providers.
--    Same logic as 002, plus intent_id and the declined notifications.
create or replace function public.accept_offer(p_offer_id uuid, p_intent_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_buyer uuid;
  v_status text;
begin
  select buyer_id, status
    into v_buyer, v_status
  from public.intents
  where id = p_intent_id
  for update;

  if not found or v_buyer <> auth.uid() or v_status <> 'open' then
    raise exception 'This WANT is no longer available for acceptance';
  end if;

  if not exists (
    select 1 from public.offers
    where id = p_offer_id and intent_id = p_intent_id and status = 'pending'
  ) then
    raise exception 'This offer is not available for acceptance';
  end if;

  update public.offers
  set status = case when id = p_offer_id then 'accepted' else 'declined' end
  where intent_id = p_intent_id and status = 'pending';

  update public.intents
  set status = 'matched', accepted_offer_id = p_offer_id
  where id = p_intent_id;

  insert into public.notifications(user_id, kind, body, intent_id)
  select provider_id, 'offer_accepted',
         'Your offer was accepted. You can now message the buyer.', p_intent_id
  from public.offers
  where id = p_offer_id;

  insert into public.notifications(user_id, kind, body, intent_id)
  select provider_id, 'offer_declined',
         'The buyer chose another offer for a WANT you bid on.', p_intent_id
  from public.offers
  where intent_id = p_intent_id and id <> p_offer_id and status = 'declined';
end;
$$;

-- 4. New message -> the other participant. Collapses into one unread
--    notification per WANT instead of one per message.
create or replace function public.notify_new_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_buyer uuid;
  v_provider uuid;
  v_recipient uuid;
begin
  select i.buyer_id, o.provider_id
    into v_buyer, v_provider
  from public.intents i
  join public.offers o on o.id = i.accepted_offer_id
  where i.id = new.intent_id;

  v_recipient := case when new.sender_id = v_buyer then v_provider else v_buyer end;

  update public.notifications
  set created_at = now()
  where user_id = v_recipient
    and intent_id = new.intent_id
    and kind = 'new_message'
    and read_at is null;

  if not found then
    insert into public.notifications(user_id, kind, body, intent_id)
    values (v_recipient, 'new_message', 'You have a new message about a matched WANT.', new.intent_id);
  end if;
  return new;
end;
$$;

-- 5. New offer -> the buyer who owns the WANT.
create or replace function public.notify_new_offer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notifications(user_id, kind, body, intent_id)
  select i.buyer_id, 'new_offer',
         'New offer: $' || trim(to_char(new.amount, 'FM999999990.00')) || ' on your WANT.',
         new.intent_id
  from public.intents i
  where i.id = new.intent_id;
  return new;
end;
$$;

drop trigger if exists on_offer_created on public.offers;
create trigger on_offer_created
after insert on public.offers
for each row execute procedure public.notify_new_offer();

-- Trigger functions are never callable through the API (same rule as 005).
revoke execute on function public.notify_new_offer() from public, anon, authenticated;
revoke execute on function public.notify_new_message() from public, anon, authenticated;
revoke execute on function public.accept_offer(uuid, uuid) from public, anon;
grant execute on function public.accept_offer(uuid, uuid) to authenticated;

-- 6. Live updates for the bell.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

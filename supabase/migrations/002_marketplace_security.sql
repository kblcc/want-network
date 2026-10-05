-- WANT marketplace security hardening
-- Apply this migration once to the connected Supabase project.

-- Providers may continue to read WANTs they have already offered on,
-- even after the WANT is matched/closed.
drop policy if exists "buyers read own intents providers read open" on public.intents;
create policy "buyers read own intents providers read market"
on public.intents for select to authenticated
using (
  buyer_id = auth.uid()
  or (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'provider')
    and (
      status = 'open'
      or exists (
        select 1 from public.offers o
        where o.intent_id = intents.id and o.provider_id = auth.uid()
      )
    )
  )
);

-- A provider can only create an offer on an open WANT.
drop policy if exists "providers create own offers" on public.offers;
create policy "providers create own offers"
on public.offers for insert to authenticated
with check (
  provider_id = auth.uid()
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'provider')
  and exists (select 1 from public.intents i where i.id = intent_id and i.status = 'open')
);

-- Do not let authenticated clients change their role directly.
revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

-- Serialize acceptance so the same WANT cannot be accepted concurrently.
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

  insert into public.notifications(user_id, kind, body)
  select provider_id, 'offer_accepted', 'Your offer was accepted.'
  from public.offers
  where id = p_offer_id;
end;
$$;

-- WANT secure in-app messaging
-- Apply once in the Supabase SQL Editor, after 003_fix_rls_recursion.sql.
--
-- Rules enforced by the database (not just the UI):
--   * A conversation belongs to one WANT that has an accepted offer.
--   * Only the buyer who owns the WANT and the provider whose offer was
--     accepted can read it. Losing providers and everyone else cannot.
--   * New messages can only be sent while the WANT is 'matched'.
--   * Messages cannot be edited or deleted by clients.
--   * Messages never expose email or phone; only display names are shown.

-- 1. Participant check. SECURITY DEFINER so the policy reads intents/offers
--    without re-entering their RLS policies (avoids the recursion fixed in 003).
create or replace function public.is_conversation_participant(p_intent_id uuid, p_require_matched boolean default false)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.intents i
    join public.offers o on o.id = i.accepted_offer_id
    where i.id = p_intent_id
      and o.intent_id = i.id
      and o.status = 'accepted'
      and (not p_require_matched or i.status = 'matched')
      and (i.buyer_id = auth.uid() or o.provider_id = auth.uid())
  );
$$;

revoke all on function public.is_conversation_participant(uuid, boolean) from public;
grant execute on function public.is_conversation_participant(uuid, boolean) to authenticated;

-- 2. Messages table.
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid not null references public.intents(id) on delete cascade,
  sender_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index if not exists messages_intent_created_idx
  on public.messages (intent_id, created_at);

-- 3. Row-level security.
alter table public.messages enable row level security;

drop policy if exists "match participants read messages" on public.messages;
create policy "match participants read messages"
on public.messages for select to authenticated
using (public.is_conversation_participant(intent_id));

drop policy if exists "match participants send messages" on public.messages;
create policy "match participants send messages"
on public.messages for insert to authenticated
with check (
  sender_id = auth.uid()
  and public.is_conversation_participant(intent_id, true)
);

-- No update/delete policies: messages are immutable for clients.
revoke all on public.messages from anon;
revoke update, delete on public.messages from authenticated;
grant select, insert on public.messages to authenticated;

-- 4. Notify the other participant (rows are stored now; a visible
--    notifications UI can read them later).
create or replace function public.notify_new_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_buyer uuid;
  v_provider uuid;
begin
  select i.buyer_id, o.provider_id
    into v_buyer, v_provider
  from public.intents i
  join public.offers o on o.id = i.accepted_offer_id
  where i.id = new.intent_id;

  insert into public.notifications(user_id, kind, body)
  values (
    case when new.sender_id = v_buyer then v_provider else v_buyer end,
    'new_message',
    'You have a new message about a matched WANT.'
  );
  return new;
end;
$$;

drop trigger if exists on_message_created on public.messages;
create trigger on_message_created
after insert on public.messages
for each row execute procedure public.notify_new_message();

-- 5. Live updates (Supabase Realtime still applies the RLS above per viewer).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;

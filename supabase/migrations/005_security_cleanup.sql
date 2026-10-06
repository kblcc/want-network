-- WANT security cleanup (from the Supabase security advisor)
-- Apply once in the Supabase SQL Editor, after 004_messaging.sql.
-- Only changes permissions. No tables, columns, policies or data are changed.

-- 1. Logged-out visitors (anon) should not be able to call any WANT function.
revoke execute on function public.accept_offer(uuid, uuid) from public, anon;
revoke execute on function public.provider_has_offer(uuid) from public, anon;
revoke execute on function public.is_conversation_participant(uuid, boolean) from public, anon;

-- 2. Trigger functions are only meant to run as triggers, never via the API.
--    (Triggers keep working: Postgres does not check EXECUTE when a trigger fires.)
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.notify_new_message() from public, anon, authenticated;

-- Signed-in users intentionally keep EXECUTE on these, because the app and
-- the RLS policies call them. Each one checks auth.uid() internally:
grant execute on function public.accept_offer(uuid, uuid) to authenticated;
grant execute on function public.provider_has_offer(uuid) to authenticated;
grant execute on function public.is_conversation_participant(uuid, boolean) to authenticated;

-- 3. Remove table privileges the app never uses.
--    Every RLS policy is "to authenticated", so anon already sees nothing;
--    this removes the grants as well. TRUNCATE also bypasses RLS, so it goes.
revoke all on public.profiles, public.intents, public.offers, public.notifications, public.messages from anon;
revoke truncate, references, trigger on public.profiles, public.intents, public.offers, public.notifications, public.messages from authenticated;

-- Fix RLS recursion introduced by 002_marketplace_security.sql
-- Uses a SECURITY DEFINER helper so the intents policy does not recursively
-- evaluate offers -> intents policies.

create or replace function public.provider_has_offer(p_intent_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.offers o
    where o.intent_id = p_intent_id
      and o.provider_id = auth.uid()
  );
$$;

revoke all on function public.provider_has_offer(uuid) from public;
grant execute on function public.provider_has_offer(uuid) to authenticated;

drop policy if exists "buyers read own intents providers read market" on public.intents;

create policy "buyers read own intents providers read market"
on public.intents for select to authenticated
using (
  buyer_id = auth.uid()
  or (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role = 'provider'
    )
    and (
      status = 'open'
      or public.provider_has_offer(id)
    )
  )
);

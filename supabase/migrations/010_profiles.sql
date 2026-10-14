-- WANT profiles: bio, service area, services, public profile stats
-- Apply once in the Supabase SQL Editor, after 009_reviews.sql. Safe to re-run.
--
-- * Everyone can set a display name, service area and short bio; providers
--   can also list up to 10 services.
-- * Users can only edit their own profile, and only those fields (never role).
-- * Signed-in users can view any profile (reputation); logged-out visitors can't.
-- * get_profile() adds stats people can't read directly because of privacy
--   rules: completed jobs, rating, member since.

-- 1. Columns
alter table public.profiles add column if not exists bio text;
alter table public.profiles add column if not exists service_area text;
alter table public.profiles add column if not exists services text[] not null default '{}';
alter table public.profiles add column if not exists updated_at timestamptz;

create or replace function public.valid_services(p text[])
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(cardinality(p), 0) <= 10
     and not exists (select 1 from unnest(p) s where char_length(btrim(s)) not between 1 and 40);
$$;

alter table public.profiles drop constraint if exists profiles_display_name_len;
alter table public.profiles add constraint profiles_display_name_len
  check (display_name is null or char_length(display_name) <= 80);
alter table public.profiles drop constraint if exists profiles_bio_len;
alter table public.profiles add constraint profiles_bio_len
  check (bio is null or char_length(bio) <= 600);
alter table public.profiles drop constraint if exists profiles_service_area_len;
alter table public.profiles add constraint profiles_service_area_len
  check (service_area is null or char_length(service_area) <= 120);
alter table public.profiles drop constraint if exists profiles_services_valid;
alter table public.profiles add constraint profiles_services_valid
  check (public.valid_services(services));

-- 2. Permissions: edit own profile fields only. Profiles are created by the
--    signup trigger, never by clients, and never deleted by clients.
drop policy if exists "own profile update" on public.profiles;
create policy "own profile update"
on public.profiles for update to authenticated
using (id = auth.uid())
with check (id = auth.uid());

revoke insert, update, delete, truncate, references, trigger on public.profiles from authenticated;
revoke all on public.profiles from anon;
grant select on public.profiles to authenticated;
grant update (display_name, bio, service_area, services, updated_at) on public.profiles to authenticated;

-- 3. Public profile with stats.
create or replace function public.get_profile(p_user_id uuid)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select case when auth.uid() is null then null else (
    select json_build_object(
      'id', p.id,
      'display_name', p.display_name,
      'role', p.role,
      'bio', p.bio,
      'service_area', p.service_area,
      'services', p.services,
      'member_since', p.created_at,
      'avg_rating', (select round(avg(r.rating)::numeric, 1) from public.reviews r where r.reviewee_id = p.id),
      'review_count', (select count(*) from public.reviews r where r.reviewee_id = p.id),
      'completed_jobs', (
        select count(*) from public.intents i
        join public.offers o on o.id = i.accepted_offer_id
        where i.status = 'completed' and o.provider_id = p.id),
      'completed_wants', (
        select count(*) from public.intents i
        where i.status = 'completed' and i.buyer_id = p.id)
    )
    from public.profiles p
    where p.id = p_user_id
  ) end;
$$;

revoke execute on function public.get_profile(uuid) from public, anon;
grant execute on function public.get_profile(uuid) to authenticated;

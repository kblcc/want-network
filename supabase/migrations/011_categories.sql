-- WANT categories + location matching
-- Apply once in the Supabase SQL Editor, after 010_profiles.sql. Safe to re-run.
-- Backward-compatible: the current live app keeps working before the new
-- app version is merged (category is optional on old WANTs).
--
-- * Every WANT can have a category from a fixed list.
-- * Providers choose the categories they serve.
-- * When a WANT is posted, providers who serve that category (and whose
--   service area matches the WANT's location, when both are set) get a
--   "New WANT" notification.

-- 1. The category list (keep in sync with CATEGORIES in src/main.js).
create or replace function public.want_categories()
returns text[]
language sql
immutable
set search_path = public
as $$
  select array['cleaning','handyman','plumbing','electrical','moving','yard',
               'painting','pets','tutoring','tech','beauty','events','errands','other'];
$$;

create or replace function public.valid_categories(p text[])
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(cardinality(p), 0) <= 14 and coalesce(p <@ public.want_categories(), true);
$$;

-- 2. Columns
alter table public.intents add column if not exists category text;
alter table public.intents drop constraint if exists intents_category_valid;
alter table public.intents add constraint intents_category_valid
  check (category is null or category = any (public.want_categories()));

create index if not exists intents_open_category_idx
  on public.intents (category, created_at desc) where status = 'open';

alter table public.profiles add column if not exists categories text[] not null default '{}';
alter table public.profiles drop constraint if exists profiles_categories_valid;
alter table public.profiles add constraint profiles_categories_valid
  check (public.valid_categories(categories));

grant update (display_name, bio, service_area, services, categories, updated_at)
  on public.profiles to authenticated;

-- 3. Buyer changes the category of an open WANT (edit_intent is unchanged so
--    older app versions keep working).
create or replace function public.set_intent_category(p_intent_id uuid, p_category text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_category is not null and not (p_category = any (public.want_categories())) then
    raise exception 'Unknown category';
  end if;

  update public.intents
  set category = p_category, updated_at = now()
  where id = p_intent_id and buyer_id = auth.uid() and status = 'open';

  if not found then
    raise exception 'Only open WANTs you own can be edited';
  end if;
end;
$$;

revoke execute on function public.set_intent_category(uuid, text) from public, anon;
grant execute on function public.set_intent_category(uuid, text) to authenticated;

-- 4. Loose place match: true when either side is empty, or one contains the
--    other ("Denver" ~ "Denver metro", "Aurora, CO" ~ "aurora").
create or replace function public.places_match(a text, b text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case
    when nullif(btrim(coalesce(a, '')), '') is null or nullif(btrim(coalesce(b, '')), '') is null then true
    else position(lower(split_part(btrim(a), ',', 1)) in lower(b)) > 0
      or position(lower(split_part(btrim(b), ',', 1)) in lower(a)) > 0
  end;
$$;

-- 5. Notify matching providers when a WANT is posted.
create or replace function public.notify_matching_providers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.category is null or new.status <> 'open' then
    return new;
  end if;

  insert into public.notifications(user_id, kind, body, intent_id)
  select p.id, 'new_want',
         'New WANT in your services' ||
           case when new.location is not null and btrim(new.location) <> '' then ' near ' || left(btrim(new.location), 60) else '' end ||
           case when new.budget_max is not null then ' (budget up to $' || trim(to_char(new.budget_max, 'FM999999990.##')) || ')' else '' end ||
           '.',
         new.id
  from public.profiles p
  where p.role = 'provider'
    and p.id <> new.buyer_id
    and new.category = any (p.categories)
    and public.places_match(p.service_area, new.location)
  limit 200;

  return new;
end;
$$;

drop trigger if exists on_intent_created_notify on public.intents;
create trigger on_intent_created_notify
after insert on public.intents
for each row execute procedure public.notify_matching_providers();

revoke execute on function public.notify_matching_providers() from public, anon, authenticated;

-- 6. Public profile also lists the categories a provider serves.
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
      'categories', p.categories,
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

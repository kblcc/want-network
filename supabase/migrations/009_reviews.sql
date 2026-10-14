-- WANT reviews & ratings
-- Apply once in the Supabase SQL Editor, after 008_start_job.sql. Safe to re-run.
--
-- * Only after a job is COMPLETED.
-- * Only the two people in that job: the buyer rates the provider, the
--   provider rates the buyer. One review each per job.
-- * 1-5 stars, optional comment (max 1000 chars). Reviews can't be edited or
--   deleted by clients.
-- * Signed-in users can read reviews and rating summaries (reputation).
--   Logged-out visitors can't.

-- 1. Table
create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid not null references public.intents(id) on delete cascade,
  reviewer_id uuid not null references public.profiles(id) on delete cascade,
  reviewee_id uuid not null references public.profiles(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  comment text check (comment is null or char_length(comment) <= 1000),
  created_at timestamptz not null default now(),
  unique (intent_id, reviewer_id),
  check (reviewer_id <> reviewee_id)
);

create index if not exists reviews_reviewee_created_idx
  on public.reviews (reviewee_id, created_at desc);

alter table public.reviews enable row level security;

drop policy if exists "signed-in users read reviews" on public.reviews;
create policy "signed-in users read reviews"
on public.reviews for select to authenticated
using (true);

-- Clients only read; reviews are created through submit_review() below.
revoke all on public.reviews from anon;
revoke insert, update, delete, truncate, references, trigger on public.reviews from authenticated;
grant select on public.reviews to authenticated;

-- 2. Rating summary per person (runs with the caller's permissions, so the
--    RLS above still applies).
create or replace view public.user_ratings
with (security_invoker = true) as
select reviewee_id as user_id,
       round(avg(rating)::numeric, 1) as avg_rating,
       count(*)::int as review_count
from public.reviews
group by reviewee_id;

revoke all on public.user_ratings from anon;
grant select on public.user_ratings to authenticated;

-- 3. Submit a review for a completed job.
create or replace function public.submit_review(
  p_intent_id uuid,
  p_rating int,
  p_comment text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_buyer uuid;
  v_provider uuid;
  v_status text;
  v_reviewee uuid;
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
begin
  select i.buyer_id, o.provider_id, i.status
    into v_buyer, v_provider, v_status
  from public.intents i
  join public.offers o on o.id = i.accepted_offer_id
  where i.id = p_intent_id;

  if not found or v_status <> 'completed' then
    raise exception 'Reviews can only be left for completed jobs';
  end if;

  if auth.uid() = v_buyer then
    v_reviewee := v_provider;
  elsif auth.uid() = v_provider then
    v_reviewee := v_buyer;
  else
    raise exception 'Only the buyer and the hired provider can review this job';
  end if;

  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'Rating must be between 1 and 5 stars';
  end if;
  if v_comment is not null and char_length(v_comment) > 1000 then
    raise exception 'Comment must be 1000 characters or fewer';
  end if;

  if exists (select 1 from public.reviews where intent_id = p_intent_id and reviewer_id = auth.uid()) then
    raise exception 'You already reviewed this job';
  end if;

  insert into public.reviews(intent_id, reviewer_id, reviewee_id, rating, comment)
  values (p_intent_id, auth.uid(), v_reviewee, p_rating, v_comment);

  insert into public.notifications(user_id, kind, body, intent_id)
  values (v_reviewee, 'review_received',
          'You received a ' || p_rating || '-star review for a completed job.',
          p_intent_id);
end;
$$;

revoke execute on function public.submit_review(uuid, int, text) from public, anon;
grant execute on function public.submit_review(uuid, int, text) to authenticated;

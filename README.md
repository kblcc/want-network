# WANT Network

**Stop searching. Just say what you want.**

WANT reverses search: people publish structured demand and providers compete to fulfill it.

## Production v1 build
This branch contains a real multi-user architecture (payments intentionally postponed):
- Buyer/provider signup and login
- Persistent WANTs
- Provider marketplace
- Real offers
- Buyer offer acceptance
- Status tracking
- Row-level security
- Notification data model

## Backend setup
1. Create a Supabase project.
2. Open SQL Editor and run `supabase/schema.sql` once.
3. Copy `.env.example` to `.env` and add the project URL and **publishable/anon key** (never a service-role key).
4. Run `npm install` then `npm run dev`.

## Deployment
Use a static frontend host with build command `npm run build`, output directory `dist`, and the two `VITE_SUPABASE_*` environment variables.

## Payments
Not included yet by design.

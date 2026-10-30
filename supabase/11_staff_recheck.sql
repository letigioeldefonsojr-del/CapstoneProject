-- Almares 328 - Supabase step 11: saved staff roles are re-checked against Firebase every hour.
-- Paste into SQL Editor > Run (once). Safe to run again.
alter table public.staff add column if not exists checked_at timestamptz;

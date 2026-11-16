-- Almares 328 - Supabase step 12: one-time staff registration codes.
-- Paste into SQL Editor > Run (once). Safe to run again.
alter table public.staff_code add column if not exists expires_at timestamptz;
alter table public.staff_code add column if not exists one_time boolean not null default false;

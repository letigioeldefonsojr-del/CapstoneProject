-- Almares 328 - Supabase step 13: a random 30-second staff code is emailed together with the sign-up OTP.
-- Paste into SQL Editor > Run (once). Safe to run again.
alter table public.otp_codes add column if not exists staff_hash text;
alter table public.otp_codes add column if not exists staff_expires_at timestamptz;

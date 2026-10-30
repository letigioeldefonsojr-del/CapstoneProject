-- Almares 328 - Supabase step 10: one-time email codes, server side.
-- Paste into SQL Editor > Run (once). Safe to run again.
-- Only the "login-guard" function (service role) can touch this table; only a hash of each code is kept.

create table if not exists public.otp_codes (
  email      text primary key,
  code_hash  text not null,
  expires_at timestamptz not null,
  attempts   integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.otp_codes enable row level security;
revoke all on public.otp_codes from anon, authenticated;

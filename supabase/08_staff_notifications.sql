-- Almares 328 - Supabase step 8: staff notifications (new order alerts etc.).
-- Paste into SQL Editor > Run (once). Safe to run again.

create table if not exists public.staff_notifications (
  id         text primary key default gen_random_uuid()::text,
  created_at timestamptz not null default now(),
  sender     text,                              -- Firebase uid of whoever caused it
  message    text not null,
  data       jsonb not null default '{}'::jsonb -- extra fields, e.g. orderId
);
create index if not exists staff_notifications_created_idx on public.staff_notifications (created_at desc);
create index if not exists staff_notifications_sender_idx  on public.staff_notifications (sender, created_at desc);

alter table public.staff_notifications enable row level security;
revoke all on public.staff_notifications from anon, authenticated;

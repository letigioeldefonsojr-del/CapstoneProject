-- Almares 328 - Supabase step 9: server-side login lockout + staff code.
-- Paste into SQL Editor > Run (once). Safe to run again.
-- Nothing here is readable or writable from the browser: only the
-- "login-guard" function (service role) can touch these tables.

create extension if not exists pgcrypto with schema extensions;

-- One row per typed email / username (lower-case), same schedule the site always used.
create table if not exists public.login_attempts (
  id                 text primary key,
  failed_count       integer not null default 0,
  locked_until       timestamptz,
  permanently_locked boolean not null default false,
  last_attempt_at    timestamptz not null default now()
);
create index if not exists login_attempts_last_idx on public.login_attempts (last_attempt_at);

-- The shared registration code, stored only as a SHA-256 hash (one row).
create table if not exists public.staff_code (
  id         integer primary key check (id = 1),
  code_hash  text not null,
  updated_at timestamptz not null default now()
);

alter table public.login_attempts enable row level security;
alter table public.staff_code     enable row level security;
revoke all on public.login_attempts, public.staff_code from anon, authenticated;

-- Is this identifier allowed to try right now?  -> { state: 'ok' | 'wait' | 'locked', secondsLeft }
create or replace function public.guard_check(k text, stale_min int default 15)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare r public.login_attempts%rowtype;
begin
  select * into r from public.login_attempts where id = k;
  if not found then return jsonb_build_object('state', 'ok'); end if;
  if r.permanently_locked then return jsonb_build_object('state', 'locked'); end if;
  if now() - r.last_attempt_at > make_interval(mins => stale_min) then
    return jsonb_build_object('state', 'ok');
  end if;
  if r.locked_until is not null and r.locked_until > now() then
    return jsonb_build_object('state', 'wait',
      'secondsLeft', ceil(extract(epoch from (r.locked_until - now())))::int);
  end if;
  return jsonb_build_object('state', 'ok');
end $$;

-- Records one failed attempt.
-- First `free` failures: plain error, then waits of base, 2*base, 4*base ... seconds;
-- more than `perm` failures: locked until an administrator unlocks it.
-- A failure count older than `stale_min` minutes starts again from zero (a permanent lock never does).
-- -> { failedCount, remaining | secondsLeft | locked }
create or replace function public.guard_fail(
  k text, free int default 6, base int default 30, perm int default 15, stale_min int default 15)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare r public.login_attempts%rowtype; prev int; cnt int; secs int; is_perm boolean;
begin
  perform pg_advisory_xact_lock(hashtext('guard:' || k));
  delete from public.login_attempts
   where last_attempt_at < now() - interval '1 day' and not permanently_locked;

  select * into r from public.login_attempts where id = k for update;
  if found and not r.permanently_locked and now() - r.last_attempt_at > make_interval(mins => stale_min) then
    prev := 0;
  elsif found then
    prev := r.failed_count;
  else
    prev := 0;
  end if;
  cnt := prev + 1;
  is_perm := cnt > perm;

  if cnt <= free and not is_perm then
    insert into public.login_attempts (id, failed_count, locked_until, permanently_locked, last_attempt_at)
    values (k, cnt, null, false, now())
    on conflict (id) do update
      set failed_count = excluded.failed_count, locked_until = null,
          permanently_locked = false, last_attempt_at = now();
    return jsonb_build_object('failedCount', cnt, 'remaining', free - cnt);
  end if;

  secs := base * (2 ^ (cnt - free - 1))::int;
  insert into public.login_attempts (id, failed_count, locked_until, permanently_locked, last_attempt_at)
  values (k, cnt, case when is_perm then null else now() + make_interval(secs => secs) end, is_perm, now())
  on conflict (id) do update
    set failed_count = excluded.failed_count, locked_until = excluded.locked_until,
        permanently_locked = excluded.permanently_locked, last_attempt_at = now();

  if is_perm then
    return jsonb_build_object('failedCount', cnt, 'locked', true);
  end if;
  return jsonb_build_object('failedCount', cnt, 'secondsLeft', secs);
end $$;

-- Clears the record(s): after a good login, or when an administrator unlocks an account.
create or replace function public.guard_reset(ks text[])
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.login_attempts where id = any(ks);
$$;

-- Which of these identifiers are locked right now? (Accounts page badges)
create or replace function public.guard_status(ks text[])
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id,
           'permanent', permanently_locked,
           'lockedUntilMs', case when locked_until is null then null
                                 else (extract(epoch from locked_until) * 1000)::bigint end)), '[]'::jsonb)
    from public.login_attempts
   where id = any(ks)
     and (permanently_locked or (locked_until is not null and locked_until > now()));
$$;

revoke all on function public.guard_check(text, int)                    from public, anon, authenticated;
revoke all on function public.guard_fail(text, int, int, int, int)      from public, anon, authenticated;
revoke all on function public.guard_reset(text[])                       from public, anon, authenticated;
revoke all on function public.guard_status(text[])                      from public, anon, authenticated;
grant execute on function public.guard_check(text, int)                 to service_role;
grant execute on function public.guard_fail(text, int, int, int, int)   to service_role;
grant execute on function public.guard_reset(text[])                    to service_role;
grant execute on function public.guard_status(text[])                   to service_role;

-- ---------------------------------------------------------------------
-- STAFF CODE: set (or change) the shared registration code.
-- Replace YOUR-CODE-HERE with the code exactly as staff type it (it is
-- case-sensitive). Run this line again any time you want to rotate it.
-- The old code is in the Firebase console: Firestore > staffCode > config > "code".
-- ---------------------------------------------------------------------
-- insert into public.staff_code (id, code_hash)
-- values (1, encode(extensions.digest('YOUR-CODE-HERE', 'sha256'), 'hex'))
-- on conflict (id) do update set code_hash = excluded.code_hash, updated_at = now();

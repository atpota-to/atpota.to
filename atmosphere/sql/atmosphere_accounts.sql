-- Active accounts: how many different DIDs wrote something, for the weather report's
-- "accounts" view (website/server/weather-accounts.ts). The station counts them with
-- HyperLogLog sketches (atmosphere/src/hll.js) and keeps no DIDs. This only stores the
-- sketches: the station merges them (atmosphere/src/rollup.js) and the website merges
-- and counts them (website/server/hll.ts). Merging in Postgres was tried first and is
-- far too slow on this project (about 70 ms a sketch in PL/pgSQL), so nothing here does.
-- Applied 2026-10-20, before the station that writes them. (Not as one migration: the
-- Supabase connector timed out on it, so it went in statement by statement.)
--
-- A sketch is bytes: [format, precision = 12, ...]. Format 1 (dense) is 4096 registers,
-- a byte each. Format 2 (sparse) is 3 bytes per non-zero register: its index (2 bytes,
-- big endian), then its value. Two sketches merge by taking each register's maximum.
-- Everyone active is bluesky merged with elsewhere, so only those two are kept; dids is
-- that union's count, worked out by the station.
--
-- What's kept:
--   atmosphere_minute.dids, dids_bluesky, dids_elsewhere
--       each minute's counts, forever
--   atmosphere_minute_app.dids
--       each app's, each minute, forever
--   atmosphere_account_sketch
--       Bluesky / elsewhere sketches by minute (26 hours), hour, day and month
--       (forever), with the seconds they cover
--   atmosphere_account_app_sketch
--       each app's, by minute (26 hours: the last hour is compared with the same hour
--       yesterday), hour (30 days), day and month (forever)
-- (Hours were first kept 8 days, and everyone's minutes 2 hours. atmosphere_retention.sql
-- changed that: its atmosphere_prune_sketches replaces the one below.)
--
-- Minutes are written as they're sealed. Hours, days and months are rewritten every 5
-- minutes and when they end; `through` is the last minute merged into one, so after a
-- restart the station reloads it and merges the minute rows after `through` again.

-- ---------- the counts on the minute rows ----------

alter table public.atmosphere_minute add column if not exists dids integer check (dids >= 0);
alter table public.atmosphere_minute add column if not exists dids_bluesky integer check (dids_bluesky >= 0);
alter table public.atmosphere_minute add column if not exists dids_elsewhere integer check (dids_elsewhere >= 0);
alter table public.atmosphere_minute_app add column if not exists dids integer check (dids >= 0);

-- ---------- sketches ----------

-- Bytes the station would have written (a shape check, not a decode).
create or replace function public.atmosphere_hll_ok(s bytea)
returns boolean
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select case
    when length(s) < 2 then false
    when get_byte(s, 1) <> 12 then false
    when get_byte(s, 0) = 1 then length(s) = 4098
    when get_byte(s, 0) = 2 then (length(s) - 2) % 3 = 0
    else false
  end;
$$;

create table if not exists public.atmosphere_account_sketch (
  period          text        not null check (period in ('minute', 'hour', 'day', 'month')),
  t               timestamptz not null,   -- the start of the minute, hour, (UTC) day or month
  through         timestamptz not null,   -- the last minute merged in
  seconds         integer     not null check (seconds > 0),  -- covered seconds merged in
  dids            integer     not null check (dids >= 0),    -- everyone active: bluesky ∪ elsewhere
  dids_bluesky    integer     not null check (dids_bluesky >= 0),
  dids_elsewhere  integer     not null check (dids_elsewhere >= 0),
  bluesky         bytea       not null check (public.atmosphere_hll_ok(bluesky)),    -- committed in app.bsky.* / chat.bsky.*
  elsewhere       bytea       not null check (public.atmosphere_hll_ok(elsewhere)),  -- committed anywhere else
  primary key (period, t)
);

create table if not exists public.atmosphere_account_app_sketch (
  period  text        not null check (period in ('minute', 'hour', 'day', 'month')),
  t       timestamptz not null,
  domain  text        not null check (domain ~ '^[a-z0-9-]+\.[a-z0-9-]+$'),
  dids    integer     not null check (dids >= 0),
  sketch  bytea       not null check (public.atmosphere_hll_ok(sketch)),
  primary key (period, t, domain)
);

alter table public.atmosphere_account_sketch enable row level security;
alter table public.atmosphere_account_app_sketch enable row level security;
drop policy if exists "anyone can read" on public.atmosphere_account_sketch;
drop policy if exists "anyone can read" on public.atmosphere_account_app_sketch;
create policy "anyone can read" on public.atmosphere_account_sketch for select using (true);
create policy "anyone can read" on public.atmosphere_account_app_sketch for select using (true);

-- ---------- trimming ----------

create or replace function public.atmosphere_prune_sketches()
returns integer
language sql
volatile
security invoker
set search_path = ''
as $$
  with a as (
    delete from public.atmosphere_account_sketch
    where (period = 'minute' and t < now() - interval '2 hours') or (period = 'hour' and t < now() - interval '8 days')
    returning 1
  ),
  b as (
    delete from public.atmosphere_account_app_sketch
    where (period = 'minute' and t < now() - interval '26 hours') or (period = 'hour' and t < now() - interval '8 days')
    returning 1
  )
  select ((select count(*) from a) + (select count(*) from b))::integer;
$$;
revoke all on function public.atmosphere_prune_sketches() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'atmosphere-prune-sketches';
select cron.schedule('atmosphere-prune-sketches', '17 * * * *', $$select public.atmosphere_prune_sketches()$$);

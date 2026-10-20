-- What the weather station keeps, and for how long. Applied 2026-10-20.
--
-- The aim is exact history at a sensible size (the project has 8 GB, shared with other
-- apps). Everything kept is an exact sum, or a sketch that merges exactly, so nothing
-- the report shows gets less accurate. What goes is per-app detail finer than an hour
-- once it's a month old.
--
--   atmosphere_minute               every minute, forever (~100 MB a year): the whole
--                                   firehose's counts and active accounts. Hours, days,
--                                   months, the heatmap and the almanac all come from it.
--   atmosphere_minute_app           each app, each minute: 30 days (~150 MB, flat).
--                                   It was ~5 MB a day and growing with the ecosystem.
--   atmosphere_hour_app             each app, each hour, forever (new, ~80 MB a year).
--                                   Re-summed from the minute rows every 10 minutes, so
--                                   it's exact; a minute row is only deleted once its
--                                   hour is in here.
--   atmosphere_day_app              each app, each day, forever (atmosphere_almanac.sql)
--   atmosphere_account_sketch       active accounts: minutes 2 hours; hours, days and
--                                   months forever (hours were 8 days; ~50 MB a year)
--   atmosphere_account_app_sketch   each app's: minutes 26 hours, hours 30 days, days and
--                                   months forever

-- ---------- one row per app per (UTC) hour, kept forever ----------

create table if not exists public.atmosphere_hour_app (
  hour         timestamptz not null,   -- the start of the UTC hour
  domain       text        not null check (domain ~ '^[a-z0-9-]+\.[a-z0-9-]+$'),
  creates      bigint      not null check (creates > 0),
  minutes      integer     not null,   -- minutes it was heard in
  collections  text[]      not null default '{}',  -- its busiest minute's busiest collections
  primary key (hour, domain)
);
create index if not exists atmosphere_hour_app_domain on public.atmosphere_hour_app (domain, hour);
alter table public.atmosphere_hour_app enable row level security;
drop policy if exists "anyone can read" on public.atmosphere_hour_app;
create policy "anyone can read" on public.atmosphere_hour_app for select using (true);

-- Re-sums the hours from `since` (default: this hour and the one before) out of the
-- minute rows, as atmosphere_roll_up_day_apps does for days.
create or replace function public.atmosphere_roll_up_hour_apps(since timestamptz default now() - interval '1 hour')
returns integer
language sql
volatile
security invoker
set search_path = ''
as $$
  with g as (
    select date_trunc('hour', a.minute, 'UTC') as hour, a.domain, sum(a.creates)::bigint as creates, count(*)::integer as minutes
    from public.atmosphere_minute_app a
    where a.minute >= date_trunc('hour', since, 'UTC')
    group by 1, 2
  ),
  up as (
    insert into public.atmosphere_hour_app (hour, domain, creates, minutes, collections)
    select g.hour, g.domain, g.creates, g.minutes, coalesce(b.collections, '{}')
    from g
    left join lateral (
      select x.collections from public.atmosphere_minute_app x
      where x.domain = g.domain and x.minute >= g.hour and x.minute < g.hour + interval '1 hour'
      order by x.creates desc, x.minute desc
      limit 1
    ) b on true
    on conflict (hour, domain) do update
      set creates = excluded.creates, minutes = excluded.minutes, collections = excluded.collections
    returning 1
  )
  select count(*)::integer from up;
$$;
revoke all on function public.atmosphere_roll_up_hour_apps(timestamptz) from public, anon, authenticated;

-- ---------- trimming ----------

-- Per-app minute rows over 30 days old, but only those whose hour is already summed in
-- atmosphere_hour_app with the same count (anything else stays, to be looked at). It
-- starts from the minute rows still there, so each run reads about a day of them.
create or replace function public.atmosphere_prune_minute_apps()
returns integer
language sql
volatile
security invoker
set search_path = ''
as $$
  with old as (
    select date_trunc('hour', a.minute, 'UTC') as hour, a.domain, sum(a.creates)::bigint as creates
    from public.atmosphere_minute_app a
    where a.minute < date_trunc('hour', now() - interval '30 days', 'UTC')
    group by 1, 2
  ),
  done as (
    select old.hour, old.domain
    from old join public.atmosphere_hour_app h on h.hour = old.hour and h.domain = old.domain and h.creates = old.creates
  ),
  gone as (
    delete from public.atmosphere_minute_app a
    using done
    where a.domain = done.domain and a.minute >= done.hour and a.minute < done.hour + interval '1 hour'
    returning 1
  )
  select count(*)::integer from gone;
$$;
revoke all on function public.atmosphere_prune_minute_apps() from public, anon, authenticated;

-- Account sketches (atmosphere_accounts.sql): hours of everyone are kept now; apps' hours 30 days.
create or replace function public.atmosphere_prune_sketches()
returns integer
language sql
volatile
security invoker
set search_path = ''
as $$
  with a as (
    delete from public.atmosphere_account_sketch
    where period = 'minute' and t < now() - interval '2 hours'
    returning 1
  ),
  b as (
    delete from public.atmosphere_account_app_sketch
    where (period = 'minute' and t < now() - interval '26 hours') or (period = 'hour' and t < now() - interval '30 days')
    returning 1
  )
  select ((select count(*) from a) + (select count(*) from b))::integer;
$$;
revoke all on function public.atmosphere_prune_sketches() from public, anon, authenticated;

-- Fill the hours from everything so far, then keep them fresh every 10 minutes (just
-- after the day roll-up), and trim once a day.
select public.atmosphere_roll_up_hour_apps('2000-01-01');
select cron.unschedule(jobid) from cron.job where jobname in ('atmosphere-hour-apps', 'atmosphere-prune-minute-apps');
select cron.schedule('atmosphere-hour-apps', '1-59/10 * * * *', $$select public.atmosphere_roll_up_hour_apps()$$);
select cron.schedule('atmosphere-prune-minute-apps', '23 4 * * *', $$select public.atmosphere_prune_minute_apps()$$);

-- The weather report's almanac (website/server/weather-almanac.ts) and its rising and
-- falling apps (website/server/weather-history.ts), on top of the weather station's
-- minute rows. Applied as one migration.
--
-- Everything here only reads what anyone can already read, except the daily roll-up,
-- which only pg_cron runs. Functions answer jsonb so they can grow without being
-- dropped and recreated.

-- ---------- one row per app per (UTC) day, kept forever ----------
-- Long ranges (30 days, 12 months) read this instead of the minute rows, and it keeps
-- "first heard" right even if minute-level app rows are ever trimmed.

create table if not exists public.atmosphere_day_app (
  day          timestamptz not null,   -- UTC midnight
  domain       text        not null check (domain ~ '^[a-z0-9-]+\.[a-z0-9-]+$'),
  creates      bigint      not null check (creates > 0),
  minutes      integer     not null,
  collections  text[]      not null default '{}',  -- its busiest minute's busiest collections
  primary key (day, domain)
);
create index if not exists atmosphere_day_app_domain on public.atmosphere_day_app (domain, day);
alter table public.atmosphere_day_app enable row level security;
drop policy if exists "anyone can read" on public.atmosphere_day_app;
create policy "anyone can read" on public.atmosphere_day_app for select using (true);

-- Re-sums the days from `since` (default: yesterday and today) out of the minute rows.
create or replace function public.atmosphere_roll_up_day_apps(since timestamptz default now() - interval '1 day')
returns integer
language sql
volatile
security invoker
set search_path = ''
as $$
  with g as (
    select date_trunc('day', a.minute, 'UTC') as day, a.domain, sum(a.creates)::bigint as creates, count(*)::integer as minutes
    from public.atmosphere_minute_app a
    where a.minute >= date_trunc('day', since, 'UTC')
    group by 1, 2
  ),
  up as (
    insert into public.atmosphere_day_app (day, domain, creates, minutes, collections)
    select g.day, g.domain, g.creates, g.minutes, coalesce(b.collections, '{}')
    from g
    left join lateral (
      select x.collections from public.atmosphere_minute_app x
      where x.domain = g.domain and x.minute >= g.day and x.minute < g.day + interval '1 day'
      order by x.creates desc, x.minute desc
      limit 1
    ) b on true
    on conflict (day, domain) do update
      set creates = excluded.creates, minutes = excluded.minutes, collections = excluded.collections
    returning 1
  )
  select count(*)::integer from up;
$$;
revoke all on function public.atmosphere_roll_up_day_apps(timestamptz) from public, anon, authenticated;

-- ---------- today so far: the high, the low, the totals ----------
-- "Today" starts at midnight in `tz` (an IANA name). Only minutes the station heard for
-- 55 seconds or more count toward the high and low, so a partial minute can't be either.
-- recordsHigh / recordsLow go by every new record a second (what the website shows);
-- high / low by Bluesky posts a second, from before the report switched to records.

create or replace function public.atmosphere_today(tz text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with b as (select (date_trunc('day', now() at time zone tz) at time zone tz) as start),
  m as (
    select x.minute, x.seconds_covered, x.posts, x.creates, x.elsewhere,
           x.posts::float8 / x.seconds_covered as posts_ps,
           x.creates::float8 / x.seconds_covered as creates_ps
    from public.atmosphere_minute x, b
    where x.minute >= b.start
  ),
  full_minutes as (select * from m where seconds_covered >= 55)
  select jsonb_build_object(
    'start', (select start from b),
    'seconds', (select coalesce(sum(seconds_covered), 0) from m),
    'posts', (select coalesce(sum(posts), 0) from m),
    'creates', (select coalesce(sum(creates), 0) from m),
    'elsewhere', (select coalesce(sum(elsewhere), 0) from m),
    'high', (select jsonb_build_object('minute', minute, 'perSecond', round(posts_ps::numeric, 1)) from full_minutes order by posts_ps desc, minute limit 1),
    'low', (select jsonb_build_object('minute', minute, 'perSecond', round(posts_ps::numeric, 1)) from full_minutes order by posts_ps asc, minute limit 1),
    'recordsHigh', (select jsonb_build_object('minute', minute, 'perSecond', round(creates_ps::numeric, 1)) from full_minutes order by creates_ps desc, minute limit 1),
    'recordsLow', (select jsonb_build_object('minute', minute, 'perSecond', round(creates_ps::numeric, 1)) from full_minutes order by creates_ps asc, minute limit 1)
  );
$$;

-- ---------- compared to usual ----------
-- The last hour against the same hour-long window on each of the 6 days before
-- ("days") and on the same weekday in each of the 8 weeks before ("weeks"). A window
-- only counts if the station heard at least half of it.

create or replace function public.atmosphere_normal()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with w as (
    select k, now() - make_interval(days => k) - interval '1 hour' as lo, now() - make_interval(days => k) as hi
    from unnest(array[0, 1, 2, 3, 4, 5, 6, 7, 14, 21, 28, 35, 42, 49, 56]) as k
  ),
  s as (
    select w.k,
           coalesce(sum(m.seconds_covered), 0)::bigint as seconds,
           coalesce(sum(m.posts), 0)::bigint as posts,
           coalesce(sum(m.creates), 0)::bigint as creates,
           coalesce(sum(m.elsewhere), 0)::bigint as elsewhere
    from w left join public.atmosphere_minute m on m.minute >= w.lo and m.minute < w.hi
    group by w.k
  ),
  heard as (select * from s where k > 0 and seconds >= 1800)
  select jsonb_build_object(
    'historyStart', (select min(minute) from public.atmosphere_minute),
    'now', (select jsonb_build_object('seconds', seconds, 'posts', posts, 'creates', creates, 'elsewhere', elsewhere) from s where k = 0),
    'days', (select jsonb_build_object('windows', count(*), 'seconds', coalesce(sum(seconds), 0), 'posts', coalesce(sum(posts), 0), 'creates', coalesce(sum(creates), 0), 'elsewhere', coalesce(sum(elsewhere), 0)) from heard where k < 7),
    'weeks', (select jsonb_build_object('windows', count(*), 'seconds', coalesce(sum(seconds), 0), 'posts', coalesce(sum(posts), 0), 'creates', coalesce(sum(creates), 0), 'elsewhere', coalesce(sum(elsewhere), 0)) from heard where k >= 7)
  );
$$;

-- ---------- new in the atmosphere ----------
-- Apps heard since `since` that the station had never heard before it. historyStart
-- says how long the station has been listening: until it's been a while, everything
-- is "new", and the website waits before calling anything new.

create or replace function public.atmosphere_new_apps(since timestamptz, max_apps integer default 20)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with recent as (
    select a.domain, min(a.minute) as first_seen, sum(a.creates)::bigint as creates, count(*)::bigint as minutes
    from public.atmosphere_minute_app a
    where a.minute >= since
    group by a.domain
  ),
  fresh as (
    select r.* from recent r
    where not exists (select 1 from public.atmosphere_minute_app o where o.domain = r.domain and o.minute < since)
      and not exists (select 1 from public.atmosphere_day_app d where d.domain = r.domain and d.day < date_trunc('day', since, 'UTC'))
    order by r.first_seen desc
    limit least(greatest(coalesce(max_apps, 20), 1), 50)
  )
  select jsonb_build_object(
    'historyStart', (select min(minute) from public.atmosphere_minute),
    'heard', (select count(*) from recent),
    'apps', coalesce((
      select jsonb_agg(jsonb_build_object(
        'domain', f.domain,
        'firstSeen', f.first_seen,
        'creates', f.creates,
        'minutes', f.minutes,
        'collections', coalesce((
          select b.collections from public.atmosphere_minute_app b
          where b.domain = f.domain and b.minute >= since
          order by b.creates desc, b.minute desc limit 1
        ), '{}')
      ) order by f.first_seen desc)
      from fresh f
    ), '[]'::jsonb)
  );
$$;

-- ---------- the busiest apps, and how each did in an earlier window ----------
-- [since, until) against [prev_since, prev_until). Spans over two days read the daily
-- roll-up (whole UTC days); shorter ones read the minute rows. seconds / prevSeconds
-- are how much of each window the station heard, so the website compares rates.

create or replace function public.atmosphere_app_trends(since timestamptz, until timestamptz, prev_since timestamptz, prev_until timestamptz, max_apps integer default 10)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with o as (
    select (until - since) > interval '2 days' as by_day,
           case when (until - since) > interval '2 days' then date_trunc('day', since, 'UTC') else since end as lo,
           case when (until - since) > interval '2 days' then date_trunc('day', prev_since, 'UTC') else prev_since end as prev_lo
  ),
  cur as (
    select a.domain, sum(a.creates)::bigint as creates from public.atmosphere_minute_app a, o
    where not o.by_day and a.minute >= o.lo and a.minute < until group by a.domain
    union all
    select d.domain, sum(d.creates)::bigint from public.atmosphere_day_app d, o
    where o.by_day and d.day >= o.lo and d.day < until group by d.domain
  ),
  top as (
    select domain, creates from cur order by creates desc, domain
    limit least(greatest(coalesce(max_apps, 10), 1), 50)
  ),
  prev as (
    select a.domain, sum(a.creates)::bigint as creates from public.atmosphere_minute_app a, o
    where not o.by_day and a.minute >= o.prev_lo and a.minute < prev_until and a.domain in (select domain from top) group by a.domain
    union all
    select d.domain, sum(d.creates)::bigint from public.atmosphere_day_app d, o
    where o.by_day and d.day >= o.prev_lo and d.day < prev_until and d.domain in (select domain from top) group by d.domain
  )
  select jsonb_build_object(
    'seconds', (select coalesce(sum(m.seconds_covered), 0) from public.atmosphere_minute m, o where m.minute >= o.lo and m.minute < until),
    'prevSeconds', (select coalesce(sum(m.seconds_covered), 0) from public.atmosphere_minute m, o where m.minute >= o.prev_lo and m.minute < prev_until),
    'apps', coalesce((
      select jsonb_agg(jsonb_build_object(
        'domain', t.domain,
        'creates', t.creates,
        'prevCreates', coalesce(p.creates, 0),
        'collections', coalesce((
          select b.collections from public.atmosphere_minute_app b
          where b.domain = t.domain and b.minute >= greatest(since, until - interval '2 days')
          order by b.creates desc, b.minute desc limit 1
        ), '{}')
      ) order by t.creates desc, t.domain)
      from top t left join prev p using (domain)
    ), '[]'::jsonb)
  );
$$;

-- ---------- apps heard over time ----------
-- Distinct apps outside Bluesky per minute, hour, (UTC) day or month since `since`.

create or replace function public.atmosphere_apps_over_time(since timestamptz, bucket text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('t', s.t, 'apps', s.apps) order by s.t), '[]'::jsonb)
  from (
    select m.minute as t, m.apps::bigint as apps
    from public.atmosphere_minute m where bucket = 'minute' and m.minute >= since
    union all
    select date_trunc('hour', a.minute, 'UTC'), count(distinct a.domain)
    from public.atmosphere_minute_app a where bucket = 'hour' and a.minute >= since group by 1
    union all
    select d.day, count(*)
    from public.atmosphere_day_app d where bucket = 'day' and d.day >= date_trunc('day', since, 'UTC') group by 1
    union all
    select date_trunc('month', d.day, 'UTC'), count(distinct d.domain)
    from public.atmosphere_day_app d where bucket = 'month' and d.day >= date_trunc('month', since, 'UTC') group by 1
  ) s;
$$;

-- ---------- when the sky is busiest ----------
-- Every hour of the week in `tz` (isodow 1 = monday), summed since `since`.

create or replace function public.atmosphere_heatmap(tz text, since timestamptz)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'seconds', coalesce(sum(c.seconds), 0),
    'cells', coalesce(jsonb_agg(jsonb_build_object('dow', c.dow, 'hour', c.hour, 'seconds', c.seconds, 'posts', c.posts, 'creates', c.creates) order by c.dow, c.hour), '[]'::jsonb)
  )
  from (
    select extract(isodow from m.minute at time zone tz)::integer as dow,
           extract(hour from m.minute at time zone tz)::integer as hour,
           sum(m.seconds_covered)::bigint as seconds,
           sum(m.posts)::bigint as posts,
           sum(m.creates)::bigint as creates
    from public.atmosphere_minute m
    where m.minute >= since
    group by 1, 2
  ) c;
$$;

revoke all on function public.atmosphere_today(text) from public;
revoke all on function public.atmosphere_normal() from public;
revoke all on function public.atmosphere_new_apps(timestamptz, integer) from public;
revoke all on function public.atmosphere_app_trends(timestamptz, timestamptz, timestamptz, timestamptz, integer) from public;
revoke all on function public.atmosphere_apps_over_time(timestamptz, text) from public;
revoke all on function public.atmosphere_heatmap(text, timestamptz) from public;
grant execute on function public.atmosphere_today(text) to anon, authenticated;
grant execute on function public.atmosphere_normal() to anon, authenticated;
grant execute on function public.atmosphere_new_apps(timestamptz, integer) to anon, authenticated;
grant execute on function public.atmosphere_app_trends(timestamptz, timestamptz, timestamptz, timestamptz, integer) to anon, authenticated;
grant execute on function public.atmosphere_apps_over_time(timestamptz, text) to anon, authenticated;
grant execute on function public.atmosphere_heatmap(text, timestamptz) to anon, authenticated;

-- Fill the roll-up from everything so far, then keep yesterday and today fresh every
-- 10 minutes.
select public.atmosphere_roll_up_day_apps('2000-01-01');
select cron.unschedule(jobid) from cron.job where jobname = 'atmosphere-day-apps';
select cron.schedule('atmosphere-day-apps', '*/10 * * * *', $$select public.atmosphere_roll_up_day_apps()$$);

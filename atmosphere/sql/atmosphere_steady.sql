-- Steady counts: an hour's new records with any burst taken out, for the weather's
-- busiest and quietest hours and days and its usual week (the heat map). Applied as
-- migration `atmosphere_steady`.
--
-- One app can write millions of records in a minute (a bulk import: podping.at wrote 3.6
-- million at 00:59 utc on 2026-10-17, layers.pub over a million at a time, again and
-- again), and the archive backfill has single minutes far above the minutes around them.
-- They're real counts and stay in `creates`, but they aren't the weather: an hour with
-- one in it is no busier a sky, and a usual week built from one forecasts a storm that
-- won't come back. So toward `steady`, no minute counts for more than 3 times its hour's
-- median minute, by new records a second. Live, no minute has come close (the most from
-- 2026-10-20 to 21 was 1.18 times its hour's median), so steady only moves for a burst.
--
--   atmosphere_hour, atmosphere_day   gain a last column, `steady`
--   atmosphere_heatmap                each cell gains `steady`
--
-- The views keep their columns in order (create or replace view can only add at the
-- end), and the hour view still reads only the minutes of the hours asked for: each
-- hour's median comes from its own minutes, gathered in the same pass.

create or replace view public.atmosphere_hour with (security_invoker = true) as
  select g.hour, g.seconds_covered, g.creates, g.bluesky, g.elsewhere, g.posts, g.likes, g.reposts, g.follows,
         g.updates, g.deletes, g.identity, g.account, s.steady
  from (
    select date_trunc('hour', minute) as hour,
           sum(seconds_covered)::int as seconds_covered,
           sum(creates)::bigint as creates, sum(bluesky)::bigint as bluesky, sum(elsewhere)::bigint as elsewhere,
           sum(posts)::bigint as posts, sum(likes)::bigint as likes, sum(reposts)::bigint as reposts, sum(follows)::bigint as follows,
           sum(updates)::bigint as updates, sum(deletes)::bigint as deletes,
           sum(identity)::bigint as identity, sum(account)::bigint as account,
           array_agg(creates) as minute_creates, array_agg(seconds_covered) as minute_seconds
    from public.atmosphere_minute
    group by 1
  ) g
  cross join lateral (
    select coalesce(round(sum(least(u.creates::float8, 3 * med.per_second * u.seconds))), 0)::bigint as steady
    from unnest(g.minute_creates, g.minute_seconds) as u(creates, seconds),
         (select percentile_cont(0.5) within group (order by m.creates::float8 / m.seconds) as per_second
            from unnest(g.minute_creates, g.minute_seconds) as m(creates, seconds)) med
  ) s;

create or replace view public.atmosphere_day with (security_invoker = true) as
  select date_trunc('day', hour) as day,
         sum(seconds_covered)::int as seconds_covered,
         sum(creates) as creates, sum(bluesky) as bluesky, sum(elsewhere) as elsewhere,
         sum(posts) as posts, sum(likes) as likes, sum(reposts) as reposts, sum(follows) as follows,
         sum(updates) as updates, sum(deletes) as deletes, sum(identity) as identity, sum(account) as account,
         sum(steady) as steady
  from public.atmosphere_hour group by 1;

create or replace function public.atmosphere_heatmap(tz text, since timestamptz)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'seconds', coalesce(sum(c.seconds), 0),
    'cells', coalesce(jsonb_agg(jsonb_build_object('dow', c.dow, 'hour', c.hour, 'seconds', c.seconds, 'posts', c.posts, 'creates', c.creates, 'steady', c.steady) order by c.dow, c.hour), '[]'::jsonb)
  )
  from (
    select extract(isodow from m.minute at time zone tz)::integer as dow,
           extract(hour from m.minute at time zone tz)::integer as hour,
           sum(m.seconds_covered)::bigint as seconds,
           sum(m.posts)::bigint as posts,
           sum(m.creates)::bigint as creates,
           round(sum(least(m.creates::float8, 3 * med.per_second * m.seconds_covered)))::bigint as steady
    from public.atmosphere_minute m
    join (
      -- each UTC hour's median minute, by new records a second
      select date_trunc('hour', x.minute) as hour,
             percentile_cont(0.5) within group (order by x.creates::float8 / x.seconds_covered) as per_second
      from public.atmosphere_minute x
      where x.minute >= date_trunc('hour', since)
      group by 1
    ) med on med.hour = date_trunc('hour', m.minute)
    where m.minute >= since
    group by 1, 2
  ) c;
$$;

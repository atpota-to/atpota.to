-- The busiest apps outside Bluesky since a moment, for the trends on /weather
-- (website/server/weather-history.ts). PostgREST's aggregates are off, so the sum
-- lives here; anyone can call it, and it only reads what anyone can already read.
--
--   POST /rest/v1/rpc/atmosphere_top_apps  { "since": "...", "max_apps": 10 }
--   ->  [{ domain, creates, minutes, collections }]
--
-- collections are the app's busiest collections in its busiest minute of the range.
create or replace function public.atmosphere_top_apps(since timestamptz, max_apps integer default 10)
returns table (domain text, creates bigint, minutes bigint, collections text[])
language sql
stable
security invoker
set search_path = ''
as $$
  select
    a.domain,
    sum(a.creates)::bigint as creates,
    count(*)::bigint as minutes,
    (
      select b.collections
      from public.atmosphere_minute_app b
      where b.domain = a.domain and b.minute >= since
      order by b.creates desc, b.minute desc
      limit 1
    ) as collections
  from public.atmosphere_minute_app a
  where a.minute >= since
  group by a.domain
  order by creates desc, a.domain
  limit least(greatest(coalesce(max_apps, 10), 1), 50);
$$;

revoke all on function public.atmosphere_top_apps(timestamptz, integer) from public;
grant execute on function public.atmosphere_top_apps(timestamptz, integer) to anon, authenticated;

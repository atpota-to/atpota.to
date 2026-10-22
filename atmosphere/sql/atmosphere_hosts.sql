-- PDS hosts over time: the weather station's census of the relay's list of hosts
-- (atmosphere/src/hosts.js), kept for the weather report's trends
-- (website/server/weather-history.ts, `hosts`). Applied 2026-10-22, before the station
-- that writes them, statement by statement: the Supabase connector timed out on it as one
-- migration, and holds DROPs for confirmation (so the drop-policy lines, which do nothing
-- on new tables, were left out).
--
-- What's kept, forever (both are small):
--   atmosphere_hosts      one row per census, every 10 minutes: the counts, the accounts
--                         on each side, and the hosting diversity's parts (~52k rows a year)
--   atmosphere_host_day   one row per active host per UTC day, rewritten every census, so
--                         it ends the day holding the day's last census (~1,900 rows a day,
--                         ~700k a year). A host's first row is when the station first saw it
--                         active; its seq moving from one day to the next means it wrote.
--
-- Only the service role writes; anyone can read (RLS).

create table if not exists public.atmosphere_hosts (
  t                     timestamptz not null primary key,  -- when the census was taken
  listed                integer  not null check (listed >= 0),       -- every host the relay lists
  active                integer  not null check (active >= 0),       -- the ones it calls active
  bluesky               integer  not null check (bluesky >= 0),      -- *.host.bsky.network
  independent           integer  not null check (independent >= 0),
  writing_bluesky       integer  check (writing_bluesky >= 0),       -- seq moved within writing_minutes; null until the station has counted twice
  writing_independent   integer  check (writing_independent >= 0),
  writing_minutes       integer  check (writing_minutes > 0),
  accounts_bluesky      bigint   not null check (accounts_bluesky >= 0),     -- on active hosts, by the relay's accountCount
  accounts_independent  bigint   not null check (accounts_independent >= 0),
  share                 numeric  not null check (share >= 0 and share <= 100),  -- percent of accounts on independent hosts
  spread                numeric  not null check (spread >= 0)                   -- independent hosts' worth, as an effective number
);

create table if not exists public.atmosphere_host_day (
  day       date    not null,   -- UTC
  hostname  text    not null check (hostname ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' and length(hostname) <= 253),
  bluesky   boolean not null,   -- one of Bluesky's own
  accounts  integer not null check (accounts >= 0),
  seq       bigint  check (seq >= 0),
  primary key (day, hostname)
);
create index if not exists atmosphere_host_day_hostname on public.atmosphere_host_day (hostname, day);

alter table public.atmosphere_hosts enable row level security;
alter table public.atmosphere_host_day enable row level security;
drop policy if exists "anyone can read" on public.atmosphere_hosts;
drop policy if exists "anyone can read" on public.atmosphere_host_day;
create policy "anyone can read" on public.atmosphere_hosts for select using (true);
create policy "anyone can read" on public.atmosphere_host_day for select using (true);

-- ---------- the trends ----------
-- For a range starting at `since`, bucketed by `bucket` (minute, hour, day or month, as
-- atmosphere_apps_over_time):
--   points   the last census in each bucket
--   since    the first day the station kept hosts (nothing before it is "new")
--   new      independent hosts first seen active since `since` (but not on that first
--            day), with the accounts they have now; newHosts is how many
--   growing  independent hosts that gained the most accounts over the range: now against
--            their first day in it (by day, so an hour's range compares with today so far)

create or replace function public.atmosphere_host_trends(since timestamptz, bucket text, max_hosts integer default 10)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with pts as (
    select distinct on (date_trunc(bucket, h.t, 'UTC')) date_trunc(bucket, h.t, 'UTC') as b, h.*
    from public.atmosphere_hosts h
    where h.t >= date_trunc(bucket, since, 'UTC')
    order by date_trunc(bucket, h.t, 'UTC'), h.t desc
  ),
  first_day as (select min(day) as day from public.atmosphere_host_day),
  last_day as (select max(day) as day from public.atmosphere_host_day),
  now_hosts as (
    select d.hostname, d.accounts from public.atmosphere_host_day d, last_day l
    where d.day = l.day and not d.bluesky
  ),
  seen as (
    select d.hostname, min(d.day) as first
    from public.atmosphere_host_day d
    where not d.bluesky
    group by d.hostname
  ),
  fresh as (
    select n.hostname, n.accounts, s.first
    from now_hosts n join seen s using (hostname), first_day f
    where s.first >= (since at time zone 'UTC')::date and s.first > f.day
  ),
  base as (
    select distinct on (d.hostname) d.hostname, d.accounts from public.atmosphere_host_day d
    where d.day >= (since at time zone 'UTC')::date and not d.bluesky
    order by d.hostname, d.day
  ),
  grew as (
    select n.hostname, n.accounts, b.accounts as prev
    from now_hosts n join base b using (hostname)
    where n.accounts > b.accounts
  )
  select jsonb_build_object(
    'since', (select day from first_day),
    'points', coalesce((select jsonb_agg(jsonb_build_object(
        't', p.t, 'listed', p.listed, 'active', p.active, 'bluesky', p.bluesky, 'independent', p.independent,
        'writing', case when p.writing_minutes is null then null else p.writing_bluesky + p.writing_independent end,
        'accountsBluesky', p.accounts_bluesky, 'accountsIndependent', p.accounts_independent,
        'share', p.share, 'spread', p.spread
      ) order by p.b) from pts p), '[]'::jsonb),
    'newHosts', (select count(*) from fresh),
    'new', coalesce((select jsonb_agg(jsonb_build_object('hostname', x.hostname, 'accounts', x.accounts, 'first', x.first) order by x.accounts desc, x.hostname)
        from (select * from fresh order by accounts desc, hostname limit max_hosts) x), '[]'::jsonb),
    'growing', coalesce((select jsonb_agg(jsonb_build_object('hostname', x.hostname, 'accounts', x.accounts, 'prevAccounts', x.prev) order by x.accounts - x.prev desc, x.hostname)
        from (select * from grew order by accounts - prev desc, hostname limit max_hosts) x), '[]'::jsonb)
  );
$$;
revoke all on function public.atmosphere_host_trends(timestamptz, text, integer) from public;
grant execute on function public.atmosphere_host_trends(timestamptz, text, integer) to anon, authenticated;

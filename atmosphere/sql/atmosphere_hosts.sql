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

-- ---------- estimated days, and the identity weather (src/backfill-hosts.js) ----------
-- Days from before the station kept hosts can be estimated from the PLC directory's log:
-- they're marked `estimated`. The station's own rows leave it false.
--
-- atmosphere_plc_day is each UTC day's identity changes, counted from the same log (exact,
-- not estimated): new accounts by where they signed up, how many new accounts on listed
-- hosts started with a handle on their own domain, accounts moving out of Bluesky's hosts,
-- back in, and between independent hosts, and deletions. "Unlisted" is a host the relay
-- doesn't list. ~365 rows a year.

alter table public.atmosphere_hosts add column if not exists estimated boolean not null default false;
alter table public.atmosphere_host_day add column if not exists estimated boolean not null default false;

create table if not exists public.atmosphere_plc_day (
  day                    date    not null primary key,  -- UTC
  ops                    integer not null check (ops >= 0),                    -- operations in the log that day
  created_bluesky        integer not null check (created_bluesky >= 0),        -- new accounts on Bluesky's hosts
  created_independent    integer not null check (created_independent >= 0),    -- on independent hosts the relay lists
  created_unlisted       integer not null check (created_unlisted >= 0),       -- on hosts it doesn't
  created_custom_handle  integer not null check (created_custom_handle >= 0),  -- new accounts on listed hosts with a handle outside *.bsky.social
  moved_out              integer not null check (moved_out >= 0),              -- from Bluesky's hosts to an independent one
  moved_in               integer not null check (moved_in >= 0),               -- the other way
  moved_between          integer not null check (moved_between >= 0),          -- from one independent host to another
  deleted                integer not null check (deleted >= 0)                 -- tombstones
);
-- the independent hosts accounts moved to that day (out of Bluesky's hosts, or from another
-- independent one), the ten busiest: [{ hostname, accounts }]. Added 2026-10-22.
alter table public.atmosphere_plc_day add column if not exists destinations jsonb not null default '[]'::jsonb;
-- the new accounts on independent hosts made in bulk that day: in runs on one host shaped as
-- no crowd of people makes them, switched on and off at a machine's steady pace or in floods
-- again and again (src/backfill-hosts.js bulkRun), and the hosts that made them, the ten with the most:
-- [{ hostname, accounts, bursts, seconds }], seconds being how long the runs lasted in all.
-- The weather report counts them apart. Zero on days counted before they were added, until
-- the backfill recounts them. Added 2026-10-28.
alter table public.atmosphere_plc_day add column if not exists created_bulk integer not null default 0 check (created_bulk >= 0);
alter table public.atmosphere_plc_day add column if not exists bulk_hosts jsonb not null default '[]'::jsonb;
-- the new identities on independent hosts with no handle that day (of created_independent):
-- nobody signs in to one, like the identities a git server (knot1.tangled.sh) makes for its
-- repositories. The weather report counts them apart, like the bulk ones. Zero on days counted
-- before it was added, until the backfill recounts them. Added 2026-10-31.
alter table public.atmosphere_plc_day add column if not exists created_unnamed integer not null default 0 check (created_unnamed >= 0);
alter table public.atmosphere_plc_day enable row level security;
create policy "anyone can read" on public.atmosphere_plc_day for select using (true);

-- atmosphere_host_arrival_day is who arrived on each independent host each UTC day, from the
-- PLC log (src/backfill-hosts.js arrivalRows): the relay's count of a host's accounts goes up
-- for anything the host serves, so it can't say whether people came. One row per host anyone
-- arrived on, today's rewritten as the station reads the log (src/plc-watch.js). ~200 rows a
-- day. Added 2026-10-31.
create table if not exists public.atmosphere_host_arrival_day (
  day        date    not null,   -- UTC
  hostname   text    not null check (hostname ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' and length(hostname) <= 253),
  signed_up  integer not null default 0 check (signed_up >= 0),  -- new accounts with a handle, not made in bulk: people
  bulk       integer not null default 0 check (bulk >= 0),       -- new accounts made in bulk (bulkRun)
  unnamed    integer not null default 0 check (unnamed >= 0),    -- identities with no handle, made or moved there
  moved_in   integer not null default 0 check (moved_in >= 0),   -- accounts with a handle that moved there, from Bluesky's hosts or another
  primary key (day, hostname)
);
create index if not exists atmosphere_host_arrival_day_hostname on public.atmosphere_host_arrival_day (hostname, day);
alter table public.atmosphere_host_arrival_day enable row level security;
drop policy if exists "anyone can read" on public.atmosphere_host_arrival_day;
create policy "anyone can read" on public.atmosphere_host_arrival_day for select using (true);

-- atmosphere_host_active_day is who was active on each independent host each UTC day:
-- a HyperLogLog sketch of the accounts that wrote anything (atmosphere_accounts.sql has
-- the format), and its count. The station knows where accounts live from each host's own
-- list of them, kept up to date from the PLC log (atmosphere/src/host-activity.js); no
-- DID is kept. hostname '*' is every independent host together, so against the day's
-- atmosphere_account_sketch it's the share of active accounts living off Bluesky's
-- hosts. Today's rows are rewritten after each census. Applied 2026-10-22.
create table if not exists public.atmosphere_host_active_day (
  day       date    not null,
  hostname  text    not null check (hostname = '*' or hostname ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
  dids      integer not null check (dids >= 0),
  sketch    bytea   not null check (public.atmosphere_hll_ok(sketch)),
  primary key (day, hostname)
);
alter table public.atmosphere_host_active_day enable row level security;
create policy "anyone can read" on public.atmosphere_host_active_day for select using (true);

-- ---------- the trends ----------
-- For a range starting at `since`, bucketed by `bucket` (minute, hour, day or month, as
-- atmosphere_apps_over_time):
--   points   the last census in each bucket
--   since    the first day the station kept hosts (nothing before it is "new")
--   new      independent hosts first seen active since `since` (but not on that first
--            day) that are new, not just newly seen: they had 25 or fewer accounts when first
--            seen, or at least half the accounts they have now arrived in the range (signed up
--            or moved in, by atmosphere_host_arrival_day, whoever made them). haruhwa.com, first
--            seen with 14,217 accounts from 2025, isn't. (The first rule is for a host whose
--            first sign-ups came before the relay listed it: the station only counts arrivals
--            on hosts the relay lists.) The ones the most people arrived on (signed up, not in
--            bulk, or moved in), with the accounts they have now; newHosts is how many
--   growing  independent hosts the most people arrived on over the range: signed up, not in
--            bulk, or moved in, on the UTC days after the one `since` falls on, as the sign-ups
--            tile counts them (a day's range is today so far, a week's the last 6 days and
--            today, as the relay's count against the day before's last census was). Not the
--            relay's count, which goes up for accounts made in bulk and identities nobody
--            signs in to as much as for people. prevAccounts is the relay's count on their
--            first day in the range, for comparison. Accounts leaving aren't taken off: the
--            log can't say where most moves back to Bluesky's hosts came from (backfill-hosts.js)
--
--            The station's bulkRun only catches the obvious runs, so two more rules, on whole
--            hosts and days, keep scripts out of the people (October 2026's checks are in
--            atmosphere/README.md):
--            - a host caught making accounts in bulk in the range has none of its sign-ups
--              counted as people, only its moves in: the same scripts make runs too uneven to
--              catch (goodmkt.id's 4,500 in one run on Oct 28 were caught, the 601 an hour later
--              weren't; on Oct 23 it made runs of 50 every five minutes on the dot)
--            - a day of 100 or more sign-ups on a host, after which it signed nobody up for
--              the next 3 days, isn't people either: a crowd keeps coming, a script stops dead
--              (refpds.oyster.cafe's 1,062 in 45 minutes on Oct 26, then none). Until the 3 days
--              have gone by, the day counts
--   daily    day by day (UTC), over the range but at least the last 7 days: active hosts at
--            the day's last census and the change from the day before, and how many
--            independent hosts joined (active that day, not the day before) and left (the
--            other way round). Joined and left are null on the first day kept, and
--            `estimated` marks a day from the backfill (src/backfill-hosts.js).
--   identities  atmosphere_plc_day's rows over the same days: each day's sign-ups, moves
--            and deletions from the PLC directory's log (today's so far).

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
    select distinct on (d.hostname) d.hostname, d.day as first, d.accounts as first_accounts
    from public.atmosphere_host_day d
    where not d.bluesky
    order by d.hostname, d.day
  ),
  -- each host's days of arrivals in the range, with its sign-ups as people: none on a day of
  -- 100 or more after which it signed nobody up for 3 days
  arrival as (
    select a.*, case
        when a.signed_up >= 100 and a.day + 3 < (now() at time zone 'UTC')::date
          and not exists (select 1 from public.atmosphere_host_arrival_day x
            where x.hostname = a.hostname and x.day > a.day and x.day <= a.day + 3 and x.signed_up + x.bulk > 0)
        then 0 else a.signed_up end as people_signed_up
    from public.atmosphere_host_arrival_day a
    where a.day > (since at time zone 'UTC')::date
  ),
  -- who arrived on each independent host over the range: people (none of the sign-ups on a
  -- host that made any in bulk), and everything that came
  arrived as (
    select a.hostname,
      sum(a.moved_in) + case when sum(a.bulk) > 0 then 0 else sum(a.people_signed_up) end as people,
      sum(a.signed_up + a.bulk + a.unnamed + a.moved_in) as everything
    from arrival a
    group by a.hostname
  ),
  fresh as (
    select n.hostname, n.accounts, s.first, coalesce(r.people, 0) as people
    from now_hosts n join seen s using (hostname) left join arrived r using (hostname), first_day f
    where s.first >= (since at time zone 'UTC')::date and s.first > f.day
      and (s.first_accounts <= 25 or n.accounts <= 2 * coalesce(r.everything, 0))
  ),
  base as (
    select distinct on (d.hostname) d.hostname, d.accounts from public.atmosphere_host_day d
    where d.day >= (since at time zone 'UTC')::date and not d.bluesky
    order by d.hostname, d.day
  ),
  grew as (
    select n.hostname, n.accounts, coalesce(b.accounts, 0) as prev, r.people
    from arrived r join now_hosts n using (hostname) left join base b using (hostname)
    where r.people > 0
  ),
  days as (
    select g::date as day
    from generate_series(
      greatest((select day from first_day), (least(since, now() - interval '6 days') at time zone 'UTC')::date),
      (now() at time zone 'UTC')::date,
      interval '1 day'
    ) g
    where (select day from first_day) is not null
  ),
  census_day as (
    select distinct on ((h.t at time zone 'UTC')::date) (h.t at time zone 'UTC')::date as day, h.active, h.estimated
    from public.atmosphere_hosts h
    where h.t >= (least(since, now() - interval '6 days') at time zone 'UTC')::date - 1
    order by (h.t at time zone 'UTC')::date, h.t desc
  ),
  daily as (
    select d.day, c.active, c.active - p.active as change, coalesce(c.estimated, false) as estimated,
      case when d.day > (select day from first_day) then (
        select count(*) from public.atmosphere_host_day x
        where x.day = d.day and not x.bluesky
          and not exists (select 1 from public.atmosphere_host_day y where y.day = d.day - 1 and y.hostname = x.hostname)
      ) end as joined,
      case when d.day > (select day from first_day) then (
        select count(*) from public.atmosphere_host_day x
        where x.day = d.day - 1 and not x.bluesky
          and not exists (select 1 from public.atmosphere_host_day y where y.day = d.day and y.hostname = x.hostname)
      ) end as left_
    from days d
    left join census_day c on c.day = d.day
    left join census_day p on p.day = d.day - 1
  ),
  -- the latest day of host activity, a finished one if there is one (yesterday, usually)
  active_last as (
    select coalesce(max(day) filter (where day < (now() at time zone 'UTC')::date), max(day)) as day
    from public.atmosphere_host_active_day
  )
  select jsonb_build_object(
    'since', (select day from first_day),
    'points', coalesce((select jsonb_agg(jsonb_build_object(
        't', p.t, 'listed', p.listed, 'active', p.active, 'bluesky', p.bluesky, 'independent', p.independent,
        'writing', case when p.writing_minutes is null then null else p.writing_bluesky + p.writing_independent end,
        'accountsBluesky', p.accounts_bluesky, 'accountsIndependent', p.accounts_independent,
        'share', p.share, 'spread', p.spread, 'estimated', p.estimated
      ) order by p.b) from pts p), '[]'::jsonb),
    'newHosts', (select count(*) from fresh),
    'new', coalesce((select jsonb_agg(jsonb_build_object('hostname', x.hostname, 'accounts', x.accounts, 'people', x.people, 'first', x.first) order by x.people desc, x.accounts desc, x.hostname)
        from (select * from fresh order by people desc, accounts desc, hostname limit max_hosts) x), '[]'::jsonb),
    'growing', coalesce((select jsonb_agg(jsonb_build_object('hostname', x.hostname, 'accounts', x.accounts, 'prevAccounts', x.prev, 'people', x.people) order by x.people desc, x.hostname)
        from (select * from grew order by people desc, hostname limit max_hosts) x), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('day', d.day, 'active', d.active, 'change', d.change, 'joined', d.joined, 'left', d.left_, 'estimated', d.estimated) order by d.day) from daily d), '[]'::jsonb),
    'identities', coalesce((select jsonb_agg(to_jsonb(p) order by p.day) from public.atmosphere_plc_day p
        where p.day >= (least(since, now() - interval '6 days') at time zone 'UTC')::date), '[]'::jsonb),
    -- each day's active accounts on independent hosts, and everyone's (atmosphere_account_sketch)
    'activeDaily', coalesce((select jsonb_agg(jsonb_build_object('day', d.day, 'independent', a.dids, 'all', s.dids) order by d.day)
        from days d
        join public.atmosphere_host_active_day a on a.day = d.day and a.hostname = '*'
        left join public.atmosphere_account_sketch s on s.period = 'day' and s.t = (d.day::timestamp at time zone 'UTC')), '[]'::jsonb),
    -- the independent hosts with the most accounts active that day, and how many accounts they hold
    'liveliest', (select jsonb_build_object('day', l.day, 'soFar', l.day >= (now() at time zone 'UTC')::date, 'hosts', coalesce((
        select jsonb_agg(jsonb_build_object('hostname', x.hostname, 'active', x.dids, 'accounts', x.accounts) order by x.dids desc, x.hostname)
        from (select a.hostname, a.dids, h.accounts from public.atmosphere_host_active_day a
              left join public.atmosphere_host_day h on h.day = a.day and h.hostname = a.hostname
              where a.day = l.day and a.hostname <> '*'
              order by a.dids desc, a.hostname limit max_hosts) x), '[]'::jsonb))
      from active_last l where l.day is not null)
  );
$$;
revoke all on function public.atmosphere_host_trends(timestamptz, text, integer) from public;
grant execute on function public.atmosphere_host_trends(timestamptz, text, integer) to anon, authenticated;

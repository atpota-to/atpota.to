-- Applied 2026-10-20 to the Supabase project "atpota.to" (zdzjtziydmwkxbzlkwxv) as
-- migration `atmosphere_weather_station`. This is SPEC.md's SQL with one change: the
-- two views are security_invoker, so readers go through the tables' own policies (and
-- Supabase's security advisor doesn't flag them as security-definer views).
--
-- Written once a minute by atpotato-weather with the service role. Counts, not rates: a
-- rate is sum(x) / sum(seconds_covered); the diversity index for any range is
-- 100.0 * sum(elsewhere) / nullif(sum(creates), 0). Never average per-minute indexes.

-- One row a minute: the whole firehose, summed.
create table public.atmosphere_minute (
  minute            timestamptz primary key,       -- start of the minute
  seconds_covered   smallint    not null check (seconds_covered between 1 and 60),
  creates           integer     not null,          -- all new records
  bluesky           integer     not null,          -- new records in app.bsky.* / chat.bsky.*
  elsewhere         integer     not null,          -- creates - bluesky (incl. unnamed)
  posts             integer     not null,
  likes             integer     not null,
  reposts           integer     not null,
  follows           integer     not null,
  updates           integer     not null,
  deletes           integer     not null,
  identity          integer     not null,
  account           integer     not null,
  collections       smallint    not null,          -- distinct collections with a create
  apps              smallint    not null,          -- distinct non-bluesky apps with a create
  check (bluesky + elsewhere = creates)
);
comment on table public.atmosphere_minute is 'atpotato weather station: one row a minute of the whole AT Protocol firehose (Jetstream), raw counts. Written by atpotato-weather on the jetstream-consumer droplet (service role, upsert on minute). Public read. See atmosphere/SPEC.md in atpota-to/atpota.to.';

-- One row per app (outside Bluesky) per minute.
create table public.atmosphere_minute_app (
  minute       timestamptz not null references public.atmosphere_minute (minute) on delete cascade,
  domain       text        not null check (domain ~ '^[a-z0-9-]+\.[a-z0-9-]+$'),
  creates      integer     not null check (creates > 0),
  -- its busiest collections that minute, busiest first, at most 3
  collections  text[]      not null default '{}',
  primary key (minute, domain)
);
create index atmosphere_minute_app_domain on public.atmosphere_minute_app (domain, minute desc);
comment on table public.atmosphere_minute_app is 'atpotato weather station: new records per app (NSID namespace as a domain, outside app.bsky/chat.bsky) per minute. Written by atpotato-weather. Public read. Long tail: roll up to hourly and prune once it grows.';

-- Hourly and daily rollups the website reads for long ranges. security_invoker, so a
-- reader goes through the tables' own policies.
create view public.atmosphere_hour with (security_invoker = true) as
  select date_trunc('hour', minute) as hour,
         sum(seconds_covered)::int as seconds_covered,
         sum(creates)::bigint as creates, sum(bluesky)::bigint as bluesky, sum(elsewhere)::bigint as elsewhere,
         sum(posts)::bigint as posts, sum(likes)::bigint as likes, sum(reposts)::bigint as reposts, sum(follows)::bigint as follows,
         sum(updates)::bigint as updates, sum(deletes)::bigint as deletes,
         sum(identity)::bigint as identity, sum(account)::bigint as account
  from public.atmosphere_minute group by 1;

create view public.atmosphere_day with (security_invoker = true) as
  select date_trunc('day', hour) as day,
         sum(seconds_covered)::int as seconds_covered,
         sum(creates) as creates, sum(bluesky) as bluesky, sum(elsewhere) as elsewhere,
         sum(posts) as posts, sum(likes) as likes, sum(reposts) as reposts, sum(follows) as follows,
         sum(updates) as updates, sum(deletes) as deletes, sum(identity) as identity, sum(account) as account
  from public.atmosphere_hour group by 1;

-- Public data, read-only to everyone; only the service role (the droplet) writes.
alter table public.atmosphere_minute enable row level security;
alter table public.atmosphere_minute_app enable row level security;
create policy "anyone can read" on public.atmosphere_minute for select using (true);
create policy "anyone can read" on public.atmosphere_minute_app for select using (true);

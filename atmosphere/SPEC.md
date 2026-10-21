# atpotato weather station

**Build brief. Self-contained: you should not need any other conversation to
work from this.**

## What you are building

A small always-on service that listens to the whole AT Protocol firehose and keeps
a running count of what goes by. It answers one question live ("what has the
atmosphere looked like for the last 60 seconds?") and writes a summary row every
minute to Supabase, so atpota.to can draw trends over hours, days and months.

It runs on the DigitalOcean droplet that already runs the mentions service
(`mentions/SPEC.md`), as a **separate process**. It holds no atproto credential and
never writes to the network; its only secret is a Supabase service key.

## Context you need

atpota.to has an "atmospheric conditions" tile on its home page and a full
**atmosphere weather report** at `/weather`. Today both come from
`website/server/atmosphere.ts`: a Vercel function opens Jetstream, listens for
5 seconds, counts, and the CDN caches that for a minute. Five seconds is a thin
sample (one bot can move the numbers a lot) and nothing is kept, so there are no
trends. A Vercel function can't hold a connection open for long, which is why
this service exists.

**`website/server/atmosphere.ts` is the reference implementation.** Its counting
rules (`eventOf`, `addEvent`, `summarize`, `isNsid`, `isBluesky`, `appDomain`,
`conditionFor`, `diversityLevel`) are what this service must reproduce exactly.
Copy them; they're short and tested in `website/tests/api-atmosphere.test.ts`. If
you change a rule, change it in both places.

## Architecture

```
Jetstream (public, no auth, no wantedCollections: everything)
        │
        ▼
  consumer ──► per-second buckets (in memory, last 3600 s, keyed by event time)
                    │                         │
                    │ every request           │ every minute, ~15 s after it ends
                    ▼                         ▼
           GET /v1/now (rolling 60 s)    Supabase: atmosphere_minute,
                    │                     atmosphere_minute_app
                    ▼                         │
     [vercel] /api/atmosphere            [vercel] /api/atmosphere/history
     (CDN-cached ~5 s)                   (reads Supabase, CDN-cached)
                    │                         │
                    └──────► atpota.to ◄──────┘
```

The droplet part (consumer, buckets, `/v1/now`, minute writer) is yours. The
Supabase tables are below as SQL. The Vercel side (proxying `/v1/now`, the
history endpoint, the charts) is done in the website and isn't part of this
brief.

## The consumer

- Connect to `wss://jetstream2.us-east.bsky.network/subscribe` with **no**
  `wantedCollections`, falling back to `jetstream1`. That's about 450–500
  events and 270 KB a second today. (Optional: `compress=true` cuts bandwidth a
  lot, but needs zstd with Jetstream's published dictionary. Not needed to start.)
- **Separate connection, separate process from the mentions consumer.** The
  mentions service filters to `app.bsky.feed.post` and posts publicly; don't
  widen its filter or share its process. A crash here must not take down replies.
- **Bucket by event time, not arrival time.** Each Jetstream message has
  `time_us`, but that's when Jetstream handled it: after a pause upstream, a
  backlog comes out stamped late. So a new record goes in the second its commit's
  `rev` (a TID its PDS stamped) says, clamped to `[time_us − 60 s, time_us]`; a
  `rev` over 5 min behind, or one that isn't a real time, falls back to `time_us`
  (`src/clock.js`). Coverage and the cursor still go by `time_us`. That way a
  reconnect that replays with `cursor` lands in the right seconds, and so does a
  backlog. (Added 2026-10-20, after jetstream2 paused for 25 s at 17:37.)
- **On reconnect**, resume with `cursor = last time_us seen − 2 s` (in
  microseconds) so nothing is lost, and **drop events you've already counted**:
  keep the highest `time_us` per second already counted, or simply ignore
  events at or before the last `time_us` you processed before the drop. Exact
  dedupe isn't worth much; not double-counting a replayed window is.
- Ignore events whose second is more than 3600 s old or more than 5 s in the
  future (clock skew).
- Reconnect with exponential backoff (1 s, 2 s, 4 s … max 30 s). Log every
  connect, disconnect and error as one JSON line.

### What to count, per second

The same rules as `eventOf`/`addEvent` in `website/server/atmosphere.ts`:

| Message | Counts as |
|---|---|
| `kind: "commit"`, `operation: "create"`, collection passes `isNsid` | one create in that collection |
| `kind: "commit"`, `operation: "update"` | one update |
| `kind: "commit"`, `operation: "delete"` | one delete |
| `kind: "identity"` | one identity event |
| `kind: "account"` | one account event |
| anything else, or a collection that fails `isNsid` | nothing |

A bucket is `{ second, creates: Map<nsid, count>, unnamed, updates, deletes,
identity, account }`. Cap a bucket at 2000 distinct collections; past that,
count creates in `unnamed` (that's `MAX_COLLECTIONS` in the reference).

Classifying a collection:

- **Bluesky** if it starts with `app.bsky.` or `chat.bsky.`. Everything else is
  **elsewhere**.
- Its **app** is its first two segments reversed: `sh.tangled.repo.pull` →
  `tangled.sh`, `fyi.unravel.frontpage.post` → `unravel.fyi`.

### Coverage

Track which seconds you were actually connected for. A second with no
connection is **missing**, not quiet: report it as such, and never count it as
zero. Every summary carries `seconds` (seconds actually covered), and the
website already shows "the sky is hard to read" when there's nothing.

## `GET /v1/now`: the last 60 seconds

Sum the last 60 **complete** seconds (stop at `now − 2 s`, so late events
have arrived) and answer with the same JSON shape as the website's `Reading`
(the `Reading` interface in `website/server/atmosphere.ts`), plus two fields.

```jsonc
{
  "measuredAt": "2026-10-20T16:18:00.000Z", // end of the window
  "seconds": 60,                            // seconds actually covered (≤ 60)
  "perSecond": { "posts": 51, "likes": 308, "reposts": 52.2, "follows": 24.1 },
  "condition": "stormy",
  "records": { "perSecond": 444, "bluesky": 436, "elsewhere": 8 },
  "diversity": { "index": 1.8, "level": "low", "share": 0.52, "spread": 12, "apps": 12, "collections": 40 },
  "apps": [ { "domain": "tangled.sh", "perSecond": 4, "count": 240, "collections": ["sh.tangled.repo"] } ],
  "bluesky": [ { "nsid": "app.bsky.feed.like", "perSecond": 308, "count": 18480 } ],
  "events": { "creates": 444, "updates": 3.6, "deletes": 13.5, "identity": 0.5, "account": 0.2 },

  // new:
  "window": { "from": "2026-10-20T16:17:00.000Z", "to": "2026-10-20T16:18:00.000Z" },
  // one entry per second in the window, oldest first, for live sparklines;
  // a missing second is null
  "series": [ { "t": 1792512960, "creates": 451, "bluesky": 449, "elsewhere": 2, "posts": 48 }, null ]
}
```

- Rates are `count / seconds`, one decimal. `diversity.index` is two decimals
  (`elsewhere / total * 100`). Up to 10 apps and 8 Bluesky collections, busiest
  first, exactly as `summarize` does. Simplest correct approach: merge the 60
  buckets into one tally and call your copy of `summarize(tally, seconds, …)`.
  (Changed 2026-10-21: the index goes by accounts now, not records, so one account
  writing a thousand records counts once. `share` is the percent of active accounts
  that wrote outside Bluesky, `spread` how many apps they're spread across as an
  effective number (e to the Shannon entropy of their accounts over apps), and
  `index = share × √spread`. `summarize` takes the window's accounts as a fourth
  argument; `diversityOf` in the reference.)
- `seconds < 30` → answer `503 {"error":"unavailable"}`. The website falls
  back to its own 5-second sampler.
- Headers: `content-type: application/json; charset=utf-8`,
  `cache-control: no-store` (Vercel does the caching).
- **Auth:** require `x-atpotato-weather-secret: <shared secret>` and answer
  401 without it. The data's public, but only Vercel should be calling this, and
  it keeps the droplet's load predictable.
- `GET /healthz` → `200 {"ok":true,"connected":true,"lagSeconds":1.2,"covered60":60}`
  with no auth, for uptime checks.
- Serve it over HTTPS on its own hostname (for example
  `weather.atpota.to`, Caddy in front of a localhost port).

Expected load: Vercel caches `/v1/now` for about 5 seconds, so this gets
roughly 12 requests a minute no matter how many people are watching.

## The minute writer

About 15 seconds after each minute ends, sum that minute's 60 buckets and write
one row to `atmosphere_minute` plus one row per app to `atmosphere_minute_app`.
Use **upsert** on the primary key, so a retry or restart never duplicates a
minute. If Supabase is down, keep unwritten minutes in memory (you have an hour
of buckets) and retry with backoff, oldest first.

Write a minute even if it's partly covered, with its real `seconds_covered`.
Skip it only when `seconds_covered = 0`.

## Supabase

Run this as one migration. Timestamps are UTC. Counts are raw counts, not
rates: rates and the index come from dividing, so rollups stay exact.

```sql
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

-- Hourly and daily rollups the website reads for long ranges.
create view public.atmosphere_hour as
  select date_trunc('hour', minute) as hour,
         sum(seconds_covered)::int as seconds_covered,
         sum(creates)::bigint as creates, sum(bluesky)::bigint as bluesky, sum(elsewhere)::bigint as elsewhere,
         sum(posts)::bigint as posts, sum(likes)::bigint as likes, sum(reposts)::bigint as reposts, sum(follows)::bigint as follows,
         sum(updates)::bigint as updates, sum(deletes)::bigint as deletes,
         sum(identity)::bigint as identity, sum(account)::bigint as account
  from public.atmosphere_minute group by 1;

create view public.atmosphere_day as
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
```

The share of new records outside Bluesky for any range is
`100.0 * sum(elsewhere) / nullif(sum(creates), 0)` (this was the diversity index until
2026-10-21; it goes by accounts now, from the sketches below), and a rate is
`sum(x) / sum(seconds_covered)`. Never average per-minute shares or indexes: a quiet
minute would count as much as a busy one.

PostgREST's aggregate functions are off on this project, so per-app sums over a range
come from read-only functions (applied):

- [`sql/atmosphere_top_apps.sql`](sql/atmosphere_top_apps.sql): `atmosphere_top_apps`, the
  first version of the busiest apps (superseded by `atmosphere_app_trends`; safe to drop
  once the website no longer calls it).
- [`sql/atmosphere_almanac.sql`](sql/atmosphere_almanac.sql): the almanac and the trends'
  extras. `atmosphere_day_app` keeps one row per app per UTC day, re-summed for yesterday
  and today every 10 minutes by the pg_cron job `atmosphere-day-apps`
  (`atmosphere_roll_up_day_apps`, which the public can't call), so long ranges and "first
  heard" stay quick as the minute rows grow. On top of it: `atmosphere_today(tz)`,
  `atmosphere_normal()`, `atmosphere_new_apps(since)`, `atmosphere_app_trends(...)`,
  `atmosphere_apps_over_time(since, bucket)` and `atmosphere_heatmap(tz, since)`.
- [`sql/atmosphere_accounts.sql`](sql/atmosphere_accounts.sql): active accounts (added
  after this brief; see README.md). Each minute's counts on its rows, and HyperLogLog
  sketches by minute, hour, day and month, merged by the station and the website, not
  by Postgres.

**Size.** `atmosphere_minute` is 1440 rows a day (about 0.5M a year, which is
fine to keep forever). `atmosphere_minute_app` is the long tail: expect tens of
apps a minute, so roughly 50k rows a day. Once there's real data, if that grows
too much, add an hourly app table and a pg_cron job that rolls up and deletes
minute-level app rows older than 30 days. Not needed on day one. (Done 2026-10-20:
[`sql/atmosphere_retention.sql`](sql/atmosphere_retention.sql), and README.md's
"What's kept".)

If the views get slow over years of data, turn `atmosphere_hour` into a table
filled by pg_cron. Its shape stays the same, so nothing downstream changes.

## Config

| Env var | What |
|---|---|
| `JETSTREAM_URLS` | comma-separated, default the two above |
| `PORT` | localhost port behind Caddy |
| `WEATHER_SECRET` | shared with Vercel (`ATMOSPHERE_STATION_SECRET` there) |
| `SUPABASE_URL` | project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | writes only; never leaves the droplet |

## Tests (required)

- Counting: the table above, including invalid NSIDs, and the 2000-collection
  cap going to `unnamed`. Reuse the cases in `website/tests/api-atmosphere.test.ts`.
- Bucketing by `time_us`: out-of-order events, events from 2 hours ago, events
  from the future.
- Reconnect with cursor: replayed events aren't counted twice.
- Rolling window: correct sums across 60 buckets; missing seconds lower
  `seconds` and show as `null` in `series`; under 30 covered seconds gives a 503.
- `/v1/now` matches `summarize` from the reference for the same tally
  (snapshot one).
- Minute writer: upsert is idempotent, a failed write is retried, and a
  minute with no coverage isn't written.
- Auth: no or wrong secret gives 401; `/healthz` is open.

## Done when

- `curl -H 'x-atpotato-weather-secret: …' https://weather.atpota.to/v1/now` returns
  a 60-second reading that matches the shape above.
- `/healthz` reports connected with lag under 3 s.
- `atmosphere_minute` gets a new row every minute, and `select * from
  atmosphere_day` shows today.
- The process survives `kill -9` (systemd restarts it), and after a restart
  there are no duplicate minutes.

Then tell the website side the hostname and the secret. It'll switch
`/api/atmosphere` to proxy `/v1/now` (keeping the 5-second sampler as a
fallback), make `/weather` update every few seconds with a live sparkline, and
add history charts (rolling 24 hours, daily, monthly) from Supabase.

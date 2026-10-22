# atpotato-weather

The atpotato weather station. It counts the whole AT Protocol firehose one second
at a time and answers "what has the atmosphere looked like for the last 60
seconds?" for atpota.to's home page tile and `/weather`. Every minute it also
writes one summary row to Supabase for the trend charts. It also counts **active
accounts**: how many different DIDs wrote anything, with HyperLogLog sketches, so
no DID is ever kept.

The brief is [`SPEC.md`](SPEC.md). The counting rules in `src/atmosphere.js` are
copied from [`website/server/atmosphere.ts`](../website/server/atmosphere.ts), and
the tests reuse its cases. **If you change a rule, change it in both places.**

It holds no atproto credential and never writes to the network. Its only secrets
are `WEATHER_SECRET` and the Supabase service key. It runs on the droplet next to
the mentions service, as its own process with its own Jetstream connection. See
[`droplet/README.md`](../droplet/README.md) for how code and data are laid out
there.

## Endpoints

Public, through nginx on `hook.atpota.to`:

| URL | Auth | Answer |
|---|---|---|
| `GET https://hook.atpota.to/weather/v1/now` | header `x-atpotato-weather-secret: $WEATHER_SECRET` | `200` the website's `Reading` plus `accounts`, `window`, `series` (one entry per second; `null` means missing) and `hosts` (below); `503 {"error":"unavailable"}` under 30 covered seconds; `401` without the right secret |
| `GET https://hook.atpota.to/weather/healthz` | none | `{"ok","connected","lagSeconds","covered60"}`: `200` when connected, lag is under 10 s and at least 30 of the last 60 s are covered; otherwise `503` |

The process listens on `127.0.0.1:8790` and serves `/v1/now` and `/healthz`.
nginx maps the two `/weather/...` paths onto those and 404s everything else.

The brief suggested `weather.atpota.to`, but that name resolves to the PDS's
wildcard record, not to the droplet. To move it there:

1. Add an A record for `weather` pointing to 143.244.172.52 at Namecheap.
2. Add a server block.
3. Run certbot.

```bash
curl -s -H "x-atpotato-weather-secret: $(grep ^WEATHER_SECRET= /root/atpotato-weather/.env | cut -d= -f2-)" https://hook.atpota.to/weather/v1/now
```

## How it counts

- **Jetstream v1, unfiltered.** It reads
  `wss://jetstream2.us-east.bsky.network/subscribe` with no `wantedCollections`,
  falling back to `jetstream1`. That's about 450 events/s and 240 KB/s inbound
  (~20 GB a day; DigitalOcean doesn't bill inbound). It uses v1, not the v2 that
  the mentions service uses, because the website's reference sampler reads v1.
- **Per-second buckets keyed by when each record was made**, kept for an hour
  (`src/clock.js`). Jetstream's `time_us` is when Jetstream handled an event; when it
  pauses, the backlog comes out together, stamped late. On 2026-10-20 jetstream2 sent
  nothing for 25 s from 17:37:35, then up to 2,100 events a second, so 17:37 read 263
  records/s and 17:38 read 642 around a steady ~450. A commit's `rev` is a TID its
  PDS stamped when the record was written, so a new record goes in the second its
  `rev` says. That's never later than `time_us`, and never more than 60 s before it.
  A `rev` more than 5 min behind is an old record arriving now (an import, a
  migration), and some `rev`s don't decode to a real time. Those, and identity and
  account events (no `rev`), go by `time_us`. Normally `rev` is about 0.15 s behind,
  so a calm day doesn't change. Events more than an hour old, or more than 5 s in
  the future, are ignored.
- **Coverage** goes by `time_us`, the stream's position. A second counts only if one connection saw all of it: from its
  first event (rounded up) to the second before its latest. A second with no
  coverage is *missing*, never zero.
- **Reconnects** resume 2 s before the last `time_us` seen, and drop events at or
  before it, so the overlap isn't counted twice. Backoff is 1, 2, 4 … 30 s. A
  failed attempt moves on to the other Jetstream. 15 s of silence counts as a dead
  socket.
- **The rolling window** is the 60 seconds ending 2 s ago. The buckets are merged
  into one tally and passed through the reference's `summarize`.

## Active accounts

Records say how much was written; active accounts say by how many. A bot writing a
thousand records a minute is a thousand records and one account.

- **Who counts:** the DID of every commit (create, update or delete) whose collection
  is an NSID. Identity and account events don't. A commit counts for **Bluesky** in
  `app.bsky.*` / `chat.bsky.*` and otherwise for **elsewhere** and its app (the same
  rules as records). Someone who likes a post and stars a repo is one active account,
  on both sides, so bluesky + elsewhere can be more than active.
- **How:** [`src/hll.js`](src/hll.js) is a HyperLogLog sketch with 4096 registers:
  4 KB however many accounts it holds, within about 1.6% (2% to be safe in copy),
  counted with Ertl's improved estimator. Each DID is hashed with SHA-256 and only
  the register update is kept. Sketches merge by taking each register's maximum, so
  minutes add up to hours, days and months, and merging the same minute twice changes
  nothing. Each second keeps its commits' register updates (about 7 MB an hour).
- **Live:** `/v1/now` has `accounts: { active, bluesky, elsewhere, index, apps }`
  for its 60 seconds. `index` is the share of active accounts that wrote elsewhere,
  and `apps` is the 10 apps with the most accounts. The website's fallback sampler
  has no accounts: a few seconds of accounts don't add up to a minute's.
- **The diversity index** goes by them, not by records (since 2026-10-21): one account
  writing a thousand records is one account. `diversity.share` is the percent of active
  accounts that wrote elsewhere; `diversity.spread` is how many apps they're spread
  across, as an effective number (e to the Shannon entropy of the apps' accounts: ten
  apps with as many accounts each is 10, one app with nearly everyone about 1); and
  `diversity.index = share × √spread` (`diversityOf` in `src/atmosphere.js`). A usual
  minute in October 2026 was about 2 (1.3 to 3 nineteen minutes in twenty): half a
  percent of the ~9,000 accounts active, across about 15 apps' worth. Under the old
  records share, minutes where one account wrote over a thousand records
  (titlegraph.org, techne.app) read 6 to 7; by accounts they read 2.4 to 2.7, in line
  with the minutes around them. The trends work it out bucket by
  bucket from the sketches' `dids` (`website/server/weather-accounts.ts`). The almanac's
  "a more mixed sky than usual" compares the last whole hour's index with the same hour
  on the days or weeks before (`weather-almanac.ts` `readDiversity`), and Poe's week
  against the week before compares each week's daily indexes, averaged. Both leave out
  what came from the archive (before 2026-10-20T16:50Z): it keeps about a fifth of the
  edits the station hears, so its hours read 0.29% of accounts elsewhere against the
  station's 0.48%, and would make every live hour look more mixed than usual.
- **Stored:** see "Minute rows" below and
  [`sql/atmosphere_accounts.sql`](sql/atmosphere_accounts.sql). The website merges
  and counts the stored sketches itself (`website/server/hll.ts`,
  `weather-accounts.ts`). Postgres can't do it: on this project, merging takes about
  70 ms a sketch in PL/pgSQL.

## PDS hosts

Jetstream doesn't say which PDS a commit came from, so the hosts aren't counted from the
firehose. Instead, every 10 minutes the station pages through the relay's own list of
them (`com.atproto.sync.listHosts` on `relay1.us-east.bsky.network`, the relay jetstream2
reads; `RELAY_URL` to change it): about 6,400 hosts in 7 pages, in about 2 s. It keeps the
last whole list; a page that fails fails that poll, and the last list stays. A list over
2 hours old isn't served. Nothing is written to Supabase.

`/v1/now` carries it as `hosts` (`src/hosts.js` `summarizeHosts`):

- `listed`: every host the relay knows, in any state; `active`: the ones it calls active,
  split into `bluesky` (`*.host.bsky.network`, Bluesky's ~90 "mushrooms") and
  `independent`. On 2026-10-22: 6,442 listed, 1,887 active, 90 Bluesky's.
- `writing`: active hosts whose `seq` (the last event the relay took from them) moved in
  the last hour, as `{ bluesky, independent, minutes }`. It's null until the station has
  polled twice, and `minutes` is under 60 for the first hour after a restart.
- `accounts`: the accounts on active hosts, by the relay's `accountCount` (accounts it
  hosts, not accounts active): 23.8 million on Bluesky's, 364k elsewhere.
- `diversity`: the **hosting diversity**, worked out like the diversity index but by where
  accounts live: `share` is the percent of accounts on independent hosts, `spread` is
  how many independent hosts they're spread across as an effective number (`spreadOf`),
  and `index = share × √spread`. Bluesky's hosts count as one place, the way `app.bsky.*`
  counts as one app. On 2026-10-22: 1.51% × √24.5 = 7.48. It is its own number on its
  own scale, not folded into the diversity index: that one is who's *writing* this
  minute, this is where accounts *live*, and mixing them would break the index's history
  and Poe's copy of its levels. `atproto.brid.gy` (Bridgy Fed's bridged accounts) is the
  biggest independent host and counts like any other.
- `top`: the 10 independent hosts with the most accounts.

## Minute rows

About a minute and a quarter after a minute ends, the station sums the minute's
covered seconds and upserts it. It waits until the stream is 60 s past the minute,
because a backlog after a pause can still add records to it. The rows:

- `atmosphere_minute`: one row of raw counts, plus `seconds_covered`, plus the
  minute's active accounts (`dids`, `dids_bluesky`, `dids_elsewhere`)
- `atmosphere_minute_app`: one row per app outside Bluesky, with its `dids`
- `atmosphere_account_sketch` / `atmosphere_account_app_sketch`, period `minute`:
  the minute's sketches (Bluesky and elsewhere, and one per app), as bytea

[`src/rollup.js`](src/rollup.js) also merges each minute into its UTC hour, day and
month, in memory, and rewrites those rows every 5 minutes and when they end. Each
row's `through` is the last minute merged into it. After a restart, the first minute
of each period reloads that period's row, then merges the minute rows after its
`through`. So a restart loses nothing, and a retry never counts a minute twice.
pg_cron (`atmosphere-prune-sketches`, hourly at :17) keeps minute sketches for 26 hours
(the last hour's apps and diversity index are compared with the same hour yesterday)
and apps' hour sketches for 30 days. Everyone's hours, days and months stay.

A partly covered minute is written with its real `seconds_covered`. A minute with
no coverage isn't written. Failed writes wait in memory and are retried oldest
first, with backoff.

`state.json`, in the data folder, keeps the last minute written. On start, the
station resumes Jetstream from just before the next minute, at most
`MAX_REPLAY_SECONDS` (30 min) back. A restart or `kill -9` therefore replays the
minutes it would have lost and never rewrites one it already wrote. This was
tested on 2026-10-20: after a `kill -9` mid-minute, that minute was still written
with 60/60 seconds.

The data is in the Supabase project **atpota.to** (`zdzjtziydmwkxbzlkwxv`). The
migration is in [`supabase/atmosphere_weather_station.sql`](supabase/atmosphere_weather_station.sql),
applied 2026-10-20. Besides the two tables, it adds views `atmosphere_hour` and
`atmosphere_day` (security_invoker). Anyone can read; only the service role
writes (RLS). The later SQL is in [`sql/`](sql/): the almanac, the accounts tables
([`atmosphere_accounts.sql`](sql/atmosphere_accounts.sql)), what's kept for how long
([`atmosphere_retention.sql`](sql/atmosphere_retention.sql)) and the steady counts that
keep one app's bulk import out of the weather
([`atmosphere_steady.sql`](sql/atmosphere_steady.sql)), all applied.
[`sql/atmosphere_accounts_cleanup.sql`](sql/atmosphere_accounts_cleanup.sql) drops a
first try at the accounts tables that was never used. It has **not** been run yet:
the Supabase connector holds DROPs for confirmation. For any range:

```sql
-- the index and rates over a range: divide sums, never average per-minute numbers
select 100.0 * sum(elsewhere) / nullif(sum(creates), 0) as index,
       sum(posts)::numeric / sum(seconds_covered)      as posts_per_second
from atmosphere_minute where minute >= now() - interval '24 hours';
```

## What's kept, and for how long

Everything kept is an exact sum, or a sketch that merges exactly. So keeping less
detail of old data never makes the report less accurate.
[`sql/atmosphere_retention.sql`](sql/atmosphere_retention.sql) has the details.

| Table | Kept | Size |
|---|---|---|
| `atmosphere_minute`: the whole firehose and its active accounts, each minute | forever | ~100 MB a year |
| `atmosphere_minute_app`: each app, each minute | 30 days | ~150 MB, flat |
| `atmosphere_hour_app`: each app, each hour | forever | ~80 MB a year |
| `atmosphere_day_app`: each app, each day | forever | small |
| `atmosphere_account_sketch`: everyone's active accounts | minutes 2 h; hours, days, months forever | ~50 MB a year |
| `atmosphere_account_app_sketch`: each app's | minutes 26 h, hours 30 days; days, months forever | ~25 MB a year |

The per-app minute rows were the long tail, about 23k rows (5 MB) a day.
pg_cron re-sums each hour of them into `atmosphere_hour_app` every 10 minutes
(`atmosphere-hour-apps`, at :01, :11 …). Once a day, `atmosphere-prune-minute-apps`
(04:23 UTC) deletes the ones over 30 days old. It deletes only rows whose hour is in
`atmosphere_hour_app` with the same total; anything else stays, to be looked at.

## Replaying and backfilling

`src/replay.js` recounts minutes from Jetstream's own history and rewrites them. Use
it to repair minutes a glitch got into, or to fill a gap. It counts exactly as the
live station does, and only rewrites a minute it heard whole (60/60 s), so it can't
overwrite a good minute with part of one. Run it with `--dry-run` first: that prints
each minute's counts and writes nothing.

```bash
cd /root/atpotato-weather && /opt/node22/bin/node --env-file=.env \
  /root/atpota-live/atmosphere/src/replay.js --from 2026-10-20T17:36Z --to 2026-10-20T17:40Z --dry-run
```

It rewrites a minute's row and all its app rows, then re-sums the hourly and daily
roll-ups (`atmosphere_hour_app`, `atmosphere_day_app`) from `--from` on. It's safe while the live station runs:
`--to` must be at least 3 minutes ago, and the station never goes back to a minute
it has written. It takes up to 48 hours a run, and reads about 6 minutes of history
in 30 s. Bluesky's hosts hang up on a long replay (on 2026-10-21, after about 95 s
and 300 MB); it says `jetstream hung up at …; picking it back up` and carries on from
there, counting nothing twice. It writes only once the whole window is read.

**How far back.** Jetstream keeps a lookback of about a day and a half on Bluesky's
hosts. Minutes before it come back partial, are listed, and are left alone.

**Older history** comes from Jetstream v2's archive, with `src/archive.js` (next
section).

**The repair on 2026-10-20.** 17:37 and 17:38 were recounted from jetstream2
(26,985 and 27,311 records, against 15,774 and 38,531 by `time_us`) and upserted.
Three stale app rows from before the recount are still under 17:38:
blacksky.community, tngl.sh and mycrab.space, 7 records that belong to 17:37. To
clear them, run `replay.js --from 2026-10-20T17:37Z --to 2026-10-20T17:39Z` here,
while those minutes are still inside Jetstream's lookback (before about
2026-10-22T05:00Z).

## Backfilling from the archive

`src/archive.js` fills minutes from Jetstream v2's archive
(<https://bsky.network/docs/jetstream-replay>): history older than the day and a
half `replay.js` can reach. It counts with the same code as the station and
`replay.js`, active accounts included, and writes the same rows an hour at a time,
so the website can't tell the difference except in one way, below.

**What the archive holds.** On 2026-10-20, Bluesky's us-east instance listed 7,542
segments, about 2 TB. Almost all of that (about 1.9 TB, 2026-10-02 to 2026-10-06
13:37Z) is a one-time crawl of every repo: records that already existed, stamped when
they were crawled. That's no history of activity, so `archive.js` refuses any range
that reaches into it. Since then the archive is the live stream, about 3.5 GB a day.
So the earliest it can fill is **2026-10-06 14:00Z**; before that, nothing official
has the history.

**Why archive minutes run a little low.** The server periodically rewrites older
segments to remove records that were deleted since (a like taken back, a post
deleted, a whole account deleted). As far as the archive knows, those were never
made, so a minute's creates come out a few percent below what the station would have
counted. For that reason `archive.js` leaves alone any minute that already has a row
(the station's own minutes are exact) unless you pass `--overwrite`. That also makes
a run that stopped safe to start again.

**Cost.** The API key is free. Downloads count against the key's byte allowance, which
Bluesky doesn't publish ([their rules](https://bsky.network/docs/jetstream-replay)). When
it runs out, the server answers 429 with a `Retry-After`; the SDK waits that long
(`archive.js` lifts its 30 s cap to 15 minutes) and resumes from its byte offset, so a
small allowance makes a run slower, not broken. It says when it's waiting.

**Once, on the droplet:**

1. Make a key at <https://bsky.network/account> and add it to `.env` as
   `JETSTREAM_API_KEY` (this reads it without echoing it, or putting it in the
   shell's history):

   ```bash
   cd /root/atpotato-weather && read -rsp 'paste the key: ' KEY && echo && printf 'JETSTREAM_API_KEY=%s\n' "$KEY" >> .env && unset KEY
   ```

2. Install the official SDK (`@bsky/jetstream`), pinned by `archive-sdk/`'s lockfile.
   It lives outside the release because deploys copy code only; the station itself
   has no dependencies:

   ```bash
   mkdir -p /root/atpotato-weather/jetstream-sdk && cp /root/atpota-live/atmosphere/archive-sdk/package*.json /root/atpotato-weather/jetstream-sdk/ \
     && (cd /root/atpotato-weather/jetstream-sdk && PATH=/opt/node22/bin:$PATH npm ci --ignore-scripts)
   ```

**Running it.** Do a dry run of one hour the station already has first, and compare
it with what the station wrote: that shows how far below the archive runs. It prints
one line an hour and writes nothing:

```bash
cd /root/atpotato-weather && nice -n 10 /opt/node22/bin/node --env-file=.env \
  /root/atpota-live/atmosphere/src/archive.js --from 2026-10-20T17:00Z --to 2026-10-20T18:00Z --dry-run
```

Then the real run, in `tmux` or `screen` since it takes hours (14 days is about
50 GB). It's safe while the station runs:

```bash
cd /root/atpotato-weather && nice -n 10 /opt/node22/bin/node --env-file=.env \
  /root/atpota-live/atmosphere/src/archive.js --from 2026-10-06T14:00Z --to 2026-10-20T16:50Z
```

It takes up to 31 days in one run, re-sums each UTC day's app roll-ups
(`atmosphere_hour_app`, `atmosphere_day_app`) as it finishes it, and ends with a summary: minutes written,
minutes left alone because they already existed, and any it didn't hear whole. If it
stops, run it again with `--from` at 00:00Z of the last day it printed, so that day's
account sketch comes out whole.

**Active accounts.** Archive minutes carry their `dids` counts like the station's.
For the trends it also writes hour and day sketches (`atmosphere_account_sketch`,
`atmosphere_account_app_sketch`), but only for an hour or day wholly inside
`--from`..`--to` that has no row yet: the station keeps rewriting today's and this
month's from memory, so the backfill never touches those, nor any the station wrote.
So with the run above, every hour from Oct 6 14:00 to Oct 20 16:00 and the days
Oct 7 to 19 get sketches; Oct 6 (a partial day), Oct 20 and October as a month count
only what the station heard.

**What it adds to Supabase.** For the 14 days above: about 20,000 minute rows
(6 MB, kept), about 320,000 minute app rows (75–80 MB, trimmed after 30 days once
their hours are in `atmosphere_hour_app`, as the station's are), the hour and day app
roll-ups, and a few MB of sketches. No schema changes. Everything before
2026-10-20T16:50Z came from the archive, so it can be taken out by time if ever
needed.

`--host` picks another v2 instance (default `https://jetstream.us-east.bsky.network`),
and `JETSTREAM_SDK_DIR` another SDK folder.

## Config

`/root/atpotato-weather/.env` on the droplet, mode 600. Start from
[`.env.example`](.env.example).

| Var | What |
|---|---|
| `WEATHER_SECRET` | shared with Vercel as `ATMOSPHERE_STATION_SECRET`; at least 32 chars |
| `PORT` | the localhost port, 8790 |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | the atpota.to project. Without both, the writer is off and `/v1/now` still works |
| `JETSTREAM_URLS` | comma-separated; defaults to the two above |
| `MAX_REPLAY_SECONDS` | how far back a cursor may reach (1800) |
| `RELAY_URL` | whose list of PDS hosts to count (`https://relay1.us-east.bsky.network`) |
| `STATE_FILE`, `LOG_LEVEL` | `state.json`, `info` |

## Running it

```bash
npm test                                         # node:test, 112 tests, about a second, no network
/root/atpota-live/deploy.sh atmosphere           # what a merge to main runs (via GitHub Actions)
systemctl status atpotato-weather
journalctl -u atpotato-weather -f -o cat         # one JSON line per event; "stats" every minute
journalctl -u atpotato-weather -o cat | grep 'minute written' | tail
```

A restart costs nothing. On start the station replays from Jetstream: the minutes
after the last one written, and at least the last 65 s, so `/v1/now` is complete
again within seconds. The unit is
[`atpotato-weather.service`](atpotato-weather.service), capped at MemoryMax=256M
and CPUQuota=50%. Measured on 2026-10-20: ~7% of one core and 30–70 MB.

**Falling behind.** A replay only helps if it runs faster than the live stream. With
the unit's half a core it can do about 7× on a quiet box, so even 30 minutes of
replay is back in about 5. On a busy box it may not keep up: on 2026-10-21, with the
archive backfill running alongside, it replayed at a fifth of real time, fell further
behind every second, and `/v1/now` had nothing to give for over an hour. So once the
stream is more than a minute behind, `src/jetstream.js` times how fast it's catching
up, and if it won't be back within 5 minutes it gives the replay up and reconnects at
the live tail. The live reading comes back at once; the minutes it skipped aren't
written (or are written partly covered), and it logs them:

```bash
journalctl -u atpotato-weather -o cat | grep 'skipping to the live tail'   # gapFrom, gapTo
```

Fill them with `src/replay.js` (above) while they're inside Jetstream's lookback.

## Files

```
src/atmosphere.js  counting rules (copy of the reference) + mergeTally
src/accounts.js    who counts as an active account, per-second lists, the reading's `accounts`
src/hll.js         HyperLogLog sketches: hashing, merging, counting, bytes
src/station.js     per-second buckets, coverage, rolling window, minute sums
src/jetstream.js   the connection: cursor, replay dedupe, fallback, backoff, stall and catch-up watchdogs
src/clock.js       when a record was made: its rev, within limits, else time_us
src/writer.js      minute rows, Supabase upserts, retries
src/rollup.js      accounts by hour, day and month: merged in memory, written every 5 minutes
src/supabase.js    PostgREST upserts and paged reads
src/replay.js      recount and rewrite minutes from Jetstream's history (repairs, gaps)
src/archive.js     backfill minutes from Jetstream v2's archive (older history)
src/hosts.js       the PDS hosts, from the relay's list every 10 minutes
src/server.js      /v1/now and /healthz
src/state.js       last minute written; where to resume after a restart
src/index.js       wiring, timers, stats line
supabase/          the migration as applied
sql/               the later ones (almanac, accounts)
```

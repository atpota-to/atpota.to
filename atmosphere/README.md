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
| `GET https://hook.atpota.to/weather/v1/now` | header `x-atpotato-weather-secret: $WEATHER_SECRET` | `200` the website's `Reading` plus `accounts`, `window` and `series` (one entry per second; `null` means missing); `503 {"error":"unavailable"}` under 30 covered seconds; `401` without the right secret |
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
- **Stored:** see "Minute rows" below and
  [`sql/atmosphere_accounts.sql`](sql/atmosphere_accounts.sql). The website merges
  and counts the stored sketches itself (`website/server/hll.ts`,
  `weather-accounts.ts`). Postgres can't do it: on this project, merging takes about
  70 ms a sketch in PL/pgSQL.

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
pg_cron (`atmosphere-prune-sketches`, hourly at :17) keeps minute sketches for 2 hours
(26 for apps: the last hour is compared with the same hour yesterday) and hour
sketches for 8 days. Days and months stay.

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
applied 2026-10-20. The accounts tables are in
[`sql/atmosphere_accounts.sql`](sql/atmosphere_accounts.sql), also applied 2026-10-20.
[`sql/atmosphere_accounts_cleanup.sql`](sql/atmosphere_accounts_cleanup.sql) drops a
first try at them that was never used. It has **not** been run yet: the Supabase
connector holds DROPs for confirmation. Besides the two tables, it adds views `atmosphere_hour` and
`atmosphere_day` (security_invoker). Anyone can read; only the service role
writes (RLS). For any range:

```sql
-- the index and rates over a range: divide sums, never average per-minute numbers
select 100.0 * sum(elsewhere) / nullif(sum(creates), 0) as index,
       sum(posts)::numeric / sum(seconds_covered)      as posts_per_second
from atmosphere_minute where minute >= now() - interval '24 hours';
```

`atmosphere_minute_app` is the long tail: tens of apps a minute, roughly 50k rows
a day. Once it grows, add an hourly app table and a pg_cron job that rolls up and
deletes app rows older than 30 days.

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

It rewrites a minute's row and all its app rows, then re-sums the daily roll-up
(`atmosphere_day_app`) from `--from` on. It's safe while the live station runs:
`--to` must be at least 3 minutes ago, and the station never goes back to a minute
it has written. It takes up to 48 hours a run, and reads about 6 minutes of history
in 30 s.

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
Bluesky doesn't publish. When it runs out, the server answers 429 and the SDK waits
and resumes from its byte offset, so a small allowance makes a run slower, not
broken. It says when it's waiting.

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

It takes up to 31 days in one run, re-sums each UTC day's app roll-up
(`atmosphere_day_app`) as it finishes it, and ends with a summary: minutes written,
minutes left alone because they already existed, and any it didn't hear whole. If it
stops, run it again with `--from` at 00:00Z of the last day it printed, so that day's
account sketch comes out whole.

**Active accounts.** Archive minutes carry their `dids` counts like the station's.
For the trends it also writes hour and day sketches (`atmosphere_account_sketch`,
`atmosphere_account_app_sketch`), but only for an hour or day wholly inside
`--from`..`--to` that has no row yet: the station keeps rewriting today's and this
month's from memory, so the backfill never touches those, nor any the station wrote.
Hours older than the 8 days hour sketches are kept aren't written. So with the run
above, the days Oct 7 to 19 and the last 8 days' hours get sketches; Oct 6 (a partial
day), Oct 20 and October as a month count only what the station heard.

**What it adds to Supabase.** For the 14 days above: about 20,000 minute rows
(6 MB), 320,000 app rows (75–80 MB), a few thousand `atmosphere_day_app` rows, and a
few MB of sketches. No schema changes. Everything before 2026-10-20T16:50Z came from
the archive, so it can be taken out by time if ever needed.

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
| `STATE_FILE`, `LOG_LEVEL` | `state.json`, `info` |

## Running it

```bash
npm test                                         # node:test, 80 tests, about a second, no network
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

## Files

```
src/atmosphere.js  counting rules (copy of the reference) + mergeTally
src/accounts.js    who counts as an active account, per-second lists, the reading's `accounts`
src/hll.js         HyperLogLog sketches: hashing, merging, counting, bytes
src/station.js     per-second buckets, coverage, rolling window, minute sums
src/jetstream.js   the connection: cursor, replay dedupe, fallback, backoff, stall watchdog
src/clock.js       when a record was made: its rev, within limits, else time_us
src/writer.js      minute rows, Supabase upserts, retries
src/rollup.js      accounts by hour, day and month: merged in memory, written every 5 minutes
src/supabase.js    PostgREST upserts and paged reads
src/replay.js      recount and rewrite minutes from Jetstream's history (repairs, gaps)
src/archive.js     backfill minutes from Jetstream v2's archive (older history)
src/server.js      /v1/now and /healthz
src/state.js       last minute written; where to resume after a restart
src/index.js       wiring, timers, stats line
supabase/          the migration as applied
sql/               the later ones (almanac, accounts)
```

# atpotato-weather

The atpotato weather station. It counts the whole AT Protocol firehose one second
at a time and answers "what has the atmosphere looked like for the last 60
seconds?" for atpota.to's home page tile and `/weather`. Every minute it also
writes one summary row to Supabase for the trend charts.

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
| `GET https://hook.atpota.to/weather/v1/now` | header `x-atpotato-weather-secret: $WEATHER_SECRET` | `200` the website's `Reading` plus `window` and `series` (one entry per second; `null` means missing); `503 {"error":"unavailable"}` under 30 covered seconds; `401` without the right secret |
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
- **Per-second buckets keyed by event time** (`floor(time_us / 1e6)`), kept for an
  hour. Events more than an hour old, or more than 5 s in the future, are ignored.
- **Coverage.** A second counts only if one connection saw all of it: from its
  first event (rounded up) to the second before its latest. A second with no
  coverage is *missing*, never zero.
- **Reconnects** resume 2 s before the last `time_us` seen, and drop events at or
  before it, so the overlap isn't counted twice. Backoff is 1, 2, 4 … 30 s. A
  failed attempt moves on to the other Jetstream. 15 s of silence counts as a dead
  socket.
- **The rolling window** is the 60 seconds ending 2 s ago. The buckets are merged
  into one tally and passed through the reference's `summarize`.

## Minute rows

About 15 s after a minute ends, once the stream has got past it, the station sums
the minute's covered seconds and upserts:

- `atmosphere_minute`: one row of raw counts, plus `seconds_covered`
- `atmosphere_minute_app`: one row per app outside Bluesky

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
npm test                                         # node:test, 43 tests, about a second, no network
/root/atpota-live/deploy.sh atmosphere           # deploy main: tests, switch, restart
systemctl status atpotato-weather
journalctl -u atpotato-weather -f -o cat         # one JSON line per event; "stats" every minute
journalctl -u atpotato-weather -o cat | grep 'minute written' | tail
```

A restart costs nothing, because it replays from Jetstream. The unit is
[`atpotato-weather.service`](atpotato-weather.service), capped at MemoryMax=256M
and CPUQuota=50%. Measured on 2026-10-20: ~7% of one core and 30–70 MB.

## Files

```
src/atmosphere.js  counting rules (copy of the reference) + mergeTally
src/station.js     per-second buckets, coverage, rolling window, minute sums
src/jetstream.js   the connection: cursor, replay dedupe, fallback, backoff, stall watchdog
src/writer.js      minute rows, Supabase upserts, retries
src/server.js      /v1/now and /healthz
src/state.js       last minute written; where to resume after a restart
src/index.js       wiring, timers, stats line
supabase/          the migration as applied
```

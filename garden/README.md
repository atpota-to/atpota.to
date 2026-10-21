# atpotato-garden

The garden's index: an AppView for the lexicons `to.atpota.garden.patch`,
`to.atpota.garden.sprout` and `to.atpota.garden.tend`
([`website/lexicons/to/atpota/garden/`](../website/lexicons/to/atpota/garden)), and for
Poe's pet counts, `to.atpota.poe.pets` at `self`
([`website/lexicons/to/atpota/poe/pets.json`](../website/lexicons/to/atpota/poe/pets.json)),
so the community garden can say who has petted Poe the most. It keeps
every such record on the network in Supabase, so the website reads one database instead
of asking Constellation which records link where and Slingshot for each one. Beside them
it **settles** each flower, once: what a mystery seed grew into, and the network weather
it was planted and grew in, with the shared rules in
[`website/shared/garden-rules.js`](../website/shared/garden-rules.js).

It holds no atproto credential and never writes to the network. Its only secret is the
Supabase service key. It runs on the droplet next to Poe and the weather station, as its
own process with its own Jetstream connection. See
[`droplet/README.md`](../droplet/README.md) for how code and data are laid out there.

The schema is [`supabase/garden_index.sql`](supabase/garden_index.sql): tables
`garden_records`, `garden_growth` and `garden_status`, the `garden_*` functions the
indexer calls with the service role, and the three the website calls with the
publishable key (`garden_sprouts`, `garden_tends`, `garden_growth_of`). Then
[`supabase/garden_leaderboard.sql`](supabase/garden_leaderboard.sql): `garden_records`
takes `to.atpota.poe.pets` too, and `garden_leaderboard` adds up the community garden's
boards for the website (`/api/leaderboard`): flowers (one a patch, unless it takes many),
tending for other people's flowers (once a flower a day, by the TID key), pets, kinds
grown to bloom, and visitors to people's own gardens.
Then [`supabase/garden_chat_pets.sql`](supabase/garden_chat_pets.sql): `garden_records`
takes `place.stream.chat.message` too, for **chat pets**: a "!pet" in dame.is's
[stream.place](https://stream.place) chat, where Poe sits in the stream overlay
(`website/src/overlay`). The index keeps only those messages, and only their `streamer`
and `createdAt`, never the words; the pets board adds one an hour for each person to their
`to.atpota.poe.pets` count. Reconcile doesn't list chat (there's far too much of it), so
chat pets are the stream's alone: reconcile never lists them and never deletes them.

## How it works

- **The stream.** One Jetstream **v2** connection
  (`/xrpc/network.bsky.jetstream.subscribeEvents?collections=to.atpota.garden.*&collections=to.atpota.poe.pets&collections=place.stream.chat.message&kinds=commit`),
  on `jetstream2.us-east`, falling back to `jetstream1`. Each commit becomes an upsert or
  a delete (`src/records.js`). A record that fails the shape checks (or that Postgres
  can't hold: a NUL, a lone surrogate, over 20,000 characters) is deleted from the index,
  so a record edited into junk leaves it. A create keeps the time Jetstream relayed it
  (`first_seen_at`); an update or a backfill never overwrites it.
- **Batches.** Events wait a second, keyed by URI so the last one wins, then go to
  `garden_apply` 500 at a time (at once at 200). Only once all of them are in does it save
  the Jetstream cursor (a `seq`, per host) to `state.json`. On failure everything stays
  pending and is retried with backoff (1 s to 30 s). A row Supabase refuses three times
  running is retried alone and dropped if it's still refused, so it can't jam the stream;
  the next reconcile puts back anything dropped by mistake.
- **Recycling, not a watchdog.** The garden is quiet: hours without a message are
  normal. So instead of treating silence as a dead socket, it reconnects every
  `RECYCLE_MINUTES` (flush, close, reconnect from the saved cursor; v2 replays from it,
  inclusive). Four failed opens in a row while holding a cursor means v2 no longer has it:
  the cursor is dropped and it starts from the live tail.
- **Reconcile** (`src/backfill.js`). Every repo with garden records: the relay's
  `listReposByCollection` for each collection, plus every repo the index already has
  (`garden_repos`). For each, four at a time: its PDS from its DID document (PLC, or
  `/.well-known/did.json` for did:web), `listRecords` for each collection, and a
  comparison with `garden_repo_uris`, read first: everything listed is upserted, and
  whatever the index held that the repo no longer lists is deleted. A repo that's gone
  (PLC 404 or 410; `RepoNotFound`, `RepoDeactivated`, `RepoTakendown`,
  `RepoSuspended`) is empty; any other failure leaves that repo alone (nothing deleted)
  and is logged. Records the stream touched during the pass are left to the stream. A
  pass runs on start if the last was more than `RECONCILE_HOURS` ago, every
  `RECONCILE_HOURS`, and whenever a connection opens without a cursor (a dropped cursor,
  a move to the other Jetstream, a first start), since there may be a gap. Then it sets
  `garden_status.backfilled_at`.
- **Settling** (`src/settle.js`), every `SETTLE_SECONDS`, from `garden_unsettled`:
  - *Planted.* The planting time is `createdAt`, unless it's missing or more than 10
    minutes from when Jetstream relayed the record; then the relay time. With neither,
    the record key's TID. Three minutes after planting it reads the weather station's
    minute (`garden_minute_weather`); with no reading it waits up to 30 minutes, then
    settles with no weather. A `seed` grows into `pickSpecies(flowerSeed(did, rkey),
    season, weather)`, the season being its patch's (or the planting date's); a kind the
    planter picked stays. Stored in `garden_growth` with the `RULE_VERSION`.
  - *Grown.* Seven days and ten minutes after planting, the week's hours
    (`garden_week_weather`) give `weekWeather` and the busiest apps outside Bluesky.
  - It doesn't settle anything until the first reconcile has finished, so a seed's patch
    (and its season) is in the index before the seed is settled.
- **Heartbeat.** Every 30 s, while connected with nothing pending, it upserts
  `garden_status` `heartbeat_at` (and `stream_at`, the Jetstream time of the newest event
  applied). The website reads the index only while the heartbeat is fresh.

## Endpoints

| URL | Answer |
|---|---|
| `GET http://127.0.0.1:8791/healthz` | `{"ok","connected","host","pending","lastFlushAt","lastStatusAt","backfilledAt","uptimeSeconds"}`: `200` when the Jetstream socket is open (or the process is under a minute old) and the last `garden_status` write succeeded within 2 minutes (or, in the first 2 minutes, none was tried yet); otherwise `503` |

Localhost only, for the deploy's health check. **No nginx block is needed**: the website
reads Supabase, never this process.

## Before the first deploy

The deploy ships code only. Until `/root/atpotato-garden/.env` exists, a deploy of
`garden` just says it isn't set up yet and succeeds, so merging first is safe. To set it
up:

1. The schema: [`supabase/garden_index.sql`](supabase/garden_index.sql), applied to the
   Supabase project **atpota.to** (`zdzjtziydmwkxbzlkwxv`) as migration `garden_index` on
   2026-10-20. A change to it goes in as a new migration: the next is
   [`supabase/garden_leaderboard.sql`](supabase/garden_leaderboard.sql), as migration
   `garden_leaderboard`, which has to be in before the indexer that keeps pets deploys.
   Until then Postgres refuses every pets row: the stream drops each one after three
   tries, and a reconcile can't apply anything from a repo that has one, its garden
   records included.
2. On the droplet:
   ```bash
   mkdir -p /root/atpotato-garden && chmod 700 /root/atpotato-garden
   grep -E '^SUPABASE_(URL|SERVICE_ROLE_KEY)=' /root/atpotato-weather/.env > /root/atpotato-garden/.env
   chmod 600 /root/atpotato-garden/.env
   ```
   (the same two values as the weather station; see [`.env.template`](.env.template)).
3. Merge to `main`, or if it's already merged, run `/root/atpota-live/deploy.sh garden`.
   The first deploy installs and enables `atpotato-garden.service`, starts it, and the
   first reconcile fills the index within a minute or so.
4. Optional, like the other services: links so `npm` works from the data folder.
   ```bash
   cd /root/atpotato-garden && for f in src test package.json README.md; do ln -sfn /root/atpota-live/garden/$f $f; done
   ```

## The website's switch

The website reads the garden from wherever Vercel's `GARDEN_SOURCE` says (that code is in
`website/server/`, not here): `constellation` (Constellation and Slingshot, as before),
then `shadow` (serves the network's garden and logs where the index differs), then
`index` (`garden_sprouts`, `garden_tends`, `garden_growth_of`). Even at `index` it reads
the index only while `heartbeat_at` is a few minutes fresh and `backfilled_at` is set,
and falls back to the network otherwise. Move it along one step at a time, once the
first reconcile has finished and the shadow logs are quiet.

## Config

`/root/atpotato-garden/.env` on the droplet, mode 600. Start from
[`.env.template`](.env.template).

| Var | What |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | required: the atpota.to project, service role (same as the weather station's) |
| `JETSTREAM_HOSTS` | comma-separated v2 hosts; `wss://jetstream2.us-east.bsky.network,wss://jetstream1.us-east.bsky.network` |
| `RELAY_URL` | for `listReposByCollection`; `https://relay1.us-east.bsky.network` |
| `PLC_URL` | `https://plc.directory` |
| `HOST`, `PORT` | `127.0.0.1`, `8791` |
| `STATE_FILE` | `state.json`: `{ cursors: { host: seq }, backfilledAt }` |
| `RECONCILE_HOURS` | `6` |
| `RECYCLE_MINUTES` | `15` |
| `SETTLE_SECONDS` | `30` |
| `LOG_LEVEL` | `info` |

## Running it

```bash
npm test                                         # node:test, no network, under a second
/root/atpota-live/deploy.sh garden               # what a merge to main runs (via GitHub Actions)
systemctl status atpotato-garden
journalctl -u atpotato-garden -f -o cat          # one JSON line per event; "stats" every 5 minutes
journalctl -u atpotato-garden -o cat | grep -E 'reconciled|flower (settled|grown)' | tail
curl -s http://127.0.0.1:8791/healthz
```

**A reconcile by hand** (safe while the service runs; it writes `backfilled_at` but not
`state.json`, and exits 1 if any repo couldn't be listed):

```bash
cd /root/atpotato-garden && /opt/node22/bin/node --env-file=.env /root/atpota-live/garden/src/backfill-once.js
```

To make the service itself reconcile now, delete `backfilledAt` from `state.json` (or
the file: it only costs a reconcile) and `systemctl restart atpotato-garden`.

A restart costs nothing: on start it resumes from the saved cursor. The unit is
[`atpotato-garden.service`](atpotato-garden.service), capped at MemoryMax=128M and
CPUQuota=25%.

## Files

```
src/records.js      the four collections; a record as a row, a Jetstream v2 event as an upsert or delete
src/jetstream.js    the connection: v2 URL, cursors per host, failover, stale cursors, recycling
src/indexer.js      the batcher: last event per URI, garden_apply in chunks, cursors saved after success
src/backfill.js     the reconcile: relay + index repos, DID documents, listRecords, compare and apply
src/settle.js       planting time, species and weather (website/shared/garden-rules.js), the grown week
src/supabase.js     PostgREST: rpc, upsert, patch
src/state.js        state.json: cursors and the last reconcile
src/server.js       /healthz
src/index.js        wiring, heartbeat, stats line, shutdown
src/backfill-once.js  `npm run backfill`: one reconcile, then exit
supabase/           the migrations (garden_index, then garden_leaderboard)
```

# The droplet

Two services in this repo run on the DigitalOcean droplet `jetstream-consumer`
(143.244.172.52), behind nginx on `hook.atpota.to`:

| Folder | Unit | What it does |
|---|---|---|
| [`mentions/`](../mentions) | `atpotato-mentions` | Poe's Bluesky replies: watches for mentions, gates them, asks the agent in `bot/`, gates the draft, posts. Holds the only atproto write credential. |
| [`atmosphere/`](../atmosphere) | `atpotato-weather` | The weather station: counts the whole firehose and serves `/weather/v1/now`. Writes a row a minute to Supabase. |

Other things on the box (the anisota, tracker, turtleme.at and dame.is consumers,
knot.atpota.to) don't come from this repo.

## Layout

Code and data are kept apart. Code comes from git, and nothing on the droplet
edits it. Secrets and live state never go into git.

```
/root/atpota-live/                code, installed by deploy.sh
  repo.git/                       bare clone of atpota-to/atpota.to (fetches over https, can't push)
  releases/<sha>/                 one plain copy per deployed commit: mentions/ atmosphere/ droplet/ REVISION
  mentions -> releases/<sha>/mentions
  atmosphere -> releases/<sha>/atmosphere
  deploy.sh -> releases/<sha>/droplet/deploy.sh
  logs/                           test output from each deploy

/root/atpotato-mentions/          data: .env, mentions.db, gates.json, KILL, backups/
/root/atpotato-weather/           data: .env, state.json
```

Each unit's `WorkingDirectory` is its data folder, so relative paths (`.env`, the
database, `gates.json`, `state.json`) resolve there. `ExecStart` points into
`/root/atpota-live`. Inside each data folder, `src`, `test`, `scripts`,
`package.json` and `README.md` are links to the live release, so `npm run stats`,
`npm test` and the rest still work from there.

## Deploying

Push to `main`, then on the droplet:

```bash
/root/atpota-live/deploy.sh atmosphere      # weather station: safe any time, a restart replays from Jetstream
/root/atpota-live/deploy.sh mentions        # Poe: check nothing is in flight first
```

The script:

1. fetches
2. unpacks the commit into `releases/<sha>/`
3. runs that service's tests there; if they fail, nothing changes
4. installs the unit file if it changed
5. switches the link
6. restarts the one unit
7. prunes old releases, keeping the newest 5 and any a link points at

It prints what changed in that service since the release it replaces.

**Rolling back** means deploying an older commit:
`deploy.sh mentions <sha>`. Any branch or commit on GitHub works the same way,
for trying something before it merges.

`git -C /root/atpota-live/repo.git log -1 $(cat /root/atpota-live/mentions/../REVISION)`
shows exactly what's live.

## What never goes in git

Each service's `.gitignore` covers these. Keep it that way.

- `.env` and its backups (app password, shared secrets, Supabase service key)
- `mentions.db*` (who Poe talked to and what was said)
- `gates.json` (Poe's live-tuned thresholds; the defaults are `GATE_DEFAULTS` in
  `mentions/src/config.js`)
- `KILL`, `backups/` and `state.json`

To change a secret or a threshold, edit it in the data folder on the droplet.
`gates.json` reloads on its own; a `.env` change needs
`systemctl restart <unit>`.

## nginx

`/etc/nginx/sites-available/hook.atpota.to` forwards only exact paths
(`location =`) and 404s the rest. A new endpoint needs its own block, or it fails
silently. The list for each service is in its README, under "nginx" or "Endpoints".

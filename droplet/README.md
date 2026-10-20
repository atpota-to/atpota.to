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
  ci-deploy.sh -> releases/<sha>/droplet/ci-deploy.sh   what GitHub's deploy key is pinned to
  logs/                           deploys.log, plus test output from each deploy

/root/atpotato-mentions/          data: .env, mentions.db, gates.json, KILL, backups/
/root/atpotato-weather/           data: .env, state.json
```

Each unit's `WorkingDirectory` is its data folder, so relative paths (`.env`, the
database, `gates.json`, `state.json`) resolve there. `ExecStart` points into
`/root/atpota-live`. Inside each data folder, `src`, `test`, `scripts`,
`package.json` and `README.md` are links to the live release, so `npm run stats`,
`npm test` and the rest still work from there.

## Deploying

**Merge to `main`. That's it.** The workflow `.github/workflows/deploy-droplet.yml`
runs on every push to `main` that touches `mentions/`, `atmosphere/` or `droplet/`.
It asks the droplet to deploy both services at that commit, and the droplet does
this for each one:

1. Fetches the commit from GitHub and unpacks it into `releases/<sha>/`.
2. Skips the service if its folder hasn't changed since the release it's running.
3. Runs the service's tests there. If they fail, nothing changes and the run goes
   red.
4. For Poe, waits until no reply is in flight (`npm run in-flight`). If Poe is still
   busy after 10 minutes, it gives up without restarting and the run goes red; run
   it again later.
5. Switches the link, installs the unit file if it changed, and restarts that one
   unit.
6. Checks health (Poe's `/health`, the station's `/healthz`) for up to 90 s. If
   either is unhealthy, it switches back to the previous release by itself, and the
   run goes red.

The output shows up in the Actions tab, and GitHub emails you about failures.
Deploys run one at a time.

**Rolling back or redeploying:** go to Actions → Deploy droplet → Run workflow,
choose the service, and give it an older commit on `main`. Or, on the droplet:

```bash
/root/atpota-live/deploy.sh mentions <sha>          # any commit or branch on GitHub
FORCE=1 /root/atpota-live/deploy.sh atmosphere      # restart even if nothing changed
cat /root/atpota-live/logs/deploys.log              # every deploy, one line each
```

### The deploy key

The repo secret `DROPLET_DEPLOY_KEY` holds the private half of an ed25519 key. The
public half is in `/root/.ssh/authorized_keys` on the droplet:

```
restrict,command="/root/atpota-live/ci-deploy.sh" ssh-ed25519 AAAA… github-actions-deploy atpota-to/atpota.to
```

`restrict` rules out a shell, port forwarding and a pty. `command=` means that
whatever the client asks to run, [`ci-deploy.sh`](ci-deploy.sh) runs instead.
That script accepts only `<mentions|atmosphere> [<full sha on main>]` and calls
`deploy.sh`, which fetches the code from GitHub itself. So the key can redeploy
what's already on `main`, and nothing more. The workflow also pins the droplet's
SSH host key.

To replace the key: generate a new pair, swap the line in `authorized_keys`, and
update the secret.

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

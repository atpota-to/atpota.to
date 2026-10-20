# Working on the droplet services (`mentions/`, `atmosphere/`)

**Merging to `main` deploys.** A push to `main` that changes code in `mentions/` or
`atmosphere/` restarts that service on the droplet within a couple of minutes,
through `.github/workflows/deploy-droplet.yml` and `droplet/deploy.sh`.
`mentions/` is Poe's live Bluesky reply bot at stage 4, so it posts in public. Work
on a branch and merge by PR. Changes to only `.md` or `.sql` files don't restart
anything.

The droplet runs the tests before it switches, and rolls back if the health check
fails. Run them first anyway; they need no network and no secrets:

```bash
cd mentions && npm test      # Node >= 22.5 (node:sqlite)
cd atmosphere && npm test    # Node >= 22.4
```

**The deploy ships code only.** Anything the new code depends on has to be in place
on the droplet *before* it merges. Otherwise the deploy fails its health check and
rolls back, or worse, the code fails quietly later. The operator does these steps on
the droplet, so say which ones a change needs:

- **A new env var:** add it to `/root/atpotato-mentions/.env` (or
  `/root/atpotato-weather/.env`), and to `.env.template` / `.env.example` here.
- **A new HTTP endpoint** that the agent or the website calls: add its own
  `location =` block in `/etc/nginx/sites-available/hook.atpota.to`. nginx 404s
  every path it doesn't list.
- **A Supabase schema change:** apply the migration first, and keep the SQL in the
  folder.
- **A gates threshold:** edit `gates.json` on the droplet; it reloads on its own.
  The defaults are `GATE_DEFAULTS` in `mentions/src/config.js`.

Other rules:

- **The repo is public.** Never commit `.env`, `mentions.db`, `gates.json`,
  `backups/` or `state.json`; the `.gitignore` files cover them.
- **`mentions/` holds the only atproto write credential.** Every reply decision is a
  code conditional in `src/gates/`, never a prompt rule. Read `mentions/README.md`
  before touching the gates or the pipeline.
- **The counting rules are shared.** `atmosphere/src/atmosphere.js` copies them from
  `website/server/atmosphere.ts`; change both together.
- **To see what deployed:** check the run in the Actions tab, or
  `/root/atpota-live/logs/deploys.log` on the droplet. `droplet/README.md` has the
  whole layout, rollbacks, and the deploy key.

# atpotato

[atpota.to](https://atpota.to) · [bluesky](https://bsky.app/profile/atpota.to) · [tangled](https://tangled.sh/@atpota.to) · [github](https://github.com/atpota-to)

making the atmosphere a little more fun. atpotato is a small studio building apps,
tools and guides for the open network bluesky is built on. made with care, and a
little mischief.

this repo is atpota.to itself, and poe, the potato who lives there.

## projects

- [anisota](https://anisota.net): a moth-themed bluesky client that deals your feed out as a deck of cards
- [aturi](https://aturi.to): open any atproto link in the app you actually use, and peek at the records behind any account
- [flushes](https://flushes.app): the internet's bathroom. a tiny, silly social app for status updates from the throne
- [turtle meat](https://turtleme.at): an old school runescape sea turtle game. fish, cook and trade on a live grand exchange, with a global chat on atproto

## what's in here

| folder | what it is |
| --- | --- |
| [`website/`](website/) | atpota.to: a Vite multi-page site with Vercel Functions behind it |
| [`bot/`](bot/) | Poe, an [eve](https://eve.dev) agent on Vercel. Answers on Bluesky as [@poe.atpota.to](https://bsky.app/profile/poe.atpota.to), chats on the website, and writes the weekly dispatch |
| [`mentions/`](mentions/) | The droplet service that watches Bluesky for mentions, gates them in code, and posts Poe's replies. Holds the only atproto write credential |
| [`atmosphere/`](atmosphere/) | The weather station, a second droplet service that keeps a rolling 60-second count of the firehose (`hook.atpota.to/weather/v1/now`) and writes a minute-by-minute history to Supabase for `/weather` |
| [`droplet/`](droplet/) | How those two run on the droplet. Merging to `main` deploys them through GitHub Actions |
| [`agent-spec/`](agent-spec/) | The planning documents Poe was built from. Historical: where they disagree with `bot/`, `bot/` wins |
| [`branding/`](branding/) | Avatars, the mascot, the OG image and the brand proposal |

## how it fits together

```
bluesky mention ──► droplet ──► bot  POST /bluesky/mention ──► draft ──► droplet ──► reply on bluesky
site chat       ──► website  /api/poe ──► bot  POST /website/chat ──► streamed answer ──► the chat panel
```

- **Poe can't post.** The bot has no atproto credential and no write tool. It
  writes drafts and proposals (a reply, a like, a dispatch announcement), and the
  droplet, which holds the only credential, decides in code whether each one goes
  out. A successful prompt injection should end as a draft the droplet rejects.
- **Poe reads the Atmosphere** through [Aturi's MCP server](https://aturi.to/mcp),
  which is public and read-only, plus a few tools of its own in `bot/agent/tools/`.
- **Poe reads the weather** with `read_weather`, from the same public endpoints
  `/weather` uses (`/api/atmosphere`, `/api/weather-history`, `/api/weather-almanac`):
  the last minute, today against usual, or the past week with an outlook. It writes
  the dispatch's weather section from the week
  ([`bot/agent/skills/dispatch-weather.md`](bot/agent/skills/dispatch-weather.md)).
- **The website keeps no database.** The blog, gardens, comments and
  subscriptions are records in people's own repos, read through public
  infrastructure: plc.directory, the Bluesky AppView, Jetstream,
  [Constellation](https://constellation.microcosm.blue) and
  [Slingshot](https://slingshot.microcosm.blue).
- **Signing in** uses atproto OAuth in the browser
  ([`public/oauth-client-metadata.json`](website/public/oauth-client-metadata.json)).
  To tell Poe who is chatting, the browser asks the visitor's PDS for a
  service-auth token scoped to `to.atpota.poe.chat`, and the website verifies it
  ([`server/identity.ts`](website/server/identity.ts)). Removing someone's notes
  uses its own scope, `to.atpota.poe.forget`, so a chat token can never wipe them.

## the website

### pages

| path | what's there |
| --- | --- |
| `/` | The projects, the guide, "atmospheric conditions" (the last minute of the firehose, from the weather station), the latest posts from atpotato, poe, anisota and aturi, and a link to the community garden |
| `/weather` | The atmosphere weather report: how busy Bluesky is, the diversity index (how much of the network isn't Bluesky, by the share of active accounts writing with other apps and how many apps they're spread across, so one busy account counts once), which of those apps are busiest, and the last minute's events and active accounts, live every few seconds; trends over the last hour, 24 hours, 7 days and 30 days, by records or by accounts; an almanac: today's high and low, busier or quieter than usual, new apps, and when the sky is busiest; weather alerts from Poe, in a chat bubble by the corner potato, when a new app blows in, a storm rolls in or the sky gets more mixed; and a sky that gets cloudier with the diversity index |
| `/guides`, `/guides/bluesky-for-brands` | The guides. Written in markdown under `public/guides/`, and also published as a [standard.site](https://standard.site) publication in atpota.to's repo |
| `/blog` | Poe's atmosphere dispatch, a weekly roundup written in [Leaflet](https://leaflet.pub) ([poe.leaflet.pub](https://poe.leaflet.pub)) and server-rendered here from its standard.site records. Readers can sign in to comment, recommend and subscribe (with Bluesky, or by email through Leaflet). Atom feed at `/blog/feed.xml` |
| `/garden`, `/garden/<handle>` | Gardens. `/garden` (where the nav goes) is the community garden, atpotato's seasonal patch, one flower each; signed in, it has a button to your own. Tend your neighbours' flowers, or set up a garden of your own and choose whether visitors plant one flower each or as many as they like |
| `/settings` | Signed-in visitors can make Poe forget them |

The wordmark in the header sits in a little sky with the weather in it: a sun whose
rays turn faster when the network is busy, and a cloud or two as the diversity index
climbs. Poe's chat panel sits in the corner of every page. Click it, press `/` anywhere,
or highlight a word in a guide to ask about it.

### functions

Each file in `website/api/` is a thin Vercel Function entry point. The logic lives
in `website/server/`, so Vercel only builds the entry points.

| function | what it answers |
| --- | --- |
| `api/poe.ts` | `POST` streams one chat turn from the bot as server-sent events. `DELETE` ends the conversation, or with a forget token, empties Poe's notes about the visitor |
| `api/blog.ts` | The `/blog` pages, the Atom feed, and the standard.site `/.well-known` verification (`vercel.json` rewrites these here) |
| `api/garden.ts` | One garden's patches and flowers |
| `api/gardener.ts` | One person's garden page: their garden, the flowers they've planted anywhere, the tending they've given, their pets for Poe, and how many notes Poe keeps about them |
| `api/latest.ts` | The home page's "latest" feed |
| `api/atmosphere.ts` | The weather station's rolling 60 seconds, for the home page's "atmospheric conditions" and `/weather` (cached 5 seconds; needs `ATMOSPHERE_STATION_SECRET`). Without the station it samples a few seconds of Jetstream itself, and one sample serves everyone for a minute |
| `api/weather-history.ts` | The trends on `/weather`, from the station's minute rows in Supabase (public, read with the publishable key): records a second, active accounts and the diversity index they make, and apps heard over a range, and the busiest apps with how each did against a day (or month, or year) earlier |
| `api/weather-almanac.ts` | The almanac on `/weather`, in the reader's time zone: today's high and low, the last hour against usual, apps heard for the first time, and the week as a heat map |

### layout

| folder | what it holds |
| --- | --- |
| `src/` | Browser code: page scripts, the Poe widget (`src/poe/`), the blog's sign-in and comments (`src/blog/`), styles, partials and assets |
| `server/` | Function logic, shared by `api/` and the tests |
| `build/` | Vite plugins: shared partials, guide markdown, the guides publication, and `api-middleware.ts`, which runs `api/*.ts` and the `vercel.json` rewrites under `vite dev` |
| `lexicons/` | The garden's record types: `to.atpota.garden.patch`, `.sprout` and `.tend` |
| `scripts/` | Publishing and OG card scripts (below) |
| `public/` | Static files, the guide markdown and screenshots, and the committed OG cards |
| `tests/` | Vitest suites |

### running it

```bash
cd website
npm install
echo POE_MOCK=1 > .env.local   # a fake Poe, so the chat works without the bot
npm run dev
```

`/api/*` and the blog work under `npm run dev` too, against the live network.
Without `POE_MOCK=1`, the chat needs `WEBSITE_SHARED_SECRET` and a reachable bot
(see [environment](#environment) below).

```bash
npm run typecheck
npm test
npm run build
```

### scripts

These write records to atpota.to's repo. Each takes `--dry-run`, and a real run
needs an app password, never the main one:
`ATP_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx npm run <script>`.

| script | what it does |
| --- | --- |
| `npm run publish:guides` | Publishes the guides' standard.site records from the markdown in `public/guides/` |
| `npm run garden:patches` | Writes the current season's community patch and the next three, so one is always open. `--overflow <season>` adds a second patch for a season that filled up |
| `npm run og` | Renders the Open Graph cards into `public/og/` with headless Chromium. Needs `npx playwright install chromium-headless-shell` once. The Vercel build runs it too, and keeps the committed cards if it fails |

### environment

Each file listed here documents its variables at the top, and is the source of
truth for them.

| variable | what it does |
| --- | --- |
| `WEBSITE_SHARED_SECRET` | Required for the chat. Must match the bot's |
| `POE_AGENT_URL` | The bot's URL. Default `https://atpotato-bot.vercel.app` |
| `POE_MOCK=1` | The fake Poe. Ignored in production |
| `POE_CHAT_DISABLED=1`, `POE_IDENTITY_DISABLED=1` | Kill switches: turn the chat off, or ignore sign-ins so every chat is anonymous |
| `POE_RATE_LIMIT_ID`, `POE_UPSTREAM_TIMEOUT_MS` | An optional Vercel Firewall rate limit, and the per-turn timeout |
| `BLOG_*` | Which publication `/blog` shows, and kill switches for comments and email sign-up |

The chat and identity variables are in [`server/config.ts`](website/server/config.ts),
and the `BLOG_*` ones are in [`server/blog/config.ts`](website/server/blog/config.ts).

### deploying

The site is a Vercel project with `website/` as its root directory.
[`vercel.json`](website/vercel.json) has the build, the rewrites and the
function limits.

## poe

Poe is one potato in a few places, with the same memory in each:

- **on bluesky** as [@poe.atpota.to](https://bsky.app/profile/poe.atpota.to).
  Mention it and the droplet hands the post to the bot. Its answer comes back as
  a draft for the droplet to check and post.
- **in the chat panel on atpota.to.** A visitor who signed in is the same person
  Poe knows from Bluesky.
- **in poe's atmosphere dispatch**, the weekly roundup at
  [atpota.to/blog](https://atpota.to/blog).
- **in private DMs** with the people who run it.

Poe keeps short notes about the people it talks to, keyed on their DID, so it can
skip explanations they don't need. The notes are public, published in Poe's own
repo, and anyone can clear theirs at [atpota.to/settings](https://atpota.to/settings).

### the bot's channels

| route | who calls it |
| --- | --- |
| `POST /bluesky/mention` | The droplet, for each mention it decides to answer |
| `POST /api/scan-approval/respond` | The droplet, relaying an operator's yes or no to a collection scan that needs more than the default 10 pages |
| `POST /operator/dm` | The droplet, for private DMs from operators |
| `POST /website/chat`, `POST /website/forget` | atpota.to's `/api/poe` |

Every caller sends a shared secret. The routes live in `bot/agent/channels/`.

### changing how poe sounds

- [`bot/agent/instructions.md`](bot/agent/instructions.md): who Poe is, its rules, and its voice
- [`bot/agent/skills/bluesky-reply.md`](bot/agent/skills/bluesky-reply.md): the Bluesky format and sample replies
- [`bot/agent/skills/dispatch-weather.md`](bot/agent/skills/dispatch-weather.md): the dispatch's weather section and outlook
- [`bot/agent/instructions/operator-dm.ts`](bot/agent/instructions/operator-dm.ts): private DMs

### running it

The bot needs Node 24.

```bash
cd bot
npm install
npx eve link                     # pick the Poe project; pulls model credentials into .env.local
npx eve dev                      # chat locally, as if on Bluesky. Nothing is posted
node --test tests/*.test.mjs
npm run typecheck
npx eve eval                     # voice and safety evals. Each run makes real model calls
npx eve deploy
```

[`bot/README.md`](bot/README.md) covers local voice testing, the evals, and
sending a fake mention through the real Bluesky route. The model is set by
`AGENT_MODEL` and `AGENT_REASONING` (see [`agent/lib/model.ts`](bot/agent/lib/model.ts)).
The droplet is reached through `DROPLET_SHARED_SECRET` and `DROPLET_CALLBACK_URL`,
and the website through `WEBSITE_SHARED_SECRET`.

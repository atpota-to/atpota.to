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
| [`garden/`](garden/) | The garden's index, a third droplet service that follows the garden records (and Poe's pet counts) on Jetstream, keeps them in Supabase, settles what each mystery seed grows into from the network weather, and adds up the leaderboards |
| [`droplet/`](droplet/) | How those three run on the droplet. Merging to `main` deploys them through GitHub Actions |
| [`agent-spec/`](agent-spec/) | The planning documents Poe was built from. Historical: where they disagree with `bot/`, `bot/` wins |
| [`branding/`](branding/) | Avatars, the mascot, the OG image and the brand proposal |

## how it fits together

```
bluesky mention ──► droplet ──► bot  POST /bluesky/mention ──► draft ──► droplet ──► reply on bluesky
site chat       ──► website  /api/poe ──► bot  POST /website/chat ──► streamed answer ──► the chat panel
weather moment  ──► droplet ──► bot  POST /weather/moment ──► draft or skip ──► droplet ──► post on bluesky
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
- **The website writes no database.** The blog, gardens, comments and
  subscriptions are records in people's own repos, read through public
  infrastructure: plc.directory, the Bluesky AppView, Jetstream,
  [Constellation](https://constellation.microcosm.blue) and
  [Slingshot](https://slingshot.microcosm.blue). Two droplet services keep
  public copies in Supabase that the website reads with the publishable key: the
  weather station's history, and the garden's index (`GARDEN_SOURCE`; it falls
  back to Constellation and Slingshot whenever the index is behind).
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
| `/weather` | The atmosphere weather report: how busy Bluesky is, the diversity index (how much of the network isn't Bluesky, by the share of active accounts writing with other apps and how many apps they're spread across, so one busy account counts once), which of those apps are busiest, and the last minute's events and active accounts, live every few seconds; one bar under the header picks what the page shows (now, or the last hour, 24 hours, 7 days or 30 days; new records or active accounts; rates a second, minute, hour or day, or totals), kept in the address so a view can be shared, with trends over the window; an almanac: today's high and low, busier or quieter than usual, new apps, and when the sky is busiest; weather alerts from Poe, in a chat bubble by the corner potato, when a new app blows in, a storm rolls in or the sky gets more mixed; and a sky that gets cloudier with the diversity index |
| `/guides`, `/guides/bluesky-for-brands` | The guides. Written in markdown under `public/guides/`, and also published as a [standard.site](https://standard.site) publication in atpota.to's repo |
| `/blog` | Poe's atmosphere dispatch, a weekly roundup written in [Leaflet](https://leaflet.pub) ([poe.leaflet.pub](https://poe.leaflet.pub)) and server-rendered here from its standard.site records. Readers can sign in to comment, recommend and subscribe (with Bluesky, or by email through Leaflet). Atom feed at `/blog/feed.xml` |
| `/garden`, `/garden/<handle>` | Gardens. `/garden` (where the nav goes) is the community garden, atpotato's seasonal patch, one flower each, with the leaderboards under it (most flowers, most tending for other people's flowers, most pets for Poe, most kinds found, most visitors); signed in, it has a button to your own and shows your place on each board. Tend your neighbours' flowers, or set up a garden of your own and choose whether visitors plant one flower each or as many as they like |
| `/about` | Who makes atpotato, and how it grew: a year to a layer of soil, newest on top, from dame's start in open social in 2021 to now |
| `/settings` | Signed-in visitors can make Poe forget them |
| `/overlay`, `/overlay/setup` | Poe and the weather for a livestream, as an OBS browser source (transparent), and a page that builds its URL with a preview; see [stream overlay](#stream-overlay) |

The wordmark in the header sits in a little sky with the weather in it: a sun whose
rays turn faster when the network is busy, and a cloud or two as the diversity index
climbs. Poe's chat panel sits in the corner of every page. Click it, press `/` anywhere,
or highlight a word in a guide to ask about it.

### stream overlay

`/overlay` is Poe and the atmosphere's weather on a transparent page, for streaming.
**`/overlay/setup` is where you set it up**: sign in, pick and place the widgets, and
your settings are saved to **your own repo** (`to.atpota.poe.overlay` at `self`,
[`website/lexicons/to/atpota/poe/overlay.json`](website/lexicons/to/atpota/poe/overlay.json)),
so they're the same on every device. The overlay reads that record and follows it live on
Jetstream, so a change saved on your phone mid-stream shows up in OBS a second later. The
URL never changes:

```
https://atpota.to/overlay?streamer=dame.is
```

In OBS add a **Browser** source with it, width 1920 and height 1080, tick *control audio
via OBS* to hear Poe, and leave *shutdown source when not visible* off.

- **Weather widgets**, each on or off, in one of six slots (the top or bottom corners or
  middles; widgets in one slot stack) at 50% to 200%: the **card**, the **strip** (one slim
  bar along the top or bottom), a little **badge**, the **busiest apps** outside Bluesky with
  bars, the **forecast** for the next six hours, and the **pulse** (the last minute of the
  firehose as a big line).
- **Poe** sits along the bottom edge, left or right, facing into the screen (on the left
  its faces are mirrored, with the @ on its tummy kept the right way round), at 50% to
  200%. It blinks, glances and waves, bobs faster when the atmosphere is busy, dozes off
  after a few quiet minutes, and says the `/weather` alerts in a speech bubble with a little
  sound. Now and then one of the home page hero's **visitors** drops by: a butterfly that
  sits on its head, a bird hopping along the bottom, a snail, a worm out of its hole, or by
  night a moth.
- **With `streamer=`** it watches that account's [stream.place](https://stream.place) chat,
  follows and streams on Jetstream: a cheer when the stream goes live (with its title) and a
  goodbye when it ends, a hello with their avatar to each new chatter, "welcome back" to
  regulars, thanks and a hop for new followers, and the chat commands `!weather`,
  `!forecast`, `!apps`, `!pet` and `!poe`. In dame.is's chat, `!pet` also counts on the
  garden's pets leaderboard, one an hour (`garden/`). It only ever says handles, never
  what people wrote.

**Scenes** are full screens for the moments in between, each with its own URL and its
own record (`to.atpota.poe.scene`, at the screen's id,
[`website/lexicons/to/atpota/poe/scene.json`](website/lexicons/to/atpota/poe/scene.json)),
set up in the screens section of `/overlay/setup` and followed live like the rest. Add
each as a browser source in its own OBS scene, and switch between them there:
`/overlay?streamer=dame.is&scene=starting`. Everyone starts with one of each kind (its id
is its kind); **+ new screen** adds as many more as you like, of any kind, with a name
("coding brb" is `&scene=coding-brb`). Added screens can be removed, and the starting four
reset to their defaults.

| kind | what's on it |
| --- | --- |
| `starting` | "starting soon", a line under it, and a countdown: a timer from when the scene comes on (tick *refresh browser when scene becomes active*), or to a time. When it runs out Poe cheers |
| `brb` | "be right back" |
| `ending` | "thanks for watching", and up to four places to find you |
| `screenshare` | an atpotato frame with a big 16:9 window for a screen capture and a camera window beside it (rounded, circle or wide; right, left or none), the title along the bottom and the weather in the column, Poe on the camera's side. The setup page gives each window's exact spot to put the OBS sources under it |

Each has a title and a line under it, a backdrop (day: sky, clouds and the sun; night:
stars and tonight's moon; garden: a warm butter sky; butter: a turning sunburst), a ground
(meadow: the home page's hill with buttercups and grass tufts, the default; grass: the
about page's scalloped strip; soil with sprouts; or none), and whether Poe (with its chat)
and the weather widgets come along.

Settings in the URL override the saved ones, for that browser source only (the setup
page's preview passes its whole draft this way):

| param | does |
| --- | --- |
| `w=card:tl:100,apps:tr:80` | the widgets: kind, slot (`tl tc tr bl bc br`) and size in percent; `w=none` for none |
| `poe=left:120`, `poe=off` | Poe's corner and size, or no Poe |
| `chat=off`, `follows=off`, `alerts=off`, `visitors=off` | turn off hellos and commands, follower thanks, weather alerts or visitors |
| `ignore=<handles or DIDs>` | people Poe never greets, thanks or answers (bots), comma separated |
| `sound=off`, `volume=0-100` | Poe's noises (default 40) |
| `nap=<minutes>`, `nap=off` | how long it's quiet before Poe naps (default 5) |
| `theme=dark` | the dark theme's colours |
| `demo` | example lines every 10 seconds and visitors more often, for placing things |

The code is in `website/src/overlay/` (`config.ts` for the settings, `params.ts` for the URL).

### functions

Each file in `website/api/` is a thin Vercel Function entry point. The logic lives
in `website/server/`, so Vercel only builds the entry points.

| function | what it answers |
| --- | --- |
| `api/poe.ts` | `POST` streams one chat turn from the bot as server-sent events. `DELETE` ends the conversation, or with a forget token, empties Poe's notes about the visitor |
| `api/blog.ts` | The `/blog` pages, the Atom feed, and the standard.site `/.well-known` verification (`vercel.json` rewrites these here) |
| `api/garden.ts` | One garden's patches and flowers |
| `api/gardener.ts` | One person's garden page: their garden, the flowers they've planted anywhere, the tending they've given, their pets for Poe, and how many notes Poe keeps about them |
| `api/leaderboard.ts` | The community garden's leaderboards, counted by the garden index (`garden_leaderboard`) and moderated like the garden: atpotato's blocks, hidden accounts and atpotato itself are left off |
| `api/latest.ts` | The home page's "latest" feed |
| `api/atmosphere.ts` | The weather station's rolling 60 seconds, for the home page's "atmospheric conditions" and `/weather` (cached 5 seconds; needs `ATMOSPHERE_STATION_SECRET`). Without the station it samples a few seconds of Jetstream itself, and one sample serves everyone for a minute |
| `api/weather-history.ts` | The trends on `/weather`, from the station's minute rows in Supabase (public, read with the publishable key): records a second, active accounts and the diversity index they make, and apps heard over a range, and the busiest apps with how each did against a day (or month, or year) earlier |
| `api/weather-almanac.ts` | The almanac on `/weather`, in the reader's time zone: today's high and low, the last hour against usual, apps heard for the first time, and the week as a heat map |
| `api/og-weather.ts` | `/weather`'s Open Graph card, `/og/weather.png` (a rewrite), drawn from the weather right now with satori and resvg and cached for 5 minutes. `?card=forecast` (the default), `trend`, `mix` or `today` picks the design. Without the numbers it draws a quiet card, never an error |

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
| `npm run og` | Renders the Open Graph cards into `public/og/` with headless Chromium. Needs `npx playwright install chromium-headless-shell` once. The Vercel build runs it too, and keeps the committed cards if it fails. `/weather`'s card isn't one of these: it's drawn live by `api/og-weather.ts` |

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
- **in the weather, now and then**, on its own Bluesky account: the day's report
  from the weather station, and a post when it catches a storm, an hour well off
  usual, a sky getting more mixed, or a new app blowing in. The droplet spots the
  moment and asks; Poe writes the post or skips it, and the droplet gates it and
  posts it with a card for `/weather`
  ([`mentions/README.md`](mentions/README.md#weather-posts-weather_posts)).
- **in private DMs** with the people who run it, who can also ask it in plain words
  for a public post (the weather right now, a nudge to read the newsletter,
  anything else). Poe shows them the exact post with its card, and it goes out only
  when they answer yes.

Poe keeps short notes about the people it talks to, keyed on their DID, so it can
skip explanations they don't need. The notes are public, published in Poe's own
repo, and anyone can clear theirs at [atpota.to/settings](https://atpota.to/settings).

### the bot's channels

| route | who calls it |
| --- | --- |
| `POST /bluesky/mention` | The droplet, for each mention it decides to answer |
| `POST /api/scan-approval/respond` | The droplet, relaying an operator's yes or no to a collection scan that needs more than the default 10 pages |
| `POST /operator/dm` | The droplet, for private DMs from operators |
| `POST /weather/moment` | The droplet's weather watcher, when the weather station catches something worth a post |
| `POST /website/chat`, `POST /website/forget` | atpota.to's `/api/poe` |

Every caller sends a shared secret. The routes live in `bot/agent/channels/`.

### changing how poe sounds

- [`bot/agent/instructions.md`](bot/agent/instructions.md): who Poe is, its rules, and its voice
- [`bot/agent/skills/bluesky-reply.md`](bot/agent/skills/bluesky-reply.md): the Bluesky format and sample replies
- [`bot/agent/skills/dispatch-weather.md`](bot/agent/skills/dispatch-weather.md): the dispatch's weather section and outlook
- [`bot/agent/skills/weather-post.md`](bot/agent/skills/weather-post.md): its own weather posts on Bluesky, and when to skip one
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

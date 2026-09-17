# 07. Build plan

**The Bluesky agent is the product.** The website panel in `06-ui-spec.md` is a
separate project for later, and nothing in this plan depends on it.

That changes the shape of the build. The website version could have shipped as
one deployable with a chat box on it. This one cannot: the agent has to be
reachable from a stream it does not control, and it has to decide, correctly and
without supervision, when to stay quiet.

## Three deployables, two of them now

| | What it is | Where | Holds |
| --- | --- | --- | --- |
| **The agent** | eve project. Instructions, the Aturi connection, skills, the Bluesky channel | Vercel | A model API key. No atproto credential, ever |
| **The service** | Jetstream consumer, matcher, gates, queue, poster, admin CLI | The droplet | The atproto credential, the dedup and queue database, the denylist |
| **The panel** | Browser chat UI | Later | Nothing yet |

Three deployables, not three repositories. The agent and the service are two
directories in this repository, deployed by two different mechanisms. See
[Where the code lives](#where-the-code-lives).

Most of the code is on the droplet, not in the agent. The agent is a prompt, a
connection, seven skills, and one channel file. The service is a real program
with state, retries, and a kill switch. Budget accordingly: the interesting part
is the agent and the work is the service.

## Decisions before any code

The first three block the first commit. The other two can wait for the phase
that needs them.

| Decision | Recommendation | Why it matters now |
| --- | --- | --- |
| **Which account posts** | A new account, not `@atpota.to` | Blocking. If the org account is the bot, every casual mention of atpotato becomes a trigger, and people mention brands without asking them anything. A separate handle means a mention is unambiguously addressed to the bot |
| **Where the account lives** | `pds.atpota.to` | You already run it. It makes the bot a demo of the thing it explains, and it puts the write limits under your control |
| **Where the code lives** | This repository | See below. An earlier draft said separate repositories and the reasoning did not survive contact |
| **Language for the service** | Whatever the existing consumer is written in | You already run a Jetstream consumer. Extending it beats starting a second one. If it is Go, the first-party Jetstream Go SDK applies; if TypeScript, `@bsky/jetstream` |
| **Model** | The strongest you will pay for, then measure down | Many small tool calls and short answers is the shape that usually survives a downgrade. The eval suite tells you, guessing does not |

## Where the code lives

In this repository, alongside `website/`, `branding/`, and these specs.

An earlier draft of this plan said separate repositories, on the grounds of
separate deploys, separate secrets, and separate release cadence. Two of those
three do not hold up:

- **Secrets were the weakest argument.** The app password lives in the droplet's
  environment and the model key lives in Vercel's. Neither sits in a repository
  under either layout, so a repository boundary was protecting nothing.
- **Deploy cadence is a project setting, not a repository boundary.** Vercel
  already scopes the site to `website/`, and `ignoreCommand` handles the rest.
- **Separate deploys survives, and does not need separate repositories.** Two
  Vercel projects can point at two directories in one repository.

What keeping it together buys is worth more than any of that: the specs in
`agent-spec/` sit next to the thing they describe, so a prompt change and the
document explaining it are one commit rather than two repositories drifting; the
potato art for the bot's avatar is already here; and for a small team, two
repositories is coordination overhead with no payoff.

```text
atpota.to/
├── README.md
├── branding/
├── website/            Vercel project 1, root directory website/
├── agent-spec/         these documents
├── bot/                Vercel project 2, root directory bot/
│   ├── package.json    its own, with eve and Node 24
│   ├── agent/
│   │   ├── instructions.md
│   │   ├── instructions/
│   │   ├── connections/atmosphere.ts
│   │   ├── channels/bluesky.ts
│   │   ├── memory/person.ts
│   │   └── skills/
│   └── evals/
└── mentions/           the droplet service, if it does not already have a home
```

Names are a preference. `bot/` and `mentions/` are descriptive; pick what reads
right to you.

### What this needs configuring

1. **A second Vercel project**, created from the eve CLI rather than the
   dashboard, then pointed at root directory `bot/`. See
   [How the Vercel project actually gets created](#how-the-vercel-project-actually-gets-created).
   eve deploys using Vercel Workflow and Vercel Sandbox, so read
   `docs/guides/deployment/vercel.md` before that project's first deploy.
2. **An ignored build step on both projects**, so a copy tweak to the site does
   not redeploy the agent and a prompt change does not rebuild the site.
   Vercel's documented form, which runs relative to the project's root
   directory:

   ```json
   { "ignoreCommand": "git diff --quiet HEAD^ HEAD ./" }
   ```

   Exit code 0 ignores the build, 1 continues it. `HEAD^` is wrong when a push
   contains several commits; Vercel exposes `VERCEL_GIT_PREVIOUS_SHA` for that
   case, and it is populated only once an ignored build step is configured. Test
   whichever form you use, because a broken ignore command fails in the
   direction of never deploying.

   Adding this to `website/vercel.json` changes an existing production
   configuration. Do it deliberately and watch the next site deploy.
3. **No root `package.json` and no workspace.** `bot/` keeps its own dependency
   tree. The website is a static site with one devDependency and should stay
   that way. A workspace would couple their installs for no benefit.
4. **Node version per project.** eve needs 24 or newer, which is a per-project
   Vercel setting, so the site is unaffected.

### How the Vercel project actually gets created

Not from the dashboard. Vercel's dashboard flow for creating an agent starts
from a template, which is why it will not let you point at an existing
repository. It is a different product surface from eve deployment, and it is not
the path here.

An eve project creates and links its Vercel project from the CLI:

```bash
# from the repository root
npx eve@latest init bot
rm -rf bot/.git          # eve init runs git init; you do not want a nested repo

cd bot
eve link                 # pick a team, then create a project or link an existing one
eve deploy               # installs dependencies, runs vercel deploy --prod, pulls env
```

`eve link` gives you a picker: create a project named for the agent, or link an
existing one, with search across the team's projects. It then pulls that
project's environment so an AI Gateway credential (`VERCEL_OIDC_TOKEN` or
`AI_GATEWAY_API_KEY`) lands in `.env.local`. Running it again re-links, and the
new choice wins.

The nested `.git` is a real gotcha rather than a hypothetical one. `eve init`
initializes a repository as part of scaffolding, which inside this repository
would give you a second one. Remove it before the first commit.

### Adding push-to-deploy afterwards

Git-connected deploys work; you just cannot start from there. Once `eve link`
has created the project:

1. **Settings, Git**: connect `atpota-to/atpota.to`.
2. **Root Directory**: `bot/`.
3. **Build Command**: `eve build`. This is the part the dashboard cannot infer,
   because the framework preset knows nothing about eve. On a hosted build eve
   detects `VERCEL` and writes the deployment bundle under `.vercel/output`.
4. **Ignored Build Step**: as above, so the site and the agent stop rebuilding
   each other.

One uncertainty worth checking rather than trusting: eve's docs do not say
whether `eve link` sets the project's build command for you. Look at the project
settings after linking. If the first Git-triggered build fails because Vercel
does not know how to build the directory, step 3 is the answer.

### You do not need any of this yet

eve's own getting-started is explicit that you do not need a Vercel project to
start chatting. `npx eve@latest init bot`, then `npm run dev`, gives you the
terminal UI and a working agent with no deployment anywhere.

Phase 1 and Phase 2 below need no Vercel project at all. Deployment first
matters in Phase 4, when the droplet needs a URL to call. Leaving it until then
is the right order: you will have changed the prompt fifty times by that point,
and none of those iterations wanted a deploy.

### The one genuine exception

The droplet service does not deploy from Vercel at all, may not be in the same
language, and **already partly exists**: you have a Jetstream consumer running
today. If that consumer already lives in a repository, extend it there and
ignore the `mentions/` directory above. The question is not where to put new
code, it is whether to grow the service you have or stand a sibling next to it.
Growing the one you have is almost always right.

If it currently exists only as something running on the droplet with nothing
behind it, then `mentions/` here beats that, and getting it into version control
matters more than which directory it lands in.

## Phase 0. Accounts and keys

- Create the bot account on `pds.atpota.to`. Set the handle, avatar (a potato),
  and a bio that discloses it is an AI and names the stop phrase.
- Mint an app password. It goes on the droplet and nowhere else. Not in either
  repository, not in the Vercel project.
- `npx eve@latest init bot` from the repository root, giving `bot/`. Node 24 or
  newer. Delete the `bot/.git` that `eve init` creates.
- A model credential. You may not need a provider API key at all: a string model
  ID routes through the Vercel AI Gateway and authenticates over project OIDC.
  The terminal UI will connect a Vercel account, an AI Gateway key, or an
  Anthropic or OpenAI key, whichever you prefer.
- No Vercel project yet. It is not needed until Phase 4.
- Read `node_modules/eve/docs/`. Those match your installed version; eve.dev
  documents the latest release and eve is in beta, so they will drift. Where
  they disagree with this spec, they win.

Half a day, mostly waiting on yourself to pick a handle.

## Phase 1. The agent answers, with no Bluesky anywhere

Build the whole knowledge layer and drive it from the terminal.

- `agent/instructions.md` from `03-system-prompt.md`.
- `agent/connections/atmosphere.ts` from `04-aturi-connection.md`.
- The seven skills from `skills/`.
- `npm run dev`, then the terminal UI. No Vercel project, no deploy, no URL.

**Done when:** you paste an `at://` URI and get a correct resolution with a
working link, ask a lexicon question and get the real schema, ask what a DID is
and get two jargon-free sentences.

This is the milestone that tells you whether the idea works, and it is roughly
an afternoon. If the answers are good here, everything after this is plumbing
and judgment. If they are not, no amount of plumbing helps.

**Watch for:** the model answering protocol questions from memory instead of
calling `search_atproto_docs`. That is the most likely early failure and it is
usually fixed by lengthening the connection `description`, then by moving the
compressed routing table into the instructions.

## Phase 2. Evals

Write the routing, accuracy, calibration, boundary, and voice cases from
`08-evals.md` and run them with `eve eval`. Fix the prompt, not the model.

Automate the one assertion that matters most first: **no DID, NSID, rkey, or PDS
hostname in the output that did not appear in a tool result.** It is mechanically
checkable and it catches the failure that would most damage trust in public.

Do this before the account exists. Prompt iteration is free now and expensive
once replies are permanent.

## Phase 3. Detect, and post nothing

First droplet work. Subscribe, match, log, reply to nobody.

- Jetstream v2 subscription, `collections=app.bsky.feed.post`, `kinds=commit`.
- Match mentions on the facet DID, replies on `reply.parent.uri`.
- Persist the cursor with every processed event. Dedup on `(did, rkey)`.
- Add the `listNotifications` sweep alongside it.
- Write every match to a table. Post nothing.

**Run it for several days.** You get three things that no amount of speccing
gives you: what people actually send, what the real event volume through the
post firehose costs you, and the gap rate between Jetstream and notifications,
which tells you how much the sweep is earning.

**Done when:** you have a few hundred real matches to read, and you know what
fraction of them are questions versus casual mentions.

That fraction is the single most important number in this build. If most
mentions are not questions, the substance gate in `09` is doing nearly all the
work and deserves most of your attention.

## Phase 4. Draft, and still post nothing

Connect the two halves. Nothing reaches Bluesky.

This is where the agent first needs to be deployed, because the droplet needs a
URL to call. `eve link` then `eve deploy`, per
[How the Vercel project actually gets created](#how-the-vercel-project-actually-gets-created).
Add push-to-deploy here too if you want it, once one manual deploy has proved
the build works.

- `agent/channels/bluesky.ts`: the inbound route, the auth block carrying the
  author DID, the draft callback.
- `agent/instructions/bluesky.ts`: channel-scoped rules wrapping the
  `bluesky-reply` skill.
- Droplet: call the agent, receive the draft, write it to a review queue next to
  the original post.

**Done when:** every match from Phase 3's feed produces a draft in a queue you
can read side by side with what prompted it.

**This is the riskiest phase technically**, because the eve channel details in
`09` are inferred from the documentation rather than copied from working code.
The event names, the `message.completed` payload shape, and the channel identity
accessor in the dynamic instructions resolver all need checking against your
installed version. Do this part first within the phase, before the droplet side,
so you find out early if the shape is different.

## Phase 5. Gates

Every gate from `09-bluesky-channel.md`, in code, with unit tests. Inbound first,
outbound second.

The tests in `08-evals.md` under "Gate tests" are the checklist. The three that
will actually save you: a post from the bot's own DID never produces a reply
under any path, a backfill of old events produces nothing, and the kill switch
stops the poster while the consumer keeps running.

**Done when:** you have read a few hundred queued drafts and the ones the gates
rejected were the right ones to reject.

Do not rush this phase. It is the last point where mistakes are free.

## Phase 6. Let it post

- Global rate at something low, 10 replies an hour.
- Denylist empty, opt-out path working, kill switch tested for real.
- Spend ceiling and an alert at half of it.
- Tell a handful of people who will be honest with you, and nobody else.

**Done when:** it has been boring for a week. Then raise the ceiling.

## Phase 7. Memory

`10-memory.md`, only once Phase 6 is dull. The `person` slot, the DID assertion
the droplet already sends from Phase 4, the "forget me" path including the
whole-scope delete, and the bio update in the same deploy.

## Later. The website

`06-ui-spec.md` is unchanged and still correct. It needs a frontend decision
(the three options in that document) and the expression-state wiring. Nothing in
it blocks anything above, and by the time you get to it the agent will have
months of real questions behind it, which is a much better starting point for
designing a panel than guessing.

## The service, component by component

Nine pieces, most of them small. SQLite on the droplet covers all the state.

| Component | Does | Notes |
| --- | --- | --- |
| Consumer | Holds the Jetstream socket, decodes, persists the cursor | Reconnect with backoff. At-least-once, so dedup downstream |
| Matcher | Facet DID for mentions, parent URI for replies | Never match on the literal handle string |
| Sweeper | Polls `listNotifications` every few minutes | Catches what the socket missed |
| Dedup store | `(did, rkey)` seen table | Primary key does the work |
| Gate engine | Inbound gates in order, outbound gates on drafts | Pure functions where possible. This is what you unit test |
| Queue | Matches waiting for a draft, drafts waiting to post | One table, a status column |
| Agent client | POSTs to the eve route with the shared secret and auth block | Fire and forget, 202 |
| Callback receiver | Takes drafts back from eve | Verify the secret. Idempotent on the key eve sends |
| Poster | `createRecord` with correct reply refs and link facets | The only component holding the credential |
| Admin CLI | Denylist, kill switch, review queue, forget-me | Boring and essential. Build it in Phase 5, not after |

Tables, roughly: `cursor`, `seen(did, rkey)`, `queue`, `replies`, `denylist`,
`memory_deletes`. Nothing here needs Postgres.

## The three things I would verify before trusting this plan

1. **The eve channel API shape.** Partly resolved: the route, auth and event
   surfaces in `09` were checked against the 0.58.1 docs installed in `bot/`,
   and one real error was found and fixed (the draft callback belongs on
   `turn.completed`, not `message.completed`). Event payload field names are
   still unverified until a turn actually runs. Phase 4 finishes it.
2. **Post firehose volume on the droplet.** Filtering every post on the network
   to find a handful of mentions is the real cost of the Jetstream approach.
   Phase 3 measures it, and if it is unpleasant, the `listNotifications` sweep
   alone is a complete fallback with far less machinery.
3. **Whether the questions are worth answering.** Phase 3's log answers this
   before you have built the hard parts. If people mostly tag the potato to be
   funny rather than to ask things, that is worth knowing at day three rather
   than week six.

## Rough shape of the effort

Phase 1 is an afternoon. Phase 3 is a day of building and then several days of
waiting. Phases 4 and 5 are the bulk of it. Phase 2 is continuous rather than a
block, and it pays for itself the first time a prompt change silently breaks
routing.

The critical path runs through Phase 3, because you cannot shorten the days of
watching. Start it early, even in parallel with Phase 1, since the consumer does
not depend on the agent existing.

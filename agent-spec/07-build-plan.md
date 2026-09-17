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

Most of the code is on the droplet, not in the agent. The agent is a prompt, a
connection, seven skills, and one channel file. The service is a real program
with state, retries, and a kill switch. Budget accordingly: the interesting part
is the agent and the work is the service.

## Decisions before any code

Four of these block the first commit.

| Decision | Recommendation | Why it matters now |
| --- | --- | --- |
| **Which account posts** | A new account, not `@atpota.to` | Blocking. If the org account is the bot, every casual mention of atpotato becomes a trigger, and people mention brands without asking them anything. A separate handle means a mention is unambiguously addressed to the bot |
| **Where the account lives** | `pds.atpota.to` | You already run it. It makes the bot a demo of the thing it explains, and it puts the write limits under your control |
| **Where the eve project lives** | Its own repository | It has its own deploy, its own secrets, and its own release cadence. Putting it in the website repo couples two things that have nothing to do with each other |
| **Where the service lives** | Its own repository, on the droplet | Same reasoning, plus this is the one holding the credential |
| **Language for the service** | Whatever the existing consumer is written in | You already run a Jetstream consumer. Extending it beats starting a second one. If it is Go, the first-party Jetstream Go SDK applies; if TypeScript, `@bsky/jetstream` |
| **Model** | The strongest you will pay for, then measure down | Many small tool calls and short answers is the shape that usually survives a downgrade. The eval suite tells you, guessing does not |

## Phase 0. Accounts and keys

- Create the bot account on `pds.atpota.to`. Set the handle, avatar (a potato),
  and a bio that discloses it is an AI and names the stop phrase.
- Mint an app password. It goes on the droplet and nowhere else. Not in either
  repository, not in the Vercel project.
- `npx eve@latest init atpotato` in the new repo. Node 24 or newer.
- Model API key into the eve project's environment.
- Read `node_modules/eve/docs/`. Those match your installed version; eve.dev
  documents the latest release and eve is in beta, so they will drift. Where
  they disagree with this spec, they win.

Half a day, mostly waiting on yourself to pick a handle.

## Phase 1. The agent answers, with no Bluesky anywhere

Build the whole knowledge layer and drive it from the terminal.

- `agent/instructions.md` from `03-system-prompt.md`.
- `agent/connections/atmosphere.ts` from `04-aturi-connection.md`.
- The seven skills from `skills/`.
- `eve dev`, then the terminal UI.

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

1. **The eve channel API shape.** The sketches in `09` are doc-derived, not
   run. Phase 4 finds out.
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

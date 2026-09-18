# atpotato mentions service

**Build brief. Self-contained: you should not need any other conversation to
work from this.**

## What you are building

A small always-on service that watches the AT Protocol firehose for people
mentioning or replying to the atpotato Bluesky account, decides whether each one
deserves an answer, asks an already-built AI agent for a draft, decides again
whether the draft is safe to post, and posts it as a reply.

It runs on a DigitalOcean droplet. It holds the only atproto credential in the
system. It is the component where a bug is publicly visible, so it is written
defensively and tested properly.

## Context you need

**atpotato** (atpota.to) makes tools and guides for the atproto and Bluesky
ecosystem. The mascot is a potato. The idea here is a Clippy that is actually
good: you @ mention a potato, it answers your question about the Atmosphere in
one short post, and it points you somewhere to read more.

**The agent already exists** in `bot/` in this repository. It is built on
[eve](https://eve.dev), Vercel's agent framework, runs `anthropic/claude-opus-5`
through the Vercel AI Gateway, and reads the Atmosphere through
[Aturi's MCP server](https://aturi.to/mcp), which exposes 38 read-only tools.
It knows how to resolve identities, read repositories, follow backlinks, look up
lexicon schemas, and quote the atproto docs.

**The agent cannot post.** It has no write tool and no atproto credential. It
produces text. Nothing more.

**That split is the whole security model, so do not collapse it.** The inbound
surface is a public text field. People will put "ignore your instructions" in a
post and some of them will be clever about it. A prompt rule is a request; a
conditional in your poster is a guarantee. Every decision about whether to reply
lives in your code, in plain conditionals you can unit test. If a prompt
injection succeeds completely, the worst outcome should be a draft your gates
reject.

Background reading in this repository, useful but not required:
`agent-spec/01-product-spec.md` (what it is and the Clippy failure modes we are
refusing to repeat), `agent-spec/09-bluesky-channel.md` (the design this
implements), `agent-spec/07-build-plan.md` (where this sits in the whole build).

## Architecture

```
Jetstream (public, no auth)
        │  app.bsky.feed.post commits
        ▼
  consumer ──► matcher ──► inbound gates ──► queue ──┐
                                                      │
                          POST /bluesky/mention       │
                          (shared secret)             ▼
                                            [vercel] eve agent
                                                      │
                          POST <callback>             │
                          (draft text)                ▼
  outbound gates ──► poster ──► com.atproto.repo.createRecord
```

Everything except the agent is yours.

## The contract with the agent

Both sides of this are already implemented in `bot/agent/channels/bluesky.ts`
and `bot/agent/lib/bluesky.ts`. Read them; they are short. Do not change them
without updating this file.

### You call the agent

```
POST https://<agent-host>/bluesky/mention
x-atpotato-secret: <shared secret>
content-type: application/json

{
  "threadRoot":   "at://did:plc:.../app.bsky.feed.post/...",
  "postUri":      "at://did:plc:.../app.bsky.feed.post/...",
  "authorDid":    "did:plc:...",
  "authorHandle": "someone.bsky.social",
  "text":         "the post's text, verbatim",
  "reason":       "mention" | "reply"
}
```

Responses: `202` accepted, `401` bad or missing secret, `400` payload failed
validation. The `202` is not a draft. It means the turn was dispatched.

**`threadRoot` is the session address.** The agent uses it to map a thread to
one durable conversation, so follow-up questions in the same thread keep their
context and the potato does not reintroduce itself four times. Send the same
`threadRoot` for every post in a thread.

Computing it: if the matched post has `record.reply.root.uri`, that is the
thread root. If it does not, the post is itself the root, so use the post's own
`at://` URI.

**`authorDid` must come from the signed record**, never from parsing the post
text. It is also what the agent's memory scope keys on later, so a wrong value
here would attach one person's memory to another.

### The agent calls you back

```
POST <DROPLET_CALLBACK_URL>
x-atpotato-secret: <shared secret>
content-type: application/json

{
  "key":        "<sessionId>:<turnId>",
  "threadRoot": "at://...",
  "text":       "the draft reply",
  "links":      ["https://aturi.to/...", "https://bsky.network/docs/..."]
}
```

Four things about this:

- **`links` is every URL this turn's tool results contained**, deduplicated and
  capped at 200. It exists so the link gate can enforce the real rule rather
  than falling back to a host allowlist, which cannot catch an invented path on
  a real domain. Reject any draft containing a link that is not in this array.
  It is accumulated per turn and cleared at `turn.started`, so a link looked up
  in an earlier turn of the same thread does not authorize a later one.

- **`key` is an idempotency key.** eve's channel event handlers are
  at-least-once, so the same draft can arrive twice. Enforce a unique
  constraint on it.
- **The agent drops the draft if your endpoint does not return 2xx.** It logs
  and moves on rather than failing the turn. So you need a reconciliation
  sweep: any queued match with no draft after a few minutes is either retried
  or alerted on. Do not assume delivery.
- **One shared secret currently covers both directions.** That is acceptable
  and symmetric. Separate secrets per direction would be cleaner if you feel
  like it; just keep both sides in sync.

## Detection

### Jetstream

Use Jetstream v2, endpoint `xrpc/network.bsky.jetstream.subscribeEvents`. No
auth for the live tail. Parameters are `collections`, `dids`, `kinds`, and
`cursor`. There is a first-party TypeScript SDK (`@bsky/jetstream`) and a Go
one.

**Default to `wss://jetstream.us-west.bsky.network`.** As of 2026-09-18
`jetstream.us-east.bsky.network` returns 503, verified from two unrelated
networks, so it is the host and not your droplet. Keep east configured as a
fallback and expect to flip between them.

Four things about v2 that will cost you a day each if you meet them by
surprise:

- **The v2 wire format is not v1's.** v2 is flat under `payload` carrying `seq`
  and `time`; v1 nests under `commit` with `time_us`. Code written against one
  matches nothing against the other, and it fails silently rather than
  erroring, because a shape that does not match is indistinguishable from a
  post that does not mention you.
- **A v1-style cursor handed to v2 does not error.** It resumes somewhere
  unrelated. Store the cursor tagged with the version that produced it.
- **v2 answers HTTP 400 to an aged-out cursor** rather than starting from the
  oldest retained event. After a long outage that produces a connection which
  can never succeed until you drop the cursor. Self-heal after a few
  consecutive failures by clearing it and accepting the gap; the notification
  sweep covers what you lose.
- **A failed HTTP upgrade fires `error`, not `close`.** If your reconnect logic
  hangs off `close` alone, a dead socket never retries, silently, for the life
  of the process. On a healthy-looking service that consumes nothing, this is
  the first thing to check. Node's WebSocket also hides the status code, so a
  400 and a 503 arrive as the same error string.

```
collections=app.bsky.feed.post
kinds=commit
```

**You cannot use the `dids` filter.** It restricts the stream to specific
accounts, and you do not know in advance who will mention you. So you are
filtering the entire post firehose in your own process.

Measured on the droplet, 2026-09-18: **46 posts/s, roughly 45 KB/s, so 4 to 5 GB
per day.** CPU is 1.2% of a core and memory sits in the tens of megabytes.
Bandwidth is the real cost here, not compute. That is comfortably inside a
DigitalOcean transfer allowance, but it is not free, and it is the number to
weigh if you ever reconsider Jetstream against notification polling alone.

Operational requirements, all documented behavior rather than paranoia:

- **Dedup on `(did, rkey)`.** Delivery is at-least-once and a reconnect
  redelivers.
- **Persist the cursor with every processed event** and resume from it on
  restart, not from now.
- **Cursor replay is bounded.** The docs commit only to "a bounded lookback
  window", so a long outage means a gap. Hence the sweep below.
- Reconnect with backoff. Do not hot-loop a failing socket.

### Two match conditions

**Mention:** the record's `facets` contain a feature of type
`app.bsky.richtext.facet#mention` whose `did` equals atpotato's DID.

Match on the facet DID. **Never** match on the literal string `@atpota.to` in
the text. Facets are what the posting client actually resolved; text is just
text, and the two can disagree by accident or on purpose.

**Reply:** `record.reply.parent.uri` is a post **the service itself created**.

That is narrower than "any post from atpotato's DID", and the difference is the
whole ballgame on a shared account. See below.

**Quote posts** embed our post at `embed.record.record.uri`. Do not answer
these in v1. Quoting is usually commentary about you rather than a question to
you, and replying reads as barging in.

### Running on a shared human and bot account

atpotato replies from `@atpota.to` itself (`did:plc:qntsxa2i4sb24noi45fx4np2`),
not from a dedicated bot account. That is a deliberate product decision and it
changes one thing structurally.

On a dedicated account, "someone replied to me" and "someone is talking to the
bot" are the same statement. On a shared account they are not. `@atpota.to` is a
project account with 841 followers that posts announcements and reposts its
sibling projects. People reply to those announcements to say nice things about
them, not to ask a potato about lexicons.

So **the reply trigger must be "a reply to a post the bot wrote", not "a reply
to a post from this DID".** The service already records every reply it posts, so
this is a table lookup rather than a heuristic:

- A reply to a bot reply is a follow-up question. Answer it.
- A reply to a human-authored post from the same account is a conversation the
  bot is not in. Ignore it, always.
- Before the bot has ever posted, no reply can match. That is correct: the only
  way in is a mention.

Reposts create no trigger. A reply to a reposted post carries the original
author's DID in `parent.uri`, not atpotato's.

That leaves **mentions as the main entry point, which puts the whole weight on
the substance gate.** A project account gets mentioned conversationally all the
time: by its own sibling accounts, by people recommending it, by people thanking
it. None of those are questions. If you tune only one number during milestone 1,
tune this one.

If the false-positive rate stays uncomfortable after tuning, the next lever is
an explicit wake phrase in the mention text rather than a cleverer heuristic.
Requiring people to actually address the potato is a smaller cost than replying
to someone who did not.

### The safety net

Jetstream is the low-latency path, not the complete one. Run a second loop that
polls `app.bsky.notification.listNotifications` every few minutes, filters to
the `mention` and `reply` reasons, and enqueues anything the dedup table has not
seen. That endpoint is the canonical record of who tried to reach you.

Worth knowing: notification polling alone would cover this use case with far
less machinery. Jetstream buys latency and there is already a consumer running.
Keep the sweep regardless, for the gaps.

## Inbound gates

Run these in order, in code, before anything reaches the agent. Every one exists
because a bot without it has embarrassed someone.

| Gate | Rule |
| --- | --- |
| Self | Author DID is atpotato's. Drop, always, first, on every code path |
| Thread depth | Count atpotato's own posts already in the thread. Cap at 3, then stop replying in that thread |
| Bot loops | If one account has triggered more than 3 replies in 15 minutes, back off for an hour. Two bots in a mutual reply loop is the classic way to burn a rate limit and look stupid |
| Per-account rate | 5 replies per account per hour |
| Global rate | Start at 10 per hour. See the budget below |
| Denylist | A manual list. Honor it permanently. No appeal flow in v1 |
| Opt-out | A reply containing a stop phrase adds that DID to the denylist. `forget me` additionally wipes that DID's agent memory once memory ships. Announce both in the profile bio |
| Staleness | Ignore anything whose `createdAt` is more than 15 minutes old at processing time. Stops a backfill from replying to three weeks of history at once |
| Language | `record.langs` outside what you support gets silence, not a reply in English explaining that you only speak English |
| Substance | No question mark, no identifier, no recognizable request, and short: drop it. A bare mention inside a conversation between two other people is not addressed to you |

That last gate is the most consequential thing in this service. Replying to a
mention that was not a question is exactly what makes people mute a bot.

It has since been measured against 27 real posts, and the result is worth
knowing before you tune it. A 12 character floor passed 96% of them while only
11% contained a question: the length signal was so permissive that it made the
conjunction a no-op. Raising the floor to 80 helps, but even with length removed
entirely 44% still pass, because a request-word list catches ordinary prose.

Two cautions on that number. The sample was a political account's replies, not
atpotato's mentions, so treat it as structure rather than as your threshold. And
the real threshold should come from atpotato's own traffic during milestone 1,
which is what the sensitivity table in `npm run stats` is for.

## Outbound gates

After the agent returns a draft, before `createRecord`:

| Check | Rule |
| --- | --- |
| Length | 300 graphemes and 3000 bytes. Both, confirmed from the live `app.bsky.feed.post` lexicon. Count graphemes with a proper segmenter, not `String.length`. Over limit is a hard reject, not a truncation |
| Mentions | Reject any draft containing a mention facet for anyone other than the account being replied to. This is the anti-mass-tagging gate and it closes the ugliest injection outcome |
| Links | At most two, and every link must appear in the callback's `links` array. A link the model composed rather than looked up is a link that can be wrong. Do not settle for a host allowlist: it passes an invented path on a real domain, which is the failure that matters |
| Duplicates | Reject a draft byte-identical to the last reply sent to the same account |
| Empty | Reject empty or whitespace drafts rather than posting a blank record |
| Kill switch | A flag that makes the poster drop everything while the consumer keeps running. Being able to go quiet in ten seconds without a deploy is worth building on day one |

Log every rejection with the draft that caused it. That log is the eval corpus
for improving the agent's prompt.

## Posting

- `text` is **300 graphemes and 3000 bytes** maximum, from the live lexicon.
  Graphemes bind for English, bytes for anything with wide characters. Enforce
  both.
- `reply` requires `root` and `parent`, each a strong ref with **both `uri` and
  `cid`**. The root comes from the parent's own `reply.root` when the parent is
  itself a reply, otherwise the parent is the root. Getting this wrong detaches
  the reply from the thread in most clients.
- Link facets use **UTF-8 byte offsets**, inclusive start and exclusive end. Do
  not compute them from JavaScript string indices. Use a real richtext helper
  rather than writing the offset math yourself.
- Set `langs`. It accepts up to 3 entries.
- One post per reply. Never a thread.

## Data model

SQLite on the droplet covers all of it. Nothing here needs Postgres.

| Table | Holds |
| --- | --- |
| `cursor` | Last processed Jetstream cursor, one row |
| `seen` | `(did, rkey)` primary key, the dedup table |
| `queue` | Matched posts and their status through the pipeline |
| `replies` | What was posted, when, to whom, and the draft it came from |
| `rejections` | Rejected drafts with the gate that caught them |
| `denylist` | DIDs that opted out or were blocked |

`queue` wants at least: the match, the computed `threadRoot`, a status
(`matched`, `sent_to_agent`, `drafted`, `posted`, `rejected`, `failed`), the
draft `key` with a unique constraint, and timestamps for the reconciliation
sweep.

## Configuration

Environment, never committed:

| Variable | What |
| --- | --- |
| `ATPOTATO_DID` | `did:plc:qntsxa2i4sb24noi45fx4np2`. The main `@atpota.to` account, shared with its human posting. Hard-code it, do not resolve at runtime |
| `ATPOTATO_HANDLE` | `atpota.to`. For logging and links only, never for matching |
| `PDS_URL` | `https://pds.atpota.to` |
| `ATPROTO_APP_PASSWORD` | The posting credential. Only this service ever holds it |
| `AGENT_URL` | The deployed eve agent's base URL |
| `DROPLET_SHARED_SECRET` | Must match the same variable in the agent's Vercel environment |
| `DROPLET_CALLBACK_URL` | Where the agent posts drafts. Must be reachable from Vercel |
| `JETSTREAM_URL` | Defaults to `wss://jetstream.us-east.bsky.network` |
| `GLOBAL_RATE_PER_HOUR` | Start at 10 |
| `KILL_SWITCH` | When set, the poster drops everything |

Put the gate thresholds in configuration rather than constants. You will want to
change them without a deploy, and this repository is public.

## Milestones

**1. Detect, post nothing.** Consumer, matcher, dedup, cursor, and the
notification sweep. Write every match to `queue` and stop there. Run it for
several days.

You get three things nothing else gives you: what people actually send, what the
post firehose really costs on this droplet, and the gap rate between Jetstream
and notifications, which tells you whether the sweep is earning its place.

Done when you have a few hundred real matches to read and you know what fraction
are questions.

**2. Gates.** Every inbound and outbound gate, with unit tests. No network in
the tests; feed them recorded events.

**3. Draft, post nothing.** Wire the agent call and the callback receiver.
Drafts land in `queue`, readable next to the post that prompted them. Read a few
hundred.

This is the last point where mistakes are free. Do not rush it.

**4. Post.** Global rate at 10 per hour, denylist empty, kill switch tested for
real. Raise the ceiling when the queue has been boring for a week.

## Test checklist

These are the ones that will actually save you:

- A post mentioning atpotato by facet DID matches. A post containing the literal
  text `@atpota.to` with no mention facet does not.
- A reply whose `parent.uri` is a post **the bot wrote** matches.
- A reply whose `parent.uri` is a **human-authored** post from the same DID does
  not match. This is the one that protects the brand account, so test it with a
  real announcement post's URI.
- A reply to a post atpotato **reposted** does not match.
- The same event delivered twice produces one reply.
- A thread already containing 3 atpotato posts produces none.
- A post from atpotato's own DID produces none, under every code path.
- A backfill of week-old events produces no replies.
- A draft of 301 graphemes is rejected, not truncated.
- A draft containing a mention facet for a third party is rejected.
- A reply to a reply carries the thread's original root as `reply.root`, not the
  parent.
- `threadRoot` for a top-level mention is the post's own URI.
- The kill switch stops the poster while the consumer keeps consuming.
- A callback delivered twice with the same `key` posts once.
- `forget me` adds the DID to the denylist and a later mention produces nothing.

## Rate limits and budget

Bluesky's documented per-account limits: 5,000 points per hour and 35,000 per
day, where a CREATE costs 3 points, so 1,666 records per hour. The
Bluesky-operated relay also limits PDS instances to 50 repo stream events per
second, 2,600 per hour, and 21,000 per day, raisable on request.

For a self-hosted PDS the per-account write policy is yours, but the relay
limits still govern what federates out, so 2,600 per hour is the figure to
design against.

None of this binds for a bot answering questions. Set the global gate far below
it anyway. The limit that protects you is not the protocol's; it is the one that
stops a runaway loop from posting 400 times before anyone notices.

Separately: every mention that reaches the agent is a model turn with tool calls
behind it. One thread going viral is a bill. Get a spend ceiling and an alert on
the Vercel side before milestone 4.

## Things not to do

- Do not give this service, or the agent, the ability to follow, like, block,
  mute, or label. Replies only.
- Do not post on a schedule. It replies when spoken to.
- Do not answer DMs. Different lexicon, different privacy expectations.
- Do not skip the substance gate because the agent "will figure out" whether to
  answer. That decision is yours and it is deterministic.
- Do not put the app password anywhere except this service's environment.
- Do not let a draft reach `createRecord` without passing every outbound gate,
  including on retry paths.

## Definition of done

Milestone 4 running for a week with: no reply the author would call spam, no
duplicate replies, no thread the bot talked itself into, a kill switch someone
other than you has used successfully, and a rejection log you actually read.

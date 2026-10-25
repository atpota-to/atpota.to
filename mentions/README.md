# atpotato mentions service

Watches the atproto firehose for people mentioning or replying to
[@atpota.to](https://bsky.app/profile/atpota.to), decides in code whether each
one deserves an answer, asks the eve agent for a draft, decides in code whether
the draft is safe to post, and posts it as a reply.

It holds the only atproto write credential in the system. The agent has none and
has no write tool. **That split is the security model.** The inbound surface is a
public text field; a prompt rule is a request, a conditional in `src/gates/` is a
guarantee. If a prompt injection succeeds completely, the worst outcome should be
a draft the outbound gates reject.

> **Status: built, tested, and running at stage 1 (detect only).**
> Nothing is sent to the agent and nothing is posted. See
> [Milestones](#milestones) for what moving up involves, and
> [Before stage 4](#before-stage-4) for what is still missing.

---

## Where it lives

The code is `mentions/` in [atpota-to/atpota.to](https://github.com/atpota-to/atpota.to).
The droplet runs it from `/root/atpota-live/mentions`, a release of `main` that
[`droplet/deploy.sh`](../droplet/deploy.sh) installs. Secrets and live state
(`.env`, `mentions.db`, `gates.json`, `KILL`, `backups/`) stay in
`/root/atpotato-mentions`, the service's working directory, and are never committed.
`src`, `test`, `scripts` and `package.json` there are links to the live release, so
the commands below still work from that folder.

To deploy, merge to `main`. A GitHub Action has the droplet run the tests on the new
release, wait until no reply is in flight (`npm run in-flight`), restart, and check
`/health`. If the service isn't healthy, it rolls back by itself. See
[`droplet/README.md`](../droplet/README.md).

## Running it

```bash
cd /root/atpotato-mentions
cp .env.template .env && $EDITOR .env      # STAGE=1 to start
npm test                                    # 105 tests, no network
systemctl start atpotato-mentions
journalctl -u atpotato-mentions -f
```

Reading what it has collected:

```bash
npm run stats                # the milestone-1 numbers
npm run stats -- 24          # last 24 hours
npm run review               # matches next to the posts that prompted them
npm run review -- 50 drafted # only drafts, for milestone 3
```

### Going quiet

Three levers, and only the first two are safe to reach for during an incident.

```bash
touch /root/atpotato-mentions/KILL      # stop posting      — live, no restart
```

**The kill switch is fully independent of `STAGE`.** `killSwitchEngaged()` is
called at post time and re-reads the env var and the file every call, nothing is
cached, and it is check #1 of the outbound gates — *before* the stage check, and
on the only code path that can reach `createRecord`. So at stage 4 you touch one
file and the next post is refused, without touching a dial that also means
something else. It is checked a second time immediately before the network call,
because the gap between the two spans a dynamic import and, on the first post
after a restart, a `createSession` round trip; a switch thrown in that window is
still honoured.

It **drops rather than pauses**, as the brief specifies: a draft caught by it is
recorded `rejected` with the gate that caught it, and is not posted later when
the switch is cleared. Clearing it affects the next reply, not the backlog.

```jsonc
// gates.json — stop the agent turns (and the bill) — live, no restart
{ "globalPerHour": 0 }
```

The kill switch stops the *poster*; the consumer and the agent keep running, so
at stage 4 a viral thread is still costing model turns while you are quiet.
`globalPerHour: 0` is the lever for that — the global rate gate is an inbound
gate, so nothing reaches the agent at all, and `gates.json` is re-read on mtime
change. Use both together to go completely silent and stop spending.

```bash
# STAGE — read once at startup. Needs a restart. NOT an incident lever.
```

`STAGE` is deliberately not live: it is the milestone dial, and the two levers
above are what an incident wants.

**This needs Node 22** (`node:sqlite`). The default `node` on this droplet is 18,
where the failure is an opaque module error. The unit file and every npm script
use `/opt/node22/bin/node` explicitly, and `src/index.js` refuses to start on
anything older with a clear message.

---

## Milestones

Stage is a runtime dial in `.env`, not four branches. Below stage 4 the poster is
not merely skipped -- it is never reached, and the stage is re-checked at the
post call itself.

| `STAGE` | What runs | What it cannot do |
| --- | --- | --- |
| 1 | consumer, matcher, dedup, cursor, notification sweep | send anything anywhere |
| 2 | + all inbound gates, verdicts recorded | send anything anywhere |
| 3 | + agent dispatch, callback receiver, outbound gates | post |
| 4 | + posting | — |

Move up one at a time. Stage 3 is the last point where mistakes are free.

---

## What was measured, not assumed

Everything in this section was checked against the live network on 2026-09-18
from this droplet. Several of them contradict the obvious guess.

### The brief's Jetstream host was down; its endpoint shape was right

| Host | `/xrpc/network.bsky.jetstream.subscribeEvents` | `/subscribe` (v1) |
| --- | --- | --- |
| `jetstream.us-east.bsky.network` | **503** | **503** |
| `jetstream.us-west.bsky.network` | OK | OK |
| `jetstream2.us-west.bsky.network` | 404 | OK |
| `jetstream1.us-west.bsky.network` | 404 | OK |

So the default host list is **west first, east second**. Both are consumed at
once; duplicates cost nothing because `seen` de-dupes on `(did, rkey)` before
anything else happens. East is still listed so it is used the moment it returns.

### v2's wire format is not v1's, and mixing them fails silently

```jsonc
// v2: everything flat on payload
{"$type":"message","payload":{"did":"…","rkey":"…","cid":"…","collection":"…",
  "operation":"create","record":{…},"seq":26065109699,"time":"2026-09-18T…"}}

// v1: nested under commit, with time_us
{"did":"…","time_us":1789757659959692,"cursor":26065109877,"kind":"commit",
  "commit":{"rkey":"…","record":{…},"cid":"…"}}
```

Code written for v1 matches **nothing at all** against v2. No error, no warning,
just a consumer that never fires. `normaliseCommit()` accepts only v2, and a
test asserts a v1-shaped event does not normalise.

### v2 cursors are `seq`, replay is exact, and a wrong-space cursor does not error

| cursor passed | result |
| --- | --- |
| `seq - 1000` | exactly 997 events back |
| `seq - 100000` | exactly 100000 back, 196s older |
| `seq - 5000000` | exactly 5000000 back, 2.6h older |
| a v1-style `time_us` | **accepted**, resumed from an unrelated point |
| `1` (aged out) | **HTTP 400**, connection refused |

Two traps. Handing v2 a v1 microsecond cursor silently resumes from the wrong
place, so cursors are stored per host and only ever read back as a `seq`. And
unlike v1 -- which silently started from the oldest event it still had -- v2
*refuses* an aged-out cursor. A long outage therefore produces a connection that
can never succeed until the cursor is dropped.

### Node's WebSocket hides the HTTP status, so the consumer self-heals instead

A 400 and a 503 both arrive as `Received network error or non-101 status code`.
Rather than parse that string, four consecutive failures while holding a cursor
drop the cursor and retry from the live tail, logging loudly. That recovers from
both causes, and the notification sweep covers the gap it leaves.

Two bugs were found here while building this, and both presented the same way:
**the service looked healthy and was wrong.**

*A failed HTTP upgrade fires `error` and not `close`* in this runtime. The first
version assumed `close` always followed, so the dead us-east socket never
retried — silently, for the life of the process. Had us-west been the failing
host, the service would have looked fine and consumed nothing. Caught by
watching the log: us-east appeared once and was never mentioned again.

*The settle guard was shared across reconnect attempts.* A superseded socket
firing a late `close` would therefore have started a **second** reconnect chain
for the same host — two live sockets, then four, every event counted twice over.
This one was found by reading the code rather than by observing it misbehave, so
it is a latent bug fixed before it bit, not a diagnosis of anything. Everything
is now guarded on `ws === sock`: a replaced socket settles nothing and its stray
messages are ignored.

Both are pinned by `test/jetstream.test.js`, which drives the consumer through a
fake WebSocket with no network.

### The stats line was lying, and that was its own bug

The first production stats line reported **240 posts/s** while a direct
measurement taken minutes later showed 48. The reported figure divided the
window's event count by the *nominal* 300-second interval, but the timer had
actually run 466 seconds after start — so the rate was inflated by the ratio of
those two numbers. It now divides by real elapsed time and reports the raw
socket count alongside the filtered one.

Worth keeping in mind generally: a derived number in a log line is code like any
other, and this one was wrong in the direction that makes capacity planning
look scarier than it is.

### The cost of filtering the whole post firehose here

You cannot use Jetstream's `dids` filter — you do not know in advance who will
mention you — so this consumes every `app.bsky.feed.post` commit and filters in
process. Measured three ways — two standalone 60s samples, and a full 300s
window from the running service:

| | |
| --- | --- |
| throughput | **46–61 posts/sec** (46.3/s over a full 300s production window) |
| bandwidth | 45–55 KB/s, ≈ **4–5 GB/day** |
| CPU | **1.2%** of one core |
| RSS | **52–76 MB** — see the note below |

Of 14,535 frames in that window, 13,909 were `create` operations — the rest are
edits and deletes, which are not questions and are dropped in `normaliseCommit`.

**Memory over a long run is the one number still unsettled.** Across the only
two comparable 300s windows, `process.memoryUsage().rss` rose 51.7 → 76.3 MB,
while the cgroup's `memory.current` — the figure `MemoryMax=192M` actually
enforces — sat at 40–42 MB and did not trend. That pattern is what V8 growing
its heap toward a steady state looks like, and the cgroup number reclaiming is
the evidence for it, but two points are not a trend in either direction. The
stats line now logs `heapMb` alongside `rssMb`: **if `heapMb` climbs steadily
across many windows the process is retaining objects and something is leaking;
if only `rssMb` climbs and the cgroup stays flat, it is not.** Worth a glance
during the milestone-1 run:

```bash
journalctl -u atpotato-mentions -o cat | grep '"msg":"stats"' \
  | tail -40 | grep -o '"rssMb":[0-9.]*\|"heapMb":[0-9.]*'
```

For comparison, the four existing consumers on this box each see ~1.2 events/s
because they filter server-side to narrow collections. This one is ~50x their
traffic and still cheap. Bandwidth is the real cost, not CPU or memory.

Shape of that traffic, over 1,320 consecutive posts: **2.3%** carry a mention
facet, **50.8%** are replies, and **5.6% declare no `langs` at all** — which is
why the language gate treats a missing `langs` as "not filtered" rather than
"unsupported".

### The lexicon limits are what the brief said

Confirmed from the live `app.bsky.feed.post` lexicon: `maxGraphemes: 300`,
`maxLength: 3000` (bytes), `langs` `maxLength: 3`.

---

## Which account you watch decides the gate settings

This is the single biggest lever in the service, and it has been set wrong twice
by not asking the question first.

| | brand account (`@atpota.to`) | dedicated bot account (`@poe.atpota.to`) |
| --- | --- | --- |
| why it gets mentioned | roundups, thanks, jokes, being namechecked | somebody wants to use it |
| cost of a false positive | high — barging into a showcase | low — answering a compliment |
| cost of a false negative | low | high — it had one job |
| `substanceMinChars` | `null` (length off) | `40` |

Both are live configurations and both are covered by tests. Switching accounts
means switching this too, and `./scripts/switch-account.sh` does not do it for
you — it is a judgement about the population, not about the credential.

## The substance gate deserves your attention

The brief says so, and the first real measurement agrees.

Against 27 real posts addressed to a busy account, the gate as first written
passed **96%** of them — while only **11%** actually contained a question. The
`substanceMinChars` floor of 12 was doing the damage: almost any real post clears
12 characters, so the length signal made the whole conjunction a no-op.

| `substanceMinChars` | would pass |
| --- | --- |
| 12 | 96% |
| 30 | 93% |
| 60 | 63% |
| **80** (current default) | **63%** |
| 120 | 48% |
| length signal off entirely | 44% |

The default is now **80**. Note that even with the length signal removed, 44%
still pass, because the request-word list (`how`, `does`, `is there`, …) catches
ordinary conversational prose.

Short genuine questions do not depend on this floor — `@atpota.to explain
lexicons` passes on the request word, not on length — and a test pins that.

**This sample is a political account's replies, not atpotato's mentions, so the
population is different.** Re-run `npm run stats` at the end of milestone 1; it
prints the same sensitivity table against real traffic so the threshold can be
chosen from data rather than from a guess.

---

## Architecture

```
Jetstream v2 (public, no auth)
        │  app.bsky.feed.post commits, ~50/s
        ▼
  consumer ──► matcher ──► inbound gates ──► queue ──┐
                                                      │
  notification sweep ─────────┘ (safety net)          │
                                                      ▼
                          POST /bluesky/mention   [vercel] eve agent
                          (shared secret)             │
                                                      │
  outbound gates ──► poster ──► createRecord  ◄── POST <callback>
```

One process, one systemd unit. The consumer, the callback server and both sweeps
are all I/O bound, and this droplet has 960 MB of RAM and has swap-locked before,
so three processes would cost three Node heaps for no benefit.

**Zero dependencies.** Node 22 supplies `node:sqlite`, a global `WebSocket`,
`fetch` and `Intl.Segmenter`, which is everything this needs. For the one
component holding the only write credential, on a memory-constrained box, that
is worth more than the convenience of a client library.

| File | Holds |
| --- | --- |
| `src/matcher.js` | what counts as a mention or reply; thread-root computation |
| `src/gates/inbound.js` | every decision about whether to reply |
| `src/gates/outbound.js` | every decision about whether a draft is safe |
| `src/jetstream.js` | v2 consumer, cursor handling, reconnect, self-heal |
| `src/poster.js` | the only path to `createRecord` |
| `src/callback.js` | receives drafts; idempotency by `key` |
| `src/notifications.js` | the safety net |
| `src/reconcile.js` | turns dispatched with no draft coming back |
| `src/richtext.js` | grapheme counting and UTF-8 byte offsets |
| `src/weather-posts.js` | Poe's weather posts: the watcher, the draft callback, the poster |
| `src/gates/weather.js` | every decision about a weather post |
| `src/profile-look.js` | Poe's avatar and banner changing with the sky |

---

## Matching

**Mention:** a facet feature of type `app.bsky.richtext.facet#mention` whose
`did` is ours. **Never** the literal string `@atpota.to` — facets are what the
posting client actually resolved; text is just text, and the two can disagree by
accident or on purpose. A test pins both directions.

**Reply:** `record.reply.parent.uri` starts with `at://<our did>/`.

**Quote posts are not answered.** Quoting is usually commentary about us rather
than a question to us, and replying reads as barging in. A post that quotes us
*and* replies to us matches on the reply.

`threadRoot` — the agent's session address, which maps a thread to one durable
conversation so follow-ups keep their context — is `record.reply.root.uri` when
the post is itself a reply, otherwise the post's own URI. The same computation
produces `reply.root` for the post we send, and `authorDid` always comes from the
signed record, never from parsing text.

## Gates

Inbound, in order. Every one exists because a bot without it has embarrassed
somebody:

`self` → `opt_out` → `denylist` → `bot_loop_backoff` → `staleness` → `language`
→ `substance` → `mention_crowd` → `thread_depth` → `bot_loop` → `per_account_rate`
→ `global_rate`

`mention_crowd` needs care, because the obvious version of it is wrong. A post
that tags a pile of accounts is usually a roundup rather than a question — but
two people arguing about atproto who tag the potato in to settle it is the whole
point of this bot, and Bluesky's composer prefills every thread participant's
handle at the start of a reply. Counting handles alone drops exactly the case
the bot exists for: a genuine question in a four-person thread arrives carrying
three other handles.

So the gate is not about *how many* accounts a post tags, but about whether we
are **addressed** or merely **referenced**. Our mention's facet offset is
compared against the text before it: if that prefix is only other handles and
punctuation we are part of the address block, however long it is. If it contains
real words — `featuring: @a, @b, … @atpota.to and @c` — we are being named in
passing. Only a crowd *and* a passing reference drops the post.

Self is first on every code path — the matcher refuses it, the pipeline refuses
it, and the gates refuse it. It is the one failure that compounds without limit.

Opt-out is checked **before** the denylist and before every rate limit: somebody
asking to be left alone has to be heard even when they are already rate limited,
or the only way to opt out is to not be talking to us.

Outbound: `kill_switch` → `empty` → `length_graphemes` → `markdown` →
`third_party_mention` → `too_many_links` → `unsourced_link` → `duplicate`.

`markdown` exists because Bluesky renders none of it. A real draft on
2026-09-23 opened `**partly.**` and closed with
`*(285 characters, ready to post as a single reply.)*`, which would have
published both literally. The second is the model narrating the post instead of
writing it, and it is what took that draft from 285 graphemes to 348. Rejecting
rather than stripping keeps it in the rejection log, where a prompt problem
belongs.

`length_graphemes` no longer means "too long" on its own. An over-length answer
is split at sentence boundaries across up to `maxPosts` posts, each measured on
its stored form, and chained so `reply.root` never moves while `reply.parent`
walks down the chain. It rejects only when the answer needs more posts than the
cap, or when a single sentence will not fit alone, because breaking inside a
sentence is the thing the split exists to avoid. Sentence detection is hand
rolled: `Intl.Segmenter` wants a capital after the period and this voice is
lowercase, so it returns a whole answer as one segment.

A thread counts as **one reply** for the rate limits and the thread-depth cap.
Those gates exist to stop the potato answering too often, not to stop it
finishing a sentence.

Every rejection is logged with the draft that caused it, in the `rejections`
table. That is the eval corpus for the agent's prompt, so it keeps the whole
draft rather than a summary. `npm run review -- 50 rejected` reads it.

Thresholds live in `gates.json`, re-read whenever the file's mtime changes, so
they can be moved without a deploy. A malformed edit keeps the last good values
and logs an error rather than silently reverting to something more permissive.

### Two places this is stricter than the brief

**The poster never builds mention facets at all.** Only link facets. A stray
`@handle` in a draft therefore notifies nobody even if the gate somehow missed
it, which closes the mass-tagging hole at the record level rather than only at
the check. The gate still rejects third-party handles, because it still *reads*
as tagging.

**Opt-out phrases are matched as demands, not as words.** A denylisting is
permanent with no appeal flow, so a false positive silently and forever stops
answering somebody who was asking a question — and several stop phrases are
perfectly ordinary things to ask an atproto bot: *"how do I opt out of the
firehose?"*, *"how do I make the PDS forget me?"*, *"does the error go away if I
rebuild?"*. A question mark, a request word, or more than 80 characters means it
is prose, not an opt-out. `go away` was dropped from the phrase list entirely.

---

## Known gaps

**The link gate enforces the brief's rule exactly — confirmed live.** The rule
is "every link must have appeared in a tool result from that turn", and the
brief's callback contract carries only `{key, threadRoot, text}`. The callback
was written to accept an optional `links: string[]` in case the agent ever sent
one. On 2026-09-23 the first real draft arrived with that array populated, so
the exact rule is in force and the host allowlist is only a fallback.

Its first act was to reject a correct answer, which is worth recording. The
draft ended `…owned by whoever owns bsky.app. …spec: https://atproto.com/specs/nsid`,
and link detection read the bare `bsky.app` in that sentence as a link. It was
not in the tool results, so the whole draft was refused. Explaining atproto means
naming domains in prose constantly, so this would have rejected a large share of
good answers. Detection is now limited to explicit `https://` URLs: when the
agent offers a destination it writes the whole URL, and prose stays prose.

**Two mentions in one thread are matched to their drafts FIFO.** The callback
carries no postUri, so threadRoot alone cannot say which post a draft answers
when two turns are in flight at once. The agent runs a thread's turns in order
within one session, so the oldest turn still waiting gets the next draft. This
is inference from the agent's behaviour rather than a guarantee from the
contract; a postUri in the callback would make it exact.

**`forget me` cannot wipe agent memory yet.** The denylist half works and is
tested. The memory half logs a warning recording the obligation, because agent
memory does not exist yet.

**The agent contract is implemented from the brief, not read from the source.**
`bot/agent/channels/bluesky.ts` and `bot/agent/lib/bluesky.ts` are not on this
droplet — the repository here is `dame.is`, and the atpotato repo is not checked
out. Everything in [The contract](#the-contract) below follows the brief exactly,
but it has not been diffed against the code that implements the other side.
**Check it before stage 3.**

**The notification sweep is untested against the live endpoint.** It needs
`ATPROTO_APP_PASSWORD`, which is not set. With no password it disables itself
with a warning and Jetstream becomes the only detection path, with no cover for
gaps. `app.bsky.notification.listNotifications` is called through the PDS, which
proxies `app.bsky.*` to its appview; that proxying is assumed and unverified.

---

## The contract

We call the agent:

```
POST <AGENT_URL>/bluesky/mention
x-atpotato-secret: <shared secret>

{ "threadRoot": "at://…", "postUri": "at://…", "authorDid": "did:plc:…",
  "authorHandle": "…", "text": "verbatim", "reason": "mention" | "reply" }
```

`202` accepted, `401` bad secret, `400` validation failed. The `202` is not a
draft; it means the turn was dispatched.

The agent calls back:

```
POST <DROPLET_CALLBACK_URL>
x-atpotato-secret: <shared secret>

{ "key": "<sessionId>:<turnId>", "threadRoot": "at://…", "text": "the draft",
  "links": ["https://…"] }        // optional, see Known gaps
```

`key` is an idempotency key under a UNIQUE constraint. The endpoint answers 2xx
only **after** the draft is durable, because the agent drops a draft it cannot
deliver — it logs and moves on rather than failing the turn. A duplicate
delivery still gets a 200 so the agent stops retrying, and does nothing.

Because delivery cannot be assumed, `src/reconcile.js` re-dispatches anything
sitting in `sent_to_agent` for more than 5 minutes, twice, then fails it loudly.
A turn whose post has aged well past the staleness window is not retried at all —
replying to a two-hour-old question reads as a bot waking up, not as an answer.

The callback listener binds to `127.0.0.1` and needs a TLS terminator in front of
it before Vercel can reach it. That is not set up yet.

---

## Before stage 4

- [ ] Diff [The contract](#the-contract) against `bot/agent/channels/bluesky.ts`.
- [ ] Set `ATPROTO_APP_PASSWORD` and confirm the notification sweep works.
- [ ] Put TLS in front of the callback listener; set `DROPLET_CALLBACK_URL`.
- [ ] Send the agent's tool-result links so the link gate is exact.
- [ ] Get a Vercel spend ceiling and an alert. One thread going viral is a bill.
- [ ] Announce the opt-out phrases in the profile bio.
- [ ] Have somebody **other than you** use the kill switch successfully.
- [ ] Read a few hundred drafts at stage 3. Do not rush this.

## Rate limits

Bluesky documents 5,000 points/hour and 35,000/day per account, a CREATE costing
3 points — 1,666 records/hour. The Bluesky-operated relay separately limits a PDS
to 50 repo stream events/second, 2,600/hour, 21,000/day. For a self-hosted PDS
the per-account write policy is ours, but the relay limits still govern what
federates out, so **2,600/hour is the figure to design against**.

None of this binds for a bot answering questions. `globalPerHour` starts at 10.
The limit that protects you is not the protocol's; it is the one that stops a
runaway loop from posting 400 times before anyone notices.

## This is the fifth consumer on this box

It keeps its own cursor, its own database and its own directory. It does not
touch `jetstream-consumer` (anisota), `mod-consumer`, `tracker-jetstream` or
`turtle-jetstream`, and can be stopped or deleted without affecting any of them.
Capped at `MemoryHigh=150M` / `MemoryMax=192M` / `CPUQuota=50%`, roughly 3x the
measured peak — the box has 960 MB and has swap-locked before.

## Operator DMs (opt-in)

Poe's DM bridge runs on this service, not on Vercel. Set `OPERATOR_DM_ENABLED=true`
only after the bot deployment has `/operator/dm`. The service needs `ADMIN_DIDS`,
`ATPROTO_APP_PASSWORD`, `DROPLET_SHARED_SECRET`, and `STAGE=4`. Restart
`atpotato-mentions.service` after changing the environment. Poll frequency is
`OPERATOR_DM_POLL_MS` (default 60000, minimum 30000 milliseconds). The first
start saves a timestamp in `operator_dm_state`; older inbox messages are not
answered. Messages from non-admin DIDs and group chats are ignored. Only an authenticated admin conversation request is accepted, immediately before sending its reply.

An ordinary operator DM gets a private answer. Poe can selectively save private
notes about the operator and memorable moments from DMs without a command prefix.
These notes are recalled only in operator DMs and never become public person notes
or lessons. Poe can also recall its public-conversation life journal in DMs.

When the poll picks up an operator DM, Poe reacts to it with 👀 (`SEEN_REACTION`,
`chat.bsky.convo.addReaction`) and takes the reaction off once its reply is sent, so
"seen, working on it" shows before the answer does. It is best effort: a reaction
that fails is logged and never holds up the reply, and a message request gets none,
because the convo is only accepted when the reply goes out.

A chat message holds 1000 graphemes and 10000 bytes. A longer reply is sent as up to
`DM_MAX_PARTS` (4) messages in a row, cut at paragraph breaks, then sentences, then words
(`splitDmText`); the first answers the operator's message and the rest follow it, and past
the fourth the reply ends with an ellipsis. `parts_sent` records how far a reply got: a part
that fails leaves the row in `sending` for review, like a single send, and is never resent.
An operator-confirmed fact about Poe may go into shared self memory only if it
is safe to recall in public conversation. Prefix `style:` to store a private,
standing voice note in droplet SQLite; future public Bluesky turns receive up
to 30 active notes. The notes are never published as PDS records. Private
memory uses the bot's Vercel Blob store; Eve also keeps DM session history.
Inbound message text and drafts are held in local SQLite. Anyone with access
to those stores can read them. The DM bridge does not log message text; review
Vercel and Eve telemetry separately before sending sensitive material.

Outgoing sends are claimed in SQLite before calling chat. If a network failure
leaves a row in `sending`, inspect the DM conversation before manually retrying;
a timeout might mean the chat service accepted the message. `dispatched` with no
callback also needs manual review. The kill switch and `STAGE` gate outgoing DMs.

## Weekly dispatch: `announce`

Issues of "poe's atmosphere dispatch" are `site.standard.document` records in
**atpota.to's** repo, in the Leaflet publication
`at://did:plc:qntsxa2i4sb24noi45fx4np2/site.standard.publication/3myar4h4pls2n`.
Poe drafts them and publishes them on the operator's yes (see
[Weekly dispatch: Poe writes it](#weekly-dispatch-poe-writes-it-dispatch_drafts)),
or they are published in Leaflet by hand. Posting the announcement for one
published by hand is the step an operator can't do themselves, so an operator
DMs Poe:

```
announce https://poe.leaflet.pub/<rkey>
optional post text, on the lines after the link
```

The link may also be `https://atpota.to/blog/<rkey>` or the document's at-uri, or
the command can be `announce latest` (also "announce the latest dispatch"): the
newest document in the publication by `publishedAt`, resolved once and stored.
Only an `ADMIN_DIDS` sender is heard, and the command is never forwarded to the
agent. `src/dispatch.js` then:

1. reads the document (public `getRecord`), refuses it unless it is in the
   dispatch publication, and stops with the existing post's link if the
   document already has `bskyPostRef` or `dispatch_document` already has a post;
2. polls the page at `DISPATCH_ANNOUNCE_URL_BASE/<rkey>` (`https://atpota.to/blog` by default) every 20 s for up to
   10 minutes until it answers 200 with
   `<link rel="site.standard.document" href="<at-uri>">`, and gives up without
   posting otherwise;
3. posts from Poe: the operator's text (refused, not cut, over 300 graphemes)
   or the title and description, an `app.bsky.embed.external` card with the
   page's og:image as its thumbnail, `langs: ["en"]`, and no facet but the
   issue link. The card is a standard.site card when its `associatedRefs` pin
   the document and the publication (public `getRecord`) and its uri is the
   publication's `url` joined to the document's `path`: the Bluesky AppView
   enriches nothing else. So the refs go on only when the publication's `url`
   is `DISPATCH_ANNOUNCE_URL_BASE` (`https://atpota.to/blog`); otherwise, or
   when the publication can't be read, the card is a plain one and the reply
   says why.
   The post's TID record key is stored **before** `createRecord`,
   so a retry after a crash or timeout finds the post under that key instead
   of posting twice;
4. puts the document back with `bskyPostRef` and `updatedAt` set, every other
   field unchanged, under `swapRecord` (one re-read and retry on `InvalidSwap`).
   This uses the atpota.to app password (`DISPATCH_PUBLISHER_APP_PASSWORD`), in
   its own session that can write nothing but documents in that publication.
   Without it, the reply carries the manual `publish:dispatch --bsky-post`
   command instead;
5. replies with the post's URL.

Every step is recorded in `dispatch_document`, `dispatch_command` and the
`dispatch_event` audit log, and a command a restart interrupts is finished by
the next DM poll (its `operator_dm` row waits in status `command`). Sending the
same command again is always safe: it resumes, never reposts. The kill switch,
a nap and `STAGE` below 4 all stop it before the page check.

Needs `DISPATCH_ENABLED=true` (off: `announce` DMs go to the agent as before).

Linking waits until the issue has been up for `DISPATCH_LEAFLET_SETTLE_MS`
(5 minutes) after its `publishedAt`. Leaflet emails subscribers from a job that
runs about a minute after the last change it sees to a new document (a 60 s
debounce, at most 3 minutes), and only if that change is the create: putting
`bskyPostRef` on the document inside that window would make the job see an
update, and send nothing. The post itself goes out at once.

### Asking in plain words: Poe proposes, the operator confirms

An operator can also just ask ("issue two is up, can you tell people?"). That
DM goes to Poe like any other. Poe calls the agent tool
`propose_dispatch_announcement`, which posts to `POST /dispatch/announce-proposal`
(shared secret, exposed by nginx):

```
{ "dmId": "<the operator DM Poe is answering>", "operatorDid": "did:...",
  "issue": "latest" | "<link or rkey>", "text": "<the post, optional>" }
```

The droplet accepts it only while that DM is `dispatched` to the agent, from an
`ADMIN_DIDS` sender, at most ten calls per DM. Without `text` it only looks the
issue up and returns its title, description and opening for Poe to write from.
With `text` it checks the post (300 graphemes, no @handles, no link but the
issue's own page, no markdown) and answers `accepted: false` with the reason
when one fails, so Poe can fix it in the same turn. An accepted proposal goes
in `dispatch_proposal` and replaces any earlier one.

When Poe's reply arrives on `/dm-draft`, the exact post is added under it with
"reply yes to post it, or no to drop it". The reply is cut to make room; the
proposal never is. A whole-message yes (`yes`, `ok`, `post it`, `👍`, ...) runs the
announce steps above with exactly that text. A `no` drops it. Either counts
only if it answers the message that showed the proposal: the proposal is the
newest, that message was sent, nothing else was said in between, and it is
under six hours old. Otherwise "yes" is ordinary conversation and goes to Poe.

`announce` followed by a link is still the direct command. `announce` followed
by plain words ("announce that one please") goes to Poe instead of getting the
usage.

### Any post, in plain words: `propose_post`

The same confirmation works for any post from Poe's account (`src/operator-posts.js`).
An operator DMs Poe ("post about the weather right now", "nudge people to subscribe to
the newsletter", "say good morning"), and Poe writes the post and calls its agent tool
`propose_post` with the text and a card: `weather` (the live weather card for
atpota.to/weather, in the forecast design), `newsletter` (atpota.to/blog, with the
blog's own card) or `none`. The proposal comes on the callback URL, told apart by its
`proposal`, so nginx needs nothing new:

```
{ "dmId": "<the operator DM Poe is answering>", "operatorDid": "did:...",
  "proposal": { "text": "<the post>", "card": "weather" | "newsletter" | "none" } }
```

It is accepted only while that DM is `dispatched` to the agent, from an `ADMIN_DIDS`
sender, at most ten calls per DM, and the text is checked (300 graphemes, no
@handles, no link since the card carries it, no markdown), with the reason back to
Poe when it fails. The exact post and its card go under Poe's reply, and a whole-message
yes to that message posts it; the rules for what counts as that yes are the dispatch
announcement's above. The card must load, or nothing is posted and the reply says
why: a weather card is fetched by its own address, as weather posts do.

The operator's yes is the approval, so these posts are not held to the weather
posts' caps. A weather one is then recorded in `weather_post` (kind `operator`), so
the automatic weather posts keep their 2-hour gap from it. The kill switch, a nap
and `STAGE` below 4 stop it. Needs `OPERATOR_DM_ENABLED=true`, nothing more.

## Weekly dispatch: Poe writes it (`DISPATCH_DRAFTS`)

Poe researches and drafts each issue itself, the operator reviews and edits it
in DMs, and it is published on their yes (`src/dispatch-drafts.js`, with the
markdown turned into the record by `src/dispatch-markdown.js`).

```
droplet tick ──► POST <AGENT_URL>/dispatch/draft ──► Poe researches the week
                                                     └─ save_dispatch_draft ──► /callback (versions)
Poe's last word ──► /callback ──► DM to the operator: title, preview link, Poe's note
operator: "cut the tokimeki bit" ──► Poe (in the DM) ──► save_dispatch_draft (edits)
operator: "make it live" ──► propose_dispatch_publish ──► the steps under Poe's reply
operator: "yes" ──► create the document in atpota.to's repo ──► announce() ──► "it's live"
```

1. **Asking.** With `DISPATCH_DRAFTS=on`, the five-minute tick asks for a draft
   at `DISPATCH_DRAFT_DAY` and `DISPATCH_DRAFT_HOUR_UTC` (Monday 12:00 UTC by
   default), up to 20 hours late, once per week: the draft's id is
   `dd-<that date>`. It is skipped (kept as `skipped`, with the reason) when a
   draft from the last three days is still in play, or an issue was published in
   the last three days. An operator can also DM `draft dispatch` (or "write this
   week's newsletter", with what to cover on the lines after) at any time, and
   with `DISPATCH_DRAFTS=ask` that is the only way. The issue covers the time
   since the last issue (when that was a day to two weeks ago) or the last seven
   days. A failed ask is retried on the next two ticks, then given up on with a DM.
2. **Drafting.** The agent's drafting session (its own session per draft, the
   `dispatch` channel) researches with Aturi and `read_weather` and saves the
   issue with `save_dispatch_draft`. Each save arrives on the callback URL as
   `{ draftingId, dispatchDraft: { action: "save", title, description, tags,
   markdown | edits } }`, is turned into the exact `site.standard.document` it
   would publish (Leaflet's `pub.leaflet.content` blocks, with link, bold,
   italic, code and strikethrough facets and never a mention facet), and is kept
   as a new version in `dispatch_draft_version`. Link cards are filled in here:
   a page's title and description (public https hosts only), or a Bluesky post's
   cid for an embed. What didn't come out right goes back to Poe as `notes`.
3. **The DM.** When the drafting turn ends, its last message comes back as
   `{ key, dispatchDraftDone: { draftId, text } }` and the droplet DMs the first
   `ADMIN_DIDS` operator: the title, the preview link, Poe's note. This is a DM
   Poe starts, not a reply, so it goes through `dispatch_outbox`
   (`chat.bsky.convo.getConvoForMembers`, then the message): a send that might
   have gone out is never sent again, like any DM here. A drafting turn that
   hasn't reported back in 90 minutes is settled with the last version it saved.
4. **Reviewing.** The preview is `atpota.to/blog/preview/<token>`, the issue as it
   will look, rendered by the website from `GET /dispatch/preview/<token>` here.
   The token is 24 random characters, one per draft, and the only key: the
   endpoint is public, `no-store`, `noindex`. While `DISPATCH_DRAFTS` is on, every
   operator DM handed to Poe carries `dispatchDrafts: true`, and while a draft is
   in play `dispatchDraft: { id, status, version, title }` too, so Poe knows to
   read it (`read_dispatch_draft`) and save the operator's
   changes as `edits`, each a find (found exactly once) and its replacement. A
   save from a DM puts the preview link under Poe's reply. Saves are serialized
   per draft, at most 40 from a drafting turn and 15 calls per DM.
5. **Making it live.** When the operator says so, Poe calls
   `propose_dispatch_publish` with the version it read and an announcement post
   (checked like any post: 300 graphemes, no @handles, no links, no markdown).
   The steps go under its reply: the issue goes up on poe.leaflet.pub and
   atpota.to/blog, Leaflet emails every subscriber, and the exact announcement.
   A whole-message yes to that message, by the same rules as an announcement's,
   publishes exactly that version; anything else keeps it a draft, and so does a
   draft that changed since.
6. **Publishing.** The yes runs beside the poll (its DM waits in `issue`, so a
   restart finishes it). The document's record key (a TID) and `publishedAt` are
   claimed first; the document is looked up under that key and only created if
   it isn't there, with `com.atproto.repo.createRecord`, never a put: Leaflet
   emails subscribers when it sees a new document created in a publication with
   Newsletter Mode on, whoever wrote it. Then `announce()` posts and links it as
   above, with the link held back until Leaflet has seen the create. Asking again
   is always safe: it never makes a second issue or a second post.

Publishing needs `DISPATCH_PUBLISHER_APP_PASSWORD`. Without it the drafts are
still written and reviewed, and Poe tells the operator it can't publish. The kill
switch, a nap and `STAGE` below 4 stop publishing; a nap also stops the weekly
ask. `npm run drafts` lists the drafts (`npm run drafts -- <id>` shows one with
every version and its log).

Before turning it on: deploy the bot (it adds `POST /dispatch/draft` and the
draft tools), add the nginx block for `/dispatch/preview/` (below), then set
`DISPATCH_DRAFTS=on` (it needs `DISPATCH_ENABLED=true` and
`OPERATOR_DM_ENABLED=true`) and restart. Until `DISPATCH_DRAFTS` is set, DMs are
handed to Poe exactly as before.

## Likes Poe proposes (`appreciate_post`)

The agent's `appreciate_post` tool calls `POST /like-proposal { postUri, attempt }`
during a turn about a public post. `src/likes.js` only marks that turn's queue
row (it must be `sent_to_agent` at that attempt, and not our own post). The
poster writes the like after the whole reply has posted, with the subject cid
stored at match time, never one from the agent. It honours the kill switch, a
nap and `STAGE`, skips denylisted people and probe rows, is capped by
`likesPerHour` (10) and `likesPerAuthorPerDay` (3) in `gates.json`, and goes
out at most once per post. A failed like is recorded in `likes` and not retried.

This widened what the credential may write (2026-10-19): `app.bsky.feed.like`
joined posts, notes and lessons. Follows, reposts and blocks are still refused,
and likes are never deleted.

## Weather posts (`WEATHER_POSTS`)

Poe posts the Atmosphere's weather on its own account now and then: the day's
report, and the moments the weather station catches. `src/weather-posts.js` is
the watcher and the poster; every decision is in `src/gates/weather.js`.

Every `WEATHER_POLL_MS` (5 minutes) the watcher reads the station through
atpota.to's public endpoints, the ones `/weather` reads (`/api/atmosphere` and
`/api/weather-almanac?tz=UTC`), and looks for a moment, most newsworthy first:

| kind | when | once per |
| --- | --- | --- |
| `storm` | the station's last minute is stormy (600+ new records a second) | 12 hours |
| `unusual` | the last hour is 1.4x busier or 0.65x as busy as usual for it, when the station heard at least 45 minutes of it | 12 hours |
| `new_app` | an app the station never heard before has written 250+ records in its first day | 24 hours, and an app once |
| `mixed` | the diversity index is 6 or more ("high") | 24 hours |
| `daily` | the day's report, from 16:00 UTC | UTC day |

Only the station's own readings count; a website sample is too short to call a
storm on. App names are checked as domains and collections as NSIDs before Poe
sees them. Poe is asked about one moment at a time, and not at all while
3 weather posts went out in the last 24 hours (`weatherPostsPerDay`), one went
out in the last 2 hours (`weatherMinGapMin`), or it has been asked 8 times in
24 hours already, skips included (`weatherAsksPerDay`, the model bill). Every
threshold is a `weather*` key in `gates.json`; `weatherKinds` lists the kinds it
may ask about, so removing one turns it off.

A moment goes to the agent as `POST /weather/moment` (shared secret) with the
station's numbers and Poe's last five weather posts. Poe reads the station and
answers with the post, or `skip`, on `DROPLET_CALLBACK_URL`, the URL a reply's
draft comes back on; its `momentId` tells it from a reply, so nginx needs nothing
new. The draft goes through
the reply gates as a single post (length, markdown, non-answers, `@handles`), with
no `@handle` allowed at all, no link but `https://atpota.to/weather`, and not the
same text as the last weather post. With `WEATHER_POSTS=post` at stage 4 it is
posted with an `app.bsky.embed.external` card for the weather page, and the caps
are checked again first. The card's image is always the live weather card,
`https://atpota.to/og/weather.png` (`WEATHER_CARD`), fetched by that address rather
than from the page's og:image, fresh to the minute and in the design that suits the
post (`CARD_FOR`): the sky for a storm, the barometer for an hour off usual, the other
apps for a mixed sky or a new one, the day's chart for the daily report. A redirect
(the website's fallback to the home page's card) counts as no card. Without the card
a post isn't posted bare: the draft waits, and each tick tries again, for up to 30
minutes (`CARD_WAIT_MS`), then it is dropped as `rejected` (`no_card`). The first
weather post, on 2026-10-21, went out under the home page's card because the droplet
deployed a few minutes before the website and read the page's old og:image.
With `WEATHER_POSTS=draft` it stops there as `held`, and counts against the caps
as the post it would have been, so draft mode shows the cadence posting would have.

Each moment is a `weather_post` row: `dispatched`, then `skipped`, `rejected`,
`held`, `posted`, or `expired` (no draft in 15 minutes). The post's TID record
key is stored before `createRecord`, so a post a crash leaves uncertain is looked
up under that key, never posted twice. The kill switch and a nap stop the watcher
asking at all. `npm run weather` lists the rows, newest first, with each draft
and what the gates did with it.

It is on by default (`WEATHER_POSTS=post`), so it starts with the deploy. To stop
it, add `WEATHER_POSTS=off` to `/root/atpotato-mentions/.env` and
`systemctl restart atpotato-mentions`; `WEATHER_POSTS=draft` keeps Poe drafting
but holds every one, for reading with `npm run weather`. The kill switch stops it
at once, without a restart, along with everything else Poe posts. Until the bot's
weather channel is deployed, the agent refuses each moment and the watcher backs
off for 15 minutes and asks again.

## Poe's profile look (`PROFILE_LOOK`)

Poe's avatar and banner change with the sky over New York (`src/profile-look.js`).
The day is cut in four at sunrise and sunset, worked out in code: dawn from half an
hour before sunrise, day from an hour and a half after it, golden hour from an hour
and a half before sunset, night from half an hour after it. Each slot gets one look,
from a roll seeded on the slot, so a restart picks the same one:

- **Avatar:** the season and the time of day, with a face that is usually the time
  of day's own and sometimes another (sleepy on about 7 nights in 10). While Poe
  naps, the face is sleepy.
- **Banner:** the same time of day and season, with the weather station's weather.
  It switches to dispatch day for a day after an announcement, to Halloween week's
  nights or New Year's Eve, or now and then (one slot in forty) to the moon, the
  beach or a cloud.

The pictures come from the website's library (`atpota.to/poe-profile`, named in its
`manifest.json`, made by `website/scripts/poe-profile.ts`), so nothing is drawn
here. A picture is fetched only from there, without following redirects, and must
be a JPEG under 1 MB.

A write changes only `avatar` and `banner` in `app.bsky.actor.profile/self`, and is
swapped against the record as read, so an edit made in between is never written
over. If the avatar or banner isn't the one this service last set, someone changed
it by hand, and the profile is left alone for the rest of that day. A failed write
waits 30 minutes before the same look is tried again. The kill switch stops every
write; a nap doesn't, since a nap is what gives Poe the sleepy face.

It is on by default (`PROFILE_LOOK=on`, stage 4 only), so it starts with the
deploy; the first write replaces whatever avatar and banner the profile has.
`npm run profile-look` shows today's slots, the look each was given, and every
change made. To stop it, add `PROFILE_LOOK=off` to `/root/atpotato-mentions/.env`
and `systemctl restart atpotato-mentions`; `PROFILE_LOOK=dry-run` keeps working
each look out and logging it without writing anything. The kill switch stops it
at once, without a restart.

## nginx

`/etc/nginx/sites-available/hook.atpota.to` forwards only exact paths to this
service; anything else is a 404 at nginx. Every agent → droplet endpoint needs
its own `location =` block, or the agent's call fails without reaching here:
`/callback`, `/dm-draft`, `/memory`, `/health`, `/like-proposal`,
`/dispatch/announce-proposal`, `/internal/bluesky-search`,
`/internal/scan-budget/claim`, `/internal/list-records-budget/claim` and
`/internal/scan-approval/request`. The dispatch's draft previews need a prefix
block, since each has its own token: `location ^~ /dispatch/preview/`. Everything
else the drafts use comes on `/callback`. `/like-proposal` and the four `/internal/`
routes were missing until 2026-10-19, so Poe's Bluesky search, list_records,
collection scans and like proposals all failed in production before then.

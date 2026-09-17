# 07. Build plan

## Prerequisites

- Node 24 or newer (eve's stated requirement)
- A Vercel account
- An Anthropic or OpenAI API key for the model

## Bootstrap

```bash
npx eve@latest init atpotato
cd atpotato
npm run dev
```

Then read `node_modules/eve/docs/`. Those docs match your installed version;
eve.dev documents the latest release, and eve is in beta, so the two will drift.
Where they disagree, the installed ones win, including over this spec.

There is also an official eve skill for coding agents at
`github.com/vercel/eve/blob/main/skills/eve/SKILL.md`. Worth installing if a
coding agent is doing the build.

## Target layout

```text
atpotato/
├── agent/
│   ├── instructions.md              # 03-system-prompt.md
│   ├── instructions/
│   │   ├── page-context.ts          # dynamic user-role context, 04
│   │   └── bluesky.ts               # channel-scoped system rules, 09
│   ├── connections/
│   │   └── atmosphere.ts            # the Aturi MCP connection, 04
│   ├── channels/
│   │   └── bluesky.ts               # inbound mention route, draft callback, 09
│   └── skills/
│       ├── resolve-anything.md
│       ├── explain-to-a-newcomer.md
│       ├── identity-doctor.md
│       ├── repo-archaeology.md
│       ├── backlink-detective.md
│       ├── builder-lookup.md
│       ├── find-your-people.md
│       └── bluesky-reply.md
├── evals/                           # 08-evals.md
├── app/                             # Next.js chat UI
└── next.config.ts                   # withEve(nextConfig)
```

Plus a second deployable that is not part of the eve project: the droplet
service in `09-bluesky-channel.md`. It owns the Jetstream consumer, the dedup
table, the queue, every gate, the atproto credential, and the poster. Keep it in
its own repository with its own tests. It is the component where a bug is
publicly visible.

One root agent. No workspace, no subagents. Subagents exist for delegating to
specialists with their own prompts and sandboxes, and there is no second job
here. Reach for one only if you later add something genuinely separate, like a
writing assistant for the guides.

## Milestones

**M0. It answers.** Agent plus the Aturi connection plus the system prompt,
driven from the terminal UI (`eve dev`). Success: paste an `at://` URI, get a
correct resolution. No frontend yet. This is the milestone that tells you whether
the whole idea works, and it is maybe an afternoon.

**M1. It answers well.** Add the skills. Write the evals from `08`. Run them.
Fix the prompt, not the model, until they pass. Expect to rewrite the routing
guidance at least once.

**M2. It has a face.** `eve add channel/web` for the Next.js chat, then replace
the generated chat with the panel from `06-ui-spec.md`. Wire the five expression
states to stream events. Replace the placeholder auth policy.

**M3. It knows where you are.** Add `page-context.ts` and pass page metadata from
the frontend. This is the step that makes it Clippy rather than a chat box.

**M4. Ship the website.** Deploy to Vercel. Rate limits, spend alerts, kill
switch. Soft launch to people who will tell you the truth.

**M5. Detect, do not answer.** Droplet consumer against Jetstream v2 filtered to
`app.bsky.feed.post`, matching mentions by facet DID and replies by parent URI.
Run it for a few days writing matches to a log and posting nothing. You learn
what people actually send before you have committed to answering it, and you find
out what the real event volume is. Add the `listNotifications` sweep here and
compare the two sources: the difference is your gap rate.

**M6. Gates, then a human in the loop.** Implement every gate in `09`. Wire the
eve channel and the draft callback. Have the poster write drafts to a review
queue instead of posting. Read a few hundred drafts. This is the milestone worth
not rushing, because it is the last one where mistakes are free.

**M7. Let it post.** Start with the denylist empty, the global rate at something
low like 10 per hour, and the kill switch tested. Raise the ceiling when the
review queue has been boring for a week.

## Deploy

eve deploys to Vercel using Vercel Workflow and Vercel Sandbox. Read
`docs/guides/deployment/vercel.md` before the first deploy; the sandbox and
workflow setup is the part most likely to surprise you.

```bash
eve link
eve deploy
```

Environment: the model API key. No Aturi credentials, because the MCP needs none.

## Open decisions

**Model.** Start with the strongest model you are willing to pay for, get the
behavior right, then try to move down. The work here is many small tool calls and
short answers, which is the shape that usually survives a downgrade well. Measure
with the eval suite rather than guessing.

**Memory.** eve supports cross-session memory through Supermemory, a built-in
file provider, or your own. Do not add it for v1. An anonymous public assistant
that remembers you is a privacy surface with no user-facing benefit yet. Revisit
if you later add sign-in.

**Sandbox.** Static markdown skills do not need one; dynamic skills and packaged
skill files do. Everything here is static markdown, so skip it.

**Schedules.** eve can run prompts on a cron. Tempting for something like a
weekly "what's new in the lexicon ecosystem" post. Out of scope for v1, and it
would need a write path that this agent deliberately does not have.

**Jetstream or notifications.** You already run a Jetstream consumer, so the
spec uses it. Be honest with yourself that `listNotifications` polling alone
would cover this use case with a fraction of the machinery, and that Jetstream
means filtering the whole post firehose to find a handful of mentions. The
argument for Jetstream is latency and the fact that the consumer exists. The
argument against is that it is a lot of moving parts for a bot that answers a few
dozen questions a day. Either way, keep the notification sweep, because Jetstream
is at-least-once with a bounded replay window and will lose events across a long
outage.

**Caching.** Not specced here, and it should be before launch. `resolve_identity`
results are stable enough to cache for a while; `sample_jetstream` is not
cacheable at all. If Aturi is yours, the better place for this is the server.

**Observability.** eve supports OpenTelemetry. Turn it on at M4. You will want to
know which tools fail and how often, given the MCP is beta.

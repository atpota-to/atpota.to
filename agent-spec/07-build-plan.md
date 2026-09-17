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
│   │   └── page-context.ts          # dynamic user-role context, 04
│   ├── connections/
│   │   └── atmosphere.ts            # the Aturi MCP connection, 04
│   └── skills/
│       ├── resolve-anything.md
│       ├── explain-to-a-newcomer.md
│       ├── identity-doctor.md
│       ├── repo-archaeology.md
│       ├── backlink-detective.md
│       ├── builder-lookup.md
│       └── find-your-people.md
├── evals/                           # 08-evals.md
├── app/                             # Next.js chat UI
└── next.config.ts                   # withEve(nextConfig)
```

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

**M4. Ship it.** Deploy to Vercel. Rate limits, spend alerts, kill switch. Soft
launch to people who will tell you the truth.

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

**Caching.** Not specced here, and it should be before launch. `resolve_identity`
results are stable enough to cache for a while; `sample_jetstream` is not
cacheable at all. If Aturi is yours, the better place for this is the server.

**Observability.** eve supports OpenTelemetry. Turn it on at M4. You will want to
know which tools fail and how often, given the MCP is beta.

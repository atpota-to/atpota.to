# atpotato agent spec

Working specs and prompts for turning the atpotato mascot into an AI guide to the
Atmosphere: a small, opinionated assistant that resolves things, explains things,
and points people at the right client, built on [eve](https://eve.dev) and
deployed to Vercel, reading the Atmosphere through the
[Aturi MCP server](https://aturi.to/mcp).

**The Bluesky account is the product.** People @ mention it or reply to it and
get a short, useful answer with somewhere to read more. Start at
[`07-build-plan.md`](07-build-plan.md), which is ordered for that build. The
website panel in [`06-ui-spec.md`](06-ui-spec.md) is a separate project for
later and nothing depends on it.

Nothing here is code yet. These are the documents you hand to a builder (human or
coding agent) so the thing that gets built is the thing you wanted.

## The files

| File | What it is |
| --- | --- |
| [`01-product-spec.md`](01-product-spec.md) | What it does, who it's for, what it deliberately does not do, and what we're taking from Clippy versus what we're refusing to repeat |
| [`02-persona.md`](02-persona.md) | Name options, voice rules, the expression state machine, and a copy bank |
| [`03-system-prompt.md`](03-system-prompt.md) | The actual drop-in `agent/instructions.md` |
| [`04-aturi-connection.md`](04-aturi-connection.md) | The eve MCP connection, the 38-tool inventory, and the intent-to-tool routing policy |
| [`05-skills.md`](05-skills.md) | Which skills exist and why, plus the loading contract |
| [`skills/`](skills/) | Drop-in `SKILL.md` bodies |
| [`06-ui-spec.md`](06-ui-spec.md) | Deferred. The on-page surface: where the potato sits, when it speaks, how you shut it up |
| [`07-build-plan.md`](07-build-plan.md) | **Start here to build.** Blocking decisions, seven phases, the droplet's components, and what to verify first |
| [`08-evals.md`](08-evals.md) | Scored prompts, including the ones it should refuse or hedge on |
| [`09-bluesky-channel.md`](09-bluesky-channel.md) | The Bluesky account: Jetstream detection, the gate layer, thread-to-session mapping, and the posting path |
| [`10-memory.md`](10-memory.md) | What it remembers about whom, how the scope is keyed, and how forgetting works |

## Assumptions worth checking before building

1. **Aturi is yours.** aturi.to is listed as an atpotato project, so this spec
   assumes you can talk to whoever runs it about caching, rate limits, and
   adding tools. If that's wrong, treat the MCP as a third-party dependency and
   add the usual defensive caching.
2. **Aturi's MCP is beta and read-only.** 38 tools, no API key, no published
   rate limits. The agent itself has no write tool at any point, including on
   Bluesky: it drafts, and the droplet in `09` decides whether the draft becomes
   a record.

   That split is the load-bearing safety decision in this whole package. The
   inbound Bluesky surface is a public text field, so the gates that matter live
   in code rather than in the prompt.
3. **eve is beta.** Everything here was written against eve.dev's published docs
   as of September 2026. Once you have a project, `node_modules/eve/docs/`
   matches your installed version and wins over anything written here.
4. **Model choice is open.** `07` has a recommendation, not a decision.

# 04. The Aturi connection

## What Aturi's MCP gives you

- Endpoint: `https://aturi.to/api/mcp`
- Transport: Streamable HTTP
- Auth: none. No key, no account
- Surface: 38 tools, all read-only
- Status: beta, no published rate limits

In eve this is a **connection**, not a tool. Connections live under
`agent/connections/`, the filename becomes the connection name, and the model
never sees the URL. It discovers tools through eve's built-in `connection_search`
and calls them as `<connection>__<tool>`, so with the file below every call is
`atmosphere__resolve_identity` and so on.

## The connection file

```ts title="agent/connections/atmosphere.ts"
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://aturi.to/api/mcp",
  description:
    "The Atmosphere: AT Protocol identity, repositories, records, backlinks, " +
    "the Bluesky app layer, feeds, lists, labelers, lexicon schemas and " +
    "activity, atproto documentation, and a Jetstream sample. Use for any " +
    "question about a handle, DID, at:// URI, PDS, record, feed, labeler, " +
    "lexicon, or how the protocol works. Read-only.",
});
```

Three things about that snippet:

1. **No `auth` block.** eve's docs say to omit auth only for intentionally public
   or loopback servers. Aturi is intentionally public, so this is the sanctioned
   case rather than a shortcut.
2. **The `description` is written for the model, not for you.** It is the main
   signal `connection_search` uses to decide whether to look here at all. If the
   agent starts answering protocol questions from memory instead of reaching for
   tools, this string is the first thing to lengthen.
3. **No `tools.allow` filter in v1.** eve recommends `allow` for the smallest
   safe surface, which matters when a server exposes writes. Every Aturi tool is
   read-only, so the safety argument does not apply, and the discovery argument
   runs the other way: you want the model to find the odd tool. Revisit if tool
   discovery gets noisy.
4. **No `approval` gate.** Approvals exist for calls that create, modify, delete,
   transmit, purchase, or message. Nothing here does any of that. Adding
   `once()` would train visitors to click through prompts, which is worse than
   useless.

Add `protocolVersionDiscovery: false` only if the connection fails to handshake;
it forces the older `initialize` path.

## The 38 tools

Grouped as Aturi groups them. Worth pasting into a skill so the model has the map
without calling `connection_search` first.

**Resolve and open (2)** `resolve_link`, `list_waypoints`

**Identity (2)** `resolve_identity`, `get_identity_history`

**Repositories (4)** `describe_repo`, `list_records`, `get_record`, `describe_pds`

**Network graph (1)** `get_backlinks`

**Bluesky layer (13)** `get_profile`, `get_author_feed`, `get_thread`,
`get_posts`, `search_posts`, `search_actors`, `get_followers`, `get_follows`,
`get_suggested_follows`, `get_post_engagement`, `get_trends`,
`get_starter_packs`, `get_labeler_services`

**Feeds and lists (6)** `list_feeds`, `get_feed_info`, `get_feed`, `get_list`,
`get_list_feed`, `list_lists`

**Lexicon ecosystem (5)** `list_trending_lexicons`, `get_lexicon_activity`,
`search_lexicons`, `get_lexicon_schema`, `sample_recent_records`

**Protocol documentation (4)** `search_atproto_docs`, `read_atproto_doc`,
`search_api_methods`, `get_api_method`

**Jetstream (1)** `sample_jetstream`

Verify this list against the live server before shipping. It is a beta surface
and the count will move.

## Two things the live server does that change the prompt

Checked against `https://aturi.to/api/mcp` on 2026-09-17:

1. **Tool results already carry links.** `get_record` returns
   `links.aturi` and `links.explore`; `resolve_identity` returns
   `links.profile` and `links.explore`. The agent should quote those rather than
   assembling an aturi.to URL from parts. A constructed link is a link that can
   be wrong. Worth a line in the system prompt if evals show it building URLs by
   hand.
2. **Records are served from an edge cache** (`source: "slingshot"`) with a
   direct-PDS fallback. That takes some pressure off the caching question in
   `07-build-plan.md`, though it says nothing about rate limits, which are still
   undocumented.

Also worth knowing: `atpota.to` resolves to `did:plc:qntsxa2i4sb24noi45fx4np2` on
a self-hosted PDS at `pds.atpota.to`, which makes it a good demo subject. The
agent explaining the Atmosphere can show its own account living on its own
server.

## Routing policy

The model picks its own tools. This table is what goes in the routing skill so it
picks well, and it is also what you assert in evals.

| The visitor says | Start with | Then |
| --- | --- | --- |
| Any handle, DID, or `at://` URI | `resolve_identity` or `resolve_link` | Whatever the question actually needs |
| "what is this link" | `resolve_link` | `list_waypoints` for which clients open it |
| "did they change servers / what happened to this account" | `get_identity_history` | `describe_pds` |
| "what's in my repo" / "what is <app> writing to my account" | `describe_repo` | `list_records` on the surprising collection |
| "who linked to this, from any app" | `get_backlinks` | `resolve_link` on interesting results |
| "what did they post / what did best" | `get_author_feed` | `get_post_engagement` on the top candidate |
| "find posts about X" | `search_posts` | `get_thread` for context |
| "who should I follow" | `search_actors` or `get_suggested_follows` | `get_starter_packs` |
| "what feeds exist for X" | `list_feeds` | `get_feed_info`, then `get_feed` for a sample |
| "what labelers are out there" | `get_labeler_services` | Report, do not editorialize |
| "what is this record type / what apps use it" | `search_lexicons` | `get_lexicon_schema`, `get_lexicon_activity` |
| "what's new in the ecosystem" | `list_trending_lexicons` | `sample_recent_records` |
| "how does X work in atproto" | `search_atproto_docs` | `read_atproto_doc` |
| "what parameters does <method> take" | `search_api_methods` | `get_api_method` |
| "what's happening right now" | `sample_jetstream` | Say it is a sample, not a census |

Two standing rules on top of the table:

- **Resolve first, always.** Any answer about an identity is wrong if it was
  built on an unresolved handle.
- **Stop when the question is answered.** The failure mode with 38 tools is
  enumerating the repo to answer a question about one record.

## Result size

eve cannot transform an MCP result before the model sees it. Broad calls
(`get_followers` on a large account, `list_records` on a busy collection,
`sample_jetstream`) will push a lot of tokens into context.

Mitigations, in order of preference:

1. Ask the model to bound the call (page sizes, limits) through the routing skill.
2. Since Aturi is an atpotato project, add narrower server-side tools there.
3. Last resort, per eve's docs: replace one operation with an authored tool that
   holds the payload outside model context and projects a few fields through
   `toModelOutput`, then `tools.block` the original so the model does not see two
   versions of the same tool.

## Page context (the Clippy hook, done properly)

The thing that makes this feel like Clippy instead of a chat box is that it
already knows what the visitor is looking at. In eve that is dynamic user-role
instructions resolved at `session.started`:

```ts title="agent/instructions/page-context.ts"
import { defineDynamic, defineInstructions } from "eve/instructions";

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const page = ctx.session.metadata?.page;
      if (!page) return null;
      return defineInstructions({
        role: "user",
        content: `The visitor opened you from ${page.path}.` +
          (page.subject ? ` They were looking at ${page.subject}.` : ""),
      });
    },
  },
});
```

User-role instructions become durable session history and are appended once, so
this arrives as context rather than as a standing rule the model has to weigh on
every turn. The frontend passes `page` as session metadata when it creates the
session.

Two cautions:

- Page context is data, not instruction. If a URL or a record's text contains
  something shaped like a command, the agent must not follow it. Worth a line in
  the system prompt if you ever inject record contents rather than just a path.
- Returning `null` is the right move on pages with no subject. An empty greeting
  beats a wrong one.

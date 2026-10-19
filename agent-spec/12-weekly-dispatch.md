# Weekly Atmosphere dispatch

> **Plan, first written 2026-10-18, updated 2026-10-19 for the site as built.**
> Unlike files 01 to 11, this is the current plan for a feature, not a
> historical spec. Measurements are dated where they appear.

Every Monday Poe recaps the previous week in the Atmosphere: what builders
talked about, what shipped, and which lexicons appeared or grew. Each issue is
a `site.standard.document` in atpota.to's repo, in the Leaflet publication
"poe's atmosphere dispatch", which lives at poe.leaflet.pub and is shown on
atpota.to/blog.

Today an operator generates an issue with the demo pipeline, reads it, and
publishes it with one command; see "Publishing an issue today". Later the
weekly loop runs on its own: Poe DMs the draft to an operator on Bluesky, the
operator replies with edits, and `approve` publishes.

## Decisions made

| Question | Decision |
| --- | --- |
| Where issues live | atpota.to's repo (`did:plc:qntsxa2i4sb24noi45fx4np2`), in the publication `at://did:plc:qntsxa2i4sb24noi45fx4np2/site.standard.publication/3myar4h4pls2n`, made in Leaflet, url `https://poe.leaflet.pub`. atpota.to/blog shows a copy with canonical links to Leaflet. Poe is credited as contributor. Changed on 2026-10-19 from Poe's repo, when the publication was made |
| Approval | Nothing is published without an operator. Today, running `npm run publish:dispatch` is the approval; later, `approve` over Bluesky DM |
| Schedule | Monday. The draft DM should land around 12:00 EAT (09:00 UTC) |
| Recap window | The previous week, Monday 00:00 UTC to Monday 00:00 UTC (see open questions) |
| Lexicon data | Aturi's `list_new_lexicons`, `list_lexicon_movers` and `list_trending_lexicons`, collected right after the week closes; UFOs for any other window |
| Sources | The builders list, feeds and repos the operator sends |
| Models | Two analysts on Claude Sonnet 5.5, a writer and an editor on Claude Opus 5.5, each set by its own environment variable; see "Models and cost" |

## Publishing an issue today

The rest of this plan describes the automated weekly loop, which is not built
yet. Until it is, an issue goes out by hand, and these steps work now:

1. **Collect** the week on Monday, after 00:00 UTC (12:00 EAT is fine), so
   Aturi's 7-day window lines up with the week:
   `cd bot && npm run dispatch:collect -- --week`
2. **Write** it: `npm run dispatch:write -- .dispatch/runs/week-<monday> --label v1`.
   It takes about five minutes and reads model keys from the same env files as
   `eve dev`. Read
   `drafts/v1/final.md`, then `editor.json` for what the editor changed and
   could not verify.
3. **Revise** if needed: edit `agent/lib/dispatch/voice.md` and re-run the
   writer and editor with `--label v2 --reuse v1`, or edit `final.md` by hand.
   What is in the file is what gets published.
4. **Check** the record:
   `cd website && npm run publish:dispatch -- ../bot/.dispatch/runs/week-<monday>/drafts/v1/final.md --dry-run`
5. **Publish**: the same command without `--dry-run`, with `ATP_APP_PASSWORD`
   set to an app password for atpota.to. It prints the record key, and it
   refuses to publish the same title twice. /blog shows the issue within its
   5-minute cache.
6. **Announce** it from @poe.atpota.to, then link the post into the record:
   `npm run publish:dispatch -- <file> --rkey <key> --bsky-post <post url>`

Issue 1 went out this way on 2026-10-19
(`at://did:plc:qntsxa2i4sb24noi45fx4np2/site.standard.document/3myasnk4bzk22`).
poe.leaflet.pub listed and rendered it within a minute, credited to Poe, and
/blog showed it straight away. Before publishing, the 22 "(post)" links in the
v4 draft were moved onto the words they support, by hand. One thing broke:
Leaflet shows only the first of two facets over the same words, so a linked
NSID whose code facet came first lost its link. The converter now puts the
link first.

Still unknown: whether Leaflet emails a document written straight to the repo
to the publication's subscribers. That is a question for Leaflet.

## Rules carried over from the reply design

1. **Poe never holds a credential.** The droplet publishes. The agent produces
   text and nothing more, as with Bluesky replies.
2. **Approval is a conditional, not a prompt.** The droplet parses `approve`
   in code, accepts it only from an operator DID on its allowlist, and
   publishes exactly the version that was approved, identified by its sha256.
3. **Code collects, models judge.** Collectors fetch, dedupe, join and tag.
   They never summarize. The only records code removes are ones excluded for
   privacy, and those are removed before any model sees them.
4. **Every reference is on file.** Every link, handle, NSID and at-uri in a
   draft must appear in that issue's stored data. Code checks this twice, once
   in the bot and once in the droplet.
5. **The input is untrusted.** Keyword search returns posts from anyone, and
   anyone can name a collection anything. `09-bluesky-channel.md` called a
   weekly lexicon post low risk "since nobody is injecting anything"; that
   stops being true once Poe reads search results.

## Architecture

```
Aturi (Atmosphere data)          bot on Vercel (eve)                         droplet (credential, DMs)
------------------------         -------------------------------------       ---------------------------
weekly lexicon report  ───────►  schedules ─► collectors ─► Vercel Blob
                                                              │
                                 dispatch channel: Poe ◄──────┘
                                   ├─ analyst ×2 (parallel, sandboxed)
                                   ├─ writer
                                   └─ editor ─► final vN ─► POST /dispatch/draft ─►  gates, DM to operator
                                                                                            │
                                 POST /dispatch/review ◄──── operator's notes ◄─────────────┤
                                 GET  /dispatch/preview  ◄── operator reads draft           │
                                                                                     `approve`
                                                                                            ▼
                                                                  site.standard.document in atpota.to's repo
                                                                  ─► poe.leaflet.pub and atpota.to/blog
                                                                  announcement post from Poe
```

Each part keeps its current job. Aturi holds network-wide data, the droplet
holds the credential and talks to Bluesky, and the bot does the thinking.

## One issue, start to finish

| When (UTC) | EAT | What runs |
| --- | --- | --- |
| Daily 00:10 | 03:10 | `dispatch/collect-daily`: read the builders list and feeds, append new posts to the week's files |
| Mon 00:15 | 03:15 | `dispatch/finalize`: Aturi lexicon report (its 7-day window now matches the week), keyword searches, engagement refresh, privacy filter, app sites, repo releases. Freeze the dataset |
| Mon 07:30 | 10:30 | `dispatch/draft`: the writing pipeline starts on the frozen dataset |
| Mon ~09:00 | ~12:00 | The draft DM lands. This is a target; the shadow weeks measure how long the pipeline takes |
| Any time | | Edits go back and forth in the DM. `approve` publishes within minutes |
| Next Monday | | An unapproved draft expires when the next issue's draft arrives |

Vercel runs eve schedules as Cron Jobs evaluated in UTC. If the project is on
the Hobby plan, my understanding is that runs can fire anywhere within the
scheduled hour; check the plan before relying on the times above.

`finalize` and `draft` are separate schedules so a failed collection never
produces a draft from half the data. `draft` checks that the manifest is
frozen and, if it is not, DMs the operator that collection failed.

## Data collection

### Sources

| Data | Source | How | When |
| --- | --- | --- | --- |
| Builder posts | A Bluesky list owned by atpota.to | `getListFeed`, paged back to the window start | Daily |
| Community feeds | 2 to 4 feeds the operator picks | `getFeed` | Daily, because some feed generators only serve recent posts |
| Keyword posts | A fixed list of queries | The droplet's authenticated `/internal/bluesky-search`, `since`/`until` set to the window. Unauthenticated search serves first pages only: on 2026-10-18 every cursor request was refused | Monday |
| Releases | Repos the operator lists | GitHub `releases.atom` per repo (no auth needed) | Monday |
| Lexicons | Aturi's weekly report | One HTTP call | Monday |
| App sites | For each notable project, its domain and its busiest NSID's longer authority (`app.sonasky.apollo.page` is `apollo.sonasky.app`) | Fetch the page and its title, resolve the domain as a handle, read the `_lexicon` TXT record over DNS-over-HTTPS. Only verified or likely sites may be linked; see below | Monday, after the lexicon report |
| Talk about notable lexicons | For each mover and busy new project (up to 15), the account at its domain (`so.sprk` is `sprk.so`) and posts naming the domain | `getAuthorFeed` on the domain, plus a search for it. Search by author or domain needs auth, so production can do more through the droplet | Monday, after the lexicon report |
| Engagement | Every collected post | `getPosts` in batches of 25, so counts reflect the week's end | Monday |
| Authors | Every author in the dataset | `getProfiles`, for labels and current handles | Monday |

The source list lives in a checked-in file, `agent/lib/dispatch/sources.ts`.
Adding a person to the builders list needs no deploy, because the list is a
Bluesky record.

Keyword queries should pair "atmosphere" with atproto terms or limit it to list
members. On its own it matches weather and moods.

### Lexicon data from Aturi

Built on 2026-10-19. The collector calls three Aturi tools over MCP:
`list_new_lexicons` (7 days, at least two accounts, up to 200),
`list_lexicon_movers` in both directions (at least 10 accounts), and
`list_trending_lexicons`. For the 40 busiest new lexicons it adds schema
details from `get_lexicon_schema` and sample records from UFOs. Code groups
new NSIDs by project and counts them.

Aturi's windows are the 7 days before the call, so the collector uses Aturi
only when the recapped week ended within the last 12 hours. Any other window,
or an Aturi failure, falls back to UFOs, which can answer any window from its
full history. A live run on 2026-10-19 found 67 new lexicons with two or more
accounts, 42 with three or more, and Spark's `so.sprk.feed.post` up from about
39 to about 4,950 accounts.

Still open: published schemas come from UFOs' recent-records sample, which is
not a complete list. An Aturi tool for schemas published in a window would
close that.

Measured against microcosm's UFOs API on 2026-10-18, before Aturi had the
tools:

- 2,850 NSIDs were active in the previous 7 days. 34,761 had been seen before
  that.
- 1,024 of the active ones were new. 69 had 2 or more accounts, 44 had 3 or
  more, and 19 had 5 or more, from about 107 distinct authorities.
- The new ones included `app.bsky.actor.link` (profile links) with 10
  accounts. Its schema resolves through bsky.app's `_lexicon` DNS record.
- Account counts are HyperLogLog estimates. "First seen" is only as complete
  as the index's history.

### Storage: public on the PDS, private in Blob

Decided 2026-10-18: as much as can be public lives on `pds.atpota.to`. The
week list and snapshot go in Poe's repo; the issue goes in atpota.to's repo,
with its publication. Anything on a PDS is public, so drafts and review notes
stay private until they are approved.

**On the PDS (public)**

| Record | What it holds | Written by |
| --- | --- | --- |
| `net.anisota.feed.list` in Poe's repo, one per week | "atmosphere week of oct 12": the posts Poe read | droplet, on the collector's request |
| `net.anisota.feed.listItem` | one collected post, by at-uri | droplet, daily |
| `to.atpota.dispatch.snapshot`, rkey = issue date | the lexicon report, releases, sources and counts | droplet, Monday |
| `site.standard.document`, in atpota.to's repo | the published issue | the operator today (`publish:dispatch`); the droplet after `approve` later |

The week list uses Anisota's list lexicon, so anyone can read what Poe read in
Anisota, and the pipeline reads the same list back on Monday. List items are
references, not copies. A post its author deletes drops out by itself, because
the pipeline re-reads each post (`getPosts`) when it freezes the week, and a
deleted post no longer comes back.

Not everything is a post. Lexicon numbers and releases go in the weekly
snapshot record. It holds bounded views (new lexicons above a small account
floor, movers, the top 40, sampled schemas) so it stays well under any record
size limit; the full lexicon history can be re-queried from Aturi.

Two cautions. The list is public, so only posts that pass the privacy filter go
in. And keyword searches match off-topic posts: on the demo week, 115 of the
136 posts a "lexicon" search found had nothing atproto-related in their text or
links, among them a political post and a sexual one. That query is gone now,
but any keyword drifts. A relevance check before a post joins the public list
keeps "posts poe read for the dispatch" honest; a cheap model call per post is
enough. Whether rejected posts are kept privately is an open question.

**In Vercel Blob (private)**

```
dispatch/issues/2026-10-12/
  manifest.json          window, sources, counts, sha256 of each file, frozen flag
  working/               the hydrated week, as the analysts read it
  lookups/               Aturi results the subagents fetched during the run
  findings/  drafts/  reviews/
  review-log.jsonl       operator notes and version events
```

Supabase is not needed. The private side is a few files per week, which Blob
already handles, and history across weeks comes from Aturi and the PDS. It
would earn a place if you later want SQL over months of issues.

Collector runs write in small steps and skip work already done, so a run cut
off by a function time limit can be re-run safely.

### App sites

So readers can see whether an app exists, each notable project gets a site
check, and the issue links the project's name to its site when the check
passes. A domain that loads is not enough: it can be parked, for sale, or
unrelated to whoever minted records under its name. So:

- **verified**: the domain is an atproto handle whose DID is the lexicon's
  `_lexicon` DNS authority, or writes the lexicon's records.
- **likely**: the page loads, is not parked, and the domain is a handle or the
  page talks about atproto or Bluesky.
- **unverified, parked, unreachable**: recorded, never linked. Lint blocks
  them, and the agent leaves them out of the `allowed` list it sends the
  droplet, so the droplet's gate rejects them too.

On the demo week, 25 of 35 checked sites were linkable. The longer authority
found the actual app where the bare domain was a company page or did not
resolve: `poll.tokimeki.tech`, `apollo.sonasky.app`, `sportimon.river.berlin`.
A page title is the app describing itself ("Spark - Take back your
timeline"), which beats guessing from sample records; it is also text the
app's owner wrote, so it is treated as data like a post. Linkable does not
mean featured: whether to mention a project at all stays the writer's and the
operator's call.

### Privacy filter

Applied when records are written, so no model sees what it removes:

- **Opt-outs**: a list the droplet keeps and the collector fetches. Authors on
  it are left out.
- **`!no-unauthenticated` is kept** (decided 2026-10-19). These authors have
  asked apps not to show their posts to logged-out viewers, and atpota.to is
  logged out, but the operator chose to include them. Each such post is marked
  `noUnauthenticated` in the data, so linking without quoting them, for
  example, would be a change to the writer rather than to collection. On the
  demo week that was 209 of 1,471 posts.
- **Moderation labels**: posts carrying adult or graphic-media labels are left
  out. The exact label list is an open question.

## Writing pipeline

### Full data, in files

The operator asked that the models see everything collected, not a summary.
They will, with one constraint. The lexicon side alone is 2,850 rows a week,
and the post side depends on the size of the builders list; it could be
thousands of posts. That will not fit in one context window, and accuracy tends
to drop as a context fills.

So the full dataset goes into each analyst's sandbox as files. The analyst
reads and queries all of it with bash, Python or jq, reads in full whatever
matters, and computes every number it reports rather than estimating it. eve
gives every agent, and each declared subagent, its own sandbox with `bash`,
`read_file` and `write_file` tools.

The analyst and editor sandboxes run with `networkPolicy: "deny-all"`. The
files get there through an authored `open_week` tool that runs in the app
runtime, copies them from Blob, and needs no sandbox network. Nothing inside
the data can then make the sandbox reach the internet. Whether jq is in eve's
base sandbox image needs checking; if it is missing, install it in the
sandbox's bootstrap step.

### Roles

| Role | eve shape | Model variable | Reads | Produces |
| --- | --- | --- | --- | --- |
| Poe | Root agent on a new `dispatch` channel | `AGENT_MODEL` | Findings, drafts, operator notes | Runs the steps, talks to the operator |
| Analyst | Declared subagent `dispatch-analyst`, run twice in parallel: posts (conversations and launches) and lexicons | `DISPATCH_ANALYST_MODEL` | Its slice of the dataset, in full, plus Aturi for follow-ups | Findings JSON: each claim with the record ids behind it and the command that produced each number |
| Writer | `dispatch-writer` | `DISPATCH_WRITER_MODEL` | Findings, the voice guide, the last three issues, dispatch style notes, the dataset | `drafts/vN.md` |
| Editor | `dispatch-editor` | `DISPATCH_EDITOR_MODEL` | The draft, findings, the dataset, the lint report | `drafts/vN.final.md`, a change log, and open questions for the operator |

Each role variable falls back to `AGENT_MODEL`, and each has a matching
`_REASONING` variable that falls back to `AGENT_REASONING`. The direct
Anthropic path in `lib/model.ts` applies to all of them: `direct()` becomes a
function that takes a model id, used by the root and the three subagents.

The editor works in a fixed order. It checks every claim against the files
first, then copyedits for voice and length. Anything it cannot verify goes in
its open questions, and those appear in the operator's DM.

The editor reads the draft cold, without the writer's reasoning in its
context, which is the point of having one. If it flattens Poe's voice, split
it into a fact-checker and a copyeditor.

### Models and cost

Defaults since 2026-10-19: **Claude Sonnet 5.5 for the analysts, Claude Opus
5.5 for the writer and editor.** The analysts read most of the tokens and
their job is finding and sorting; the writer and editor read far less and
carry the voice and the fact-checking.

The evidence, from the demo week of 2026-10-12 (1,471 posts):

- Both analysts were run on Sonnet and on Opus over identical input. The posts
  analysts found the same dozen main stories; each also found three to five
  smaller ones the other missed. The lexicon findings were nearly the same
  list. Every evidence id resolved for both, and the Sonnet claims I checked
  against the posts were accurate, including counts it copied from the
  code-computed tables.
- Sonnet analysts cost about $1.01 against $1.94 for Opus, at Anthropic's list
  prices ($2 and $10 per million input and output tokens for Sonnet 5.5, $4 and
  $20 for Opus 5.5, as of October 2026).

What a run costs at list prices, measured:

| Configuration | Run | Estimate |
| --- | --- | --- |
| Three Opus analysts, Opus writer and editor | v1, 1,311 posts | $3.78 |
| Two Opus analysts, Opus writer and editor | analysts measured, writer and editor from v4 | about $3.10 |
| Two Sonnet analysts, Opus writer and editor | v4, 1,471 posts | $2.19 |
| A revision in the DM loop (writer and editor, Opus) | from v4 | about $1.20 |

These are estimates from token counts. The AI Gateway key used for the demos
reported $20.08 spent when these runs added up to $11.20 at list prices;
whether that is earlier spend on the key or a pricing difference (for example
on prompts over 200,000 tokens) is unconfirmed. The gateway's spend page has
the real per-request figures and should be checked before setting a budget.

Not yet measured: **Sonnet as the writer.** It would save about $0.30 a run and
about $0.30 a revision, and voice is the risk. The test is one command on a
collected week:
`DISPATCH_WRITER_MODEL=anthropic/claude-sonnet-5.5 npm run dispatch:write -- <run> --label sonnet-writer --reuse v4`.
Keep the editor on Opus; it caught the most consequential errors in every run.

Other levers, roughly in order of what they save:

- **Prompt caching** between the writer and the editor, and across revision
  rounds: they send the same brief of about 55,000 tokens. On Opus a cached
  read costs $0.20 per million instead of $4. Needs the brief placed as a
  shared prefix and the gateway passing Anthropic's cache control through.
- **Batch pricing.** The gateway lists `-batch` variants of these models. A
  weekly job with hours of slack before the Monday DM may be able to use them;
  how they behave through the AI SDK is unchecked.
- **A relevance filter** with a small model before the public week list, which
  the storage plan wants anyway, also trims the posts the analyst reads.
- **Lower reasoning effort** for the analysts. Their output is a small share
  of the cost, so this saves little.

### What code enforces

- **Only edited text leaves the bot.** `finalize_draft` exists only in the
  editor's tool set and writes the final text with its sha256. Poe's
  `submit_draft` tool sends a file the editor finalized, by version. Poe cannot
  send text it wrote itself or change text after the editor.
- **Lookups count as evidence only if recorded.** Each subagent has a hook on
  `action.result` that saves Aturi results into `lookups/`. eve fires subagent
  hooks only inside the subagent's own scope, so each subagent needs its own.
- **Lint before the editor and again before sending**: every link, handle,
  NSID and at-uri must appear in `raw/` or `lookups/`; no @-mentions; no raw
  HTML; length within bounds; em dashes and phrases from a banned list are
  flagged for the editor to fix.
- **Tools are gated by channel.** `open_week` and `submit_draft` refuse to run
  outside the dispatch channel, the same way existing tools check the
  authenticator.

### Memory

The dispatch channel gets none of Poe's memory about people or DMs. Every
person, life and operator slot already returns no scope unless the channel is
`bluesky` or `operator-dm` with the droplet's authenticator, and a scheduled
turn runs as the app principal. `poe-self` is recalled everywhere, which is
fine because it holds only facts that are safe in public.

One new slot, `dispatch-style`, holds standing feedback from reviews ("never
call a lexicon trending on two accounts"). It is writable only in operator
review turns on the dispatch channel. Subagents never see the parent's
history, so Poe copies these notes into its requests to the writer and editor.

### Voice and structure

Poe's reply voice is tuned for 300 graphemes. The dispatch needs a long-form
version of it, in a shared file, `agent/lib/dispatch/voice.md`, imported by the
writer's and editor's instructions. It sets length, structure, how Poe's
opinions show up in longer prose, and the writing tells to avoid.

The structure, around 600 to 1,000 words, people first and numbers after
(revised 2026-10-19):

1. Two to four sentences on the week's biggest thing.
2. What builders talked about: three to five threads, linked.
3. Shipped: one line per launch or release.
4. New lexicons: three to eight one-line bullets.
5. Growing and shrinking: three to six one-line bullets.

The two lexicon sections stay under 250 words together and are built for
scanning: lexicon or project first, then the numbers, then one clause of
meaning, linking the app's own post when it explains a number.

## Review over Bluesky DM

1. The bot stores the final version in Blob and sends the droplet
   `POST /dispatch/draft` with the issue id, version, sha256, title, a summary
   under 900 graphemes, what changed since the last version, the editor's open
   questions, a preview URL, and the allowed identifiers.
2. The droplet re-runs the identifier check, stores the version, and DMs the
   operator. A DM message is capped at 1,000 graphemes
   (`chat.bsky.convo.defs#messageInput`), so the DM carries the summary, the
   preview link and the commands, not the whole draft.
3. The preview page is a GET route on the bot,
   `/dispatch/preview/:issue/:version?t=<hmac>`. It renders with the same
   markdown renderer as the website, shows a diff against the previous version,
   sends `noindex` and `no-store`, and its token expires after 7 days. The
   token is signed with a new `DISPATCH_PREVIEW_SECRET`.
4. The operator replies with notes. The droplet forwards them to
   `POST /dispatch/review`, which delivers them into the issue's session as an
   operator turn. Poe answers questions directly, or sends the notes to the
   writer and then the editor, which produces the next version and goes back
   to step 1. Exact wording from the operator is used verbatim; the editor may
   flag a factual problem in it but does not rewrite it.
5. `approve` publishes the latest version the droplet has DM'd. If a newer
   version is still being written, the droplet asks for `approve v3` by
   number. `skip` drops the week. Both are exact-match commands parsed by the
   droplet.

While a review is open, every operator DM goes to the review session, and
`approve` or `skip` closes it. The DM lexicon has a `replyTo` field, so the
droplet could instead route only replies to the draft message. I have not
checked whether the Bluesky app lets you reply to a DM; see open questions.

An optional setting can also send the full text in the DM, split into
1,000-grapheme messages, for reading in the app.

## Publishing

The publication exists: "poe's atmosphere dispatch", made in Leaflet in
atpota.to's repo
(`at://did:plc:qntsxa2i4sb24noi45fx4np2/site.standard.publication/3myar4h4pls2n`,
url `https://poe.leaflet.pub`).

Each issue is a `site.standard.document` in the same repo, shaped like the
documents Leaflet writes itself, so Leaflet and the blog both read it:

- the record key is a TID from the publish time, and `path` is `/<key>`, so the
  issue is at `poe.leaflet.pub/<key>` and `atpota.to/blog/<key>`;
- `site` is the publication's AT-URI, plus `title`, `description`,
  `publishedAt`, and `tags` `atmosphere` and `dispatch`;
- `contributors` is `[{ did: <Poe's DID> }]`, which credits Poe;
- `content` is Leaflet blocks (`pub.leaflet.content`), converted from the
  issue's markdown by `website/build/leaflet-markdown.ts`, the converter the
  guides use, and `textContent` is the plain text;
- `bskyPostRef` points at the announcement post once it exists.

`website/scripts/publish-dispatch.ts` (`npm run publish:dispatch`) builds and
writes exactly this record. It has a dry run, refuses to publish a title
twice, updates with `--rkey`, and links the announcement with `--bsky-post`.
When the droplet takes over publishing, it writes the same record
(`mentions/DISPATCH.md`).

No deploy is needed. /blog reads the repo on each request and caches for 5
minutes (`website/server/blog/handler.ts`).

The announcement is a post from @poe.atpota.to with a link card to the issue.
It has no @-mentions, so featured people are not pinged.

## Website

Built on main (#2 and #4): the Vite site; the chat panel, served by the bot's
`agent/channels/website.ts`; and /blog, which renders the dispatch publication
from atpota.to's repo with canonical links to poe.leaflet.pub
(`website/server/blog`). Leaflet serves the publication's verification;
atpota.to's `/.well-known` file only answers for a publication whose url is
atpota.to/blog. [`13-poe-blog-and-chat.md`](13-poe-blog-and-chat.md) was the
brief; parts were built differently, as its status note records.

## Risks and controls

| Risk | Control | Where |
| --- | --- | --- |
| Instructions planted in posts | Data is read as data; identifier check; editor check; operator approval | Bot, droplet, operator |
| An invented link, handle or NSID | Identifier check in code, twice | Bot lint, droplet |
| A wrong number | Numbers computed from files; the editor recomputes them; operator review | Subagents, operator |
| Featuring someone who opted out | Removed at collection, before any model | Collector |
| Private memory reaching a public issue | No person or DM memory scope on the dispatch channel | Memory scope functions |
| Publishing without approval | `approve` parsed in code, bound to sha256; Poe has no credential | Droplet |
| Pinging people unasked | No @-mentions in the announcement | Droplet |
| Data leaving through the sandbox | `deny-all` network in analyst and editor sandboxes | Sandbox config |

## Tests and evals

- **Unit tests**, in `tests/` like the existing ones: window math, dedupe,
  privacy filter, identifier extraction, lint, and the hash check in
  `submit_draft`.
- **Evals**, on a fixture made by freezing one real week once the collectors
  work:
  - grounding: every named NSID, handle, link and number traces to a file;
  - injection: a planted post asks Poe to include a link and to call a project
    a scam, and neither appears in the draft;
  - revision: operator notes are applied, and earlier verified claims survive;
  - voice: a judge checks against the voice guide and the banned list;
  - memory: nothing from person or DM memory appears.

## Demo pipeline

`bot/scripts/dispatch-demo.ts` collects the past 7 days for real and writes an
issue from them with the three roles, so the format and voice can be tuned
before the production pipeline exists. Nothing is posted or published.

```
cd bot
npm run dispatch:collect                       # into .dispatch/runs/<date>/
npm run dispatch:write -- .dispatch/runs/<date> --label v1
npm run dispatch:write -- .dispatch/runs/<date> --label v2 --reuse v1
npm run dispatch:write -- .dispatch/runs/<date> --label v3 --reuse v2 --rerun lexicons
```

`write` re-runs on the same collected week, so a change to
`agent/lib/dispatch/voice.md` or `roles.ts` can be compared against the same
data. `--reuse` takes the analysts' findings from an earlier run and re-runs
only the writer and editor, which is the cheap loop for tuning voice and
format: the analysts are about two thirds of a run's tokens. `--rerun` names
analyst slices to run again anyway. Each run writes `findings.json`, `draft.md`, `final.md`, the editor's
changes and open questions, lint results and token usage to
`.dispatch/runs/<date>/drafts/<label>/`. `.dispatch/` is gitignored because
it holds other people's posts.

What it shares with production: the collectors (`agent/lib/dispatch/collect.ts`),
the role prompts and output shapes (`roles.ts`), the voice guide, the lint
(`lint.ts`), and model routing through `languageModel()` in `lib/model.ts`,
with the same `DISPATCH_*_MODEL` variables.

What differs: it reads local files instead of the PDS week list, it puts each
analyst's slice in the prompt rather than in sandbox files, and it has no
review loop.

The first run, on 2026-10-18 with all three roles on Claude Opus 5.5 at high
reasoning, read 1,311 posts. Each post-reading analyst used about 238,000
input tokens and the lexicon analyst about 86,000. All three analysts ran in
parallel and finished within two minutes; the whole run took about five
minutes and used 740,000 input and 41,000 output tokens. A `--reuse` run used
about 290,000 and 26,000.

What the first three runs showed, and what changed because of it:

- **Models miscount.** The lexicon analyst reported 12 new `app.sonasky.apollo`
  NSIDs, "counted from new lexicons table"; the table had 10. Counts per
  project are now computed by code and handed to the analyst, writer and
  editor. This is the same reason production gives analysts files and a shell.
- **Code miscounts too.** The first version of that grouping skipped NSIDs
  flagged as odd-looking and turned 828 into 812. The flag was also wrong: it
  rejected domain segments starting with a digit, which the NSID syntax
  allows. Both are fixed and tested.
- **The editor checks claims well.** In the first run it caught a paraphrase
  that said more than the post, an inference about deleted records that the
  counts could not support, and a deadline that applied only to round 1, and
  it hedged four inferences. It cannot check what it is not given, so it
  missed the miscount.
- **Rules need a check behind them.** The writer kept "about 4,685" although
  the guide asked for rounding; lint now flags unrounded estimates. The writer
  assumed one person's pronouns; the guide now says they/them unless stated.
- **A bad check does damage.** Lint flagged "delve" inside the NSID
  `town.delve.feed.post`, and the editor cut a real lexicon to clear it. Phrase
  checks now read prose only.

The fourth run (v4, 2026-10-19, on the full Monday-to-Monday week) added three
things:

- **Cross-referencing works where apps have an account.** For 11 of 15 notable
  projects the collector found posts by the app or naming its domain, and the
  issue used them: vibescrobble's builder saying they are "the only one using
  it right now", the Anisota bump next to a login redesign, userinput.app
  upvotes next to an app pointing users at its feedback board there. Where
  nothing explained a number (Spark), it said so.
- **The new order reads better** and the lexicon sections came in at 239
  words. Conversations, then shipped, then the data.
- **It linked "(post)" after nearly every claim**, 22 times, where earlier runs
  linked the words. Lint now flags vague link text.

## Build phases

**Done.** The demo pipeline and its collectors (`bot/scripts/dispatch-demo.ts`,
`bot/agent/lib/dispatch/`), lexicon data from Aturi, app-site checks, the site,
the chat panel, /blog, and `publish:dispatch`. Issue 1, for the week of
October 12, was published by hand on 2026-10-19.

**Now: publish by hand** every Monday, as in "Publishing an issue today". Still
wanted from the operator: the builders list, feeds, repos and keywords;
`agent/lib/dispatch/sources.ts` has stand-ins.

**Next: the weekly loop.** In the bot: the `collect-daily`, `finalize` and
`draft` schedules, private storage in Blob, the `dispatch` channel with the
review and preview routes, and the hand-off to the droplet. In the droplet:
`mentions/DISPATCH.md`. Done when a draft goes through two rounds of edits
over DM against a test account, followed by two shadow Mondays with
publishing switched off.

**Later.** A section on what people wrote, from atproto-tagged
`site.standard.document` records (about 193,000 creates in the week to
2026-10-17, per Aturi, with full article text, so it needs filtering). Tangled
repos. Poe answering "what's new this week?" in replies from the dataset.
Opt-out requests by DM.

## Work by codebase

**bot/** (this repo)
- Built: `agent/lib/dispatch/` (sources, collectors over Aturi and UFOs,
  privacy filter, app sites, lint, roles, voice guide),
  `scripts/dispatch-demo.ts`, `tests/dispatch-*.test.mjs`.
- To build: `agent/schedules/dispatch/{collect-daily,finalize,draft}.ts`;
  `agent/channels/dispatch.ts` with the review and preview routes; the
  analyst, writer and editor as subagents or tools; `submit_draft`;
  `agent/memory/dispatch-style.ts`; `evals/dispatch/`; and the markdown to
  Leaflet conversion, matching `website/build/leaflet-markdown.ts`, so the
  droplet receives a record it can write as is.

**website/** (this repo)
- Built: /blog, the chat panel, `scripts/publish-dispatch.ts`.

**droplet** (on DigitalOcean, not in this repo). The standalone brief is
[`../mentions/DISPATCH.md`](../mentions/DISPATCH.md). In short:
- Week list and snapshot writes to Poe's repo, on the collector's request
- `POST /dispatch/draft`, the identifier check, DM delivery
- Operator DM routing while a review is open; `approve` and `skip`
- Accept the dispatch collector as a caller of `/internal/bluesky-search`
- Publishing into atpota.to's repo, which needs a credential for that account,
  then the announcement from Poe and the `bskyPostRef` update
- The opt-out list and an endpoint for the collector to read it
- A publishing kill switch

**Aturi** (operator)
- Built: `list_new_lexicons`, `list_lexicon_movers`.
- Wanted: schemas published in a window.

## Open questions

1. Does Leaflet email subscribers about a document written straight to the
   repo? It lists and renders one (issue 1).
2. The droplet will write into atpota.to's repo. An app password for
   atpota.to, or an OAuth session limited to `site.standard.document`, if
   pds.atpota.to supports scoped permissions?
3. Should the announcement link poe.leaflet.pub (the canonical page, with
   Leaflet's subscribe button) or atpota.to/blog?
4. Week boundary: Monday 00:00 UTC as proposed, or Monday 00:00 EAT (Sunday
   21:00 UTC).
5. DM routing: everything during an open review, as proposed, or only replies
   to the draft message, if the app supports replying to a DM.
6. Should featured people be notified? Proposed no.
7. How does someone opt out? Proposed: by DM to Poe or an operator command,
   recorded by the droplet.
8. Which moderation labels exclude a post.
9. A per-run cost budget, set after real usage.
10. Posts that fail the relevance check: drop them, or keep them privately in
    Blob so the analysts still see everything collected?
11. Does Anisota's AppView offer a read endpoint for a list's items? Without
    one, the pipeline pages Poe's `net.anisota.feed.listItem` collection
    newest first and stops at the week's start.

## Sources

- [standard.site](https://standard.site): publication and document verification.
- [UFOs API](https://ufos-api.microcosm.blue/): the 2026-10-18 measurements.
- [microcosm-rs readme](https://tangled.org/nekomimi.pet/microcosm-rs/blob/main/readme.md): what UFOs indexes.
- [CodeTV: multiple standard.site publications on one website](https://codetv.dev/blog/multiple-standard-site-publications-on-one-website): the subpath verification file.
- `chat.bsky.convo.defs`, read through Aturi: the 1,000-grapheme DM limit and `replyTo`.
- eve 0.58 docs in `bot/node_modules/eve/docs`: schedules, subagents, sandbox, hooks.

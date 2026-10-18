# Weekly Atmosphere dispatch

> **Plan, 2026-10-18. Nothing here is built yet.** Unlike files 01 to 11, this
> is the current plan for a feature, not a historical spec. Measurements below
> were taken on 2026-10-18 and are marked as such.

Every Monday Poe recaps the previous week in the Atmosphere: which lexicons
appeared or grew, what builders talked about, and what shipped. Poe DMs the
draft to an operator on Bluesky. The operator replies with edits until it reads
right, then sends `approve`. The droplet publishes it as a
`site.standard.document` in Poe's repo, and atpota.to/dispatch renders it.

## Decisions made

| Question | Decision |
| --- | --- |
| Whose repo publishes | Poe's: `poe.atpota.to`, `did:plc:6qw63oash3jfnpykvpbwnq5z` |
| Approval | Over Bluesky DM. Nothing is published without an operator's `approve` |
| Schedule | Monday. The draft DM should land around 12:00 EAT (09:00 UTC) |
| Recap window | The previous week, Monday 00:00 UTC to Monday 00:00 UTC (see open questions) |
| Lexicon data | Aturi, which gains new endpoints and tools (it is ours) |
| Sources | The builders list, feeds and repos the operator sends |
| Models | Poe orchestrates three specialist roles (analyst, writer, editor); each role's model comes from its own environment variable |

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
                                   ├─ analyst ×3 (parallel, sandboxed)
                                   ├─ writer
                                   └─ editor ─► final vN ─► POST /dispatch/draft ─►  gates, DM to operator
                                                                                            │
                                 POST /dispatch/review ◄──── operator's notes ◄─────────────┤
                                 GET  /dispatch/preview  ◄── operator reads draft           │
                                                                                     `approve`
                                                                                            ▼
                                                                  site.standard.document in Poe's repo
                                                                  Vercel deploy hook ─► atpota.to/dispatch
                                                                  announcement post from Poe
```

Each part keeps its current job. Aturi holds network-wide data, the droplet
holds the credential and talks to Bluesky, and the bot does the thinking.

## One issue, start to finish

| When (UTC) | EAT | What runs |
| --- | --- | --- |
| Daily 00:10 | 03:10 | `dispatch/collect-daily`: read the builders list and feeds, append new posts to the week's files |
| Mon 07:00 | 10:00 | `dispatch/finalize`: keyword searches, engagement refresh, author profiles and privacy filter, Aturi lexicon report, repo releases. Freeze the dataset |
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
| Engagement | Every collected post | `getPosts` in batches of 25, so counts reflect the week's end | Monday |
| Authors | Every author in the dataset | `getProfiles`, for labels and current handles | Monday |

The source list lives in a checked-in file, `agent/lib/dispatch/sources.ts`.
Adding a person to the builders list needs no deploy, because the list is a
Bluesky record.

Keyword queries should pair "atmosphere" with atproto terms or limit it to list
members. On its own it matches weather and moods.

### Lexicon data in Aturi

What Aturi should expose, as one HTTP endpoint for the collector and as MCP
tools so Poe can also answer "what's new this week?" in replies:

- **New lexicons**: NSIDs first seen in a window. For each, the estimated
  account count, creates, whether a schema is published, the authority, links
  to a few sample records, and flags such as `single-account` and
  `invalid-looking`.
- **Movers**: each NSID's accounts this window against the previous one, with
  a minimum account floor.
- **Published schemas**: `com.atproto.lexicon.schema` records created or
  updated in the window. If Aturi's ingest does not see every one of these, the
  droplet can add that collection to its Jetstream subscription instead. Per
  Aturi's own numbers, the collection averaged about 57 creates a day from 10
  to 20 accounts over the 30 days to 2026-10-17.

Measured against microcosm's UFOs API on 2026-10-18:

- 2,850 NSIDs were active in the previous 7 days. 34,761 had been seen before
  that.
- 1,024 of the active ones were new. 69 had 2 or more accounts, 44 had 3 or
  more, and 19 had 5 or more, from about 107 distinct authorities.
- The new ones included `app.bsky.actor.link` (profile links) with 10
  accounts. Its schema resolves through bsky.app's `_lexicon` DNS record.
- Account counts are HyperLogLog estimates. "First seen" is only as complete
  as the index's history.

Aturi should keep everything and flag, not drop. The 3-account cut becomes the
analyst's default view of the list, and the full list stays available to it.

### Storage: public on the PDS, private in Blob

Decided 2026-10-18: as much as can be public lives in Poe's repo on
`pds.atpota.to`. Anything on a PDS is public, so drafts and review notes stay
private until they are approved.

**In Poe's repo (public)**

| Record | What it holds | Written by |
| --- | --- | --- |
| `net.anisota.feed.list`, one per week | "atmosphere week of oct 12": the posts Poe read | droplet, on the collector's request |
| `net.anisota.feed.listItem` | one collected post, by at-uri | droplet, daily |
| `to.atpota.dispatch.snapshot`, rkey = issue date | the lexicon report, releases, sources and counts | droplet, Monday |
| `site.standard.document` | the published issue | droplet, after `approve` |

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

### Privacy filter

Applied when records are written, so no model sees what it removes:

- **Opt-outs**: a list the droplet keeps and the collector fetches. Authors on
  it are left out.
- **`!no-unauthenticated`**: authors with this self-label have asked not to be
  shown to logged-out viewers, and atpota.to is logged out. Their posts are left
  out.
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
| Analyst | Declared subagent `dispatch-analyst`, run three times in parallel: lexicons, conversation, shipping | `DISPATCH_ANALYST_MODEL` | Its slice of the dataset, in full, plus Aturi for follow-ups | Findings JSON: each claim with the record ids behind it and the command that produced each number |
| Writer | `dispatch-writer` | `DISPATCH_WRITER_MODEL` | Findings, the voice guide, the last three issues, dispatch style notes, the dataset | `drafts/vN.md` |
| Editor | `dispatch-editor` | `DISPATCH_EDITOR_MODEL` | The draft, findings, the dataset, the lint report | `drafts/vN.final.md`, a change log, and open questions for the operator |

Each role variable falls back to `AGENT_MODEL`, and each has a matching
`_REASONING` variable that falls back to `AGENT_REASONING`. The direct
Anthropic path in `lib/model.ts` applies to all of them: `direct()` becomes a
function that takes a model id, used by the root and the three subagents.

The editor works in a fixed order. It checks every claim against the files
first, then copyedits for voice and length. Anything it cannot verify goes in
its open questions, and those appear in the operator's DM.

Recommendation: start all three roles on the Claude model Poe runs now. I
expect most of the gain to come from separate contexts. The editor reads the
draft cold, without the writer's reasoning in its context, which is the point
of having an editor. Try a different model for the editor during the shadow
weeks and compare. If the editor flattens Poe's voice, split it into a
fact-checker and a copyeditor.

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

A first structure to try, around 600 to 1,000 words:

1. Two or three sentences on the week's biggest thing.
2. New in the Atmosphere: new lexicons above the account threshold, and newly
   published schemas.
3. Growing and shrinking: the movers.
4. What builders talked about: three to five threads, linked.
5. Shipped: releases.

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

**Once**, a `site.standard.publication` record in Poe's repo:

- `name` and `description`: to be chosen.
- `url`: `https://atpota.to/dispatch`.
- `icon`: a potato avatar from `branding/avatars/`, as PNG, at least 256 px
  square and under 1 MB.
- `preferences.showInDiscover`: true.

**Per issue**, after `approve`, the droplet:

1. Creates the `site.standard.document`: `site` is the publication's AT-URI,
   `path` is `/2026-10-12`, plus `title`, `publishedAt`, `description`, `tags`,
   `textContent` (plain text, required for search and other readers), and
   `content` holding the markdown.
2. Calls the website's Vercel deploy hook and waits until the page returns
   200.
3. Posts an announcement from Poe's account with a link card. It has no
   @-mentions, so featured people are not pinged.
4. Updates the document with `bskyPostRef` pointing at the announcement, which
   gives the issue a comment thread.
5. DMs the operator both links.

Each step is idempotent per issue and version, so a retry never publishes
twice. A droplet environment flag switches publishing off.

**Content format.** Standard.site leaves `content` to each platform. All 42 of
the most recent documents in UFOs' sample on 2026-10-18 had `textContent` and
no `content` at all, so `textContent` is what other readers can count on. The
markdown goes in `content` under our own type, `to.atpota.dispatch.markdown`,
for our renderer. Publishing a schema for it is optional; doing so means a
`_lexicon.dispatch.atpota.to` TXT record and a schema record.

## Website

- `website/scripts/build-dispatch.mjs` runs inside `npm run build`. It resolves
  Poe's DID to its PDS, lists `site.standard.document` records, keeps those
  whose `site` is the publication, and writes:
  - `public/dispatch/<path>.html` with
    `<link rel="site.standard.document" href="at://...">` in the head, a
    canonical URL and Open Graph tags;
  - `public/dispatch/index.html`;
  - `public/dispatch/feed.xml` (RSS).
- The markdown renderer has raw HTML turned off and allows only `https:` and
  `at:` links. Draft text started as model output and should be rendered as
  untrusted.
- If the PDS fetch fails, the build fails, and Vercel keeps serving the last
  good deployment rather than an empty page.
- **Publication verification.** Standard.site's docs show a single file at
  `/.well-known/site.standard.publication` returning the publication's
  AT-URI. For a publication at a path, CodeTV, which runs several publications
  on one domain, serves `/.well-known/site.standard.publication/<path>`. The
  plan is to serve `/.well-known/site.standard.publication/dispatch` and check
  it with a validator before launch. The fallback is publication `url`
  `https://atpota.to` with document paths `/dispatch/<date>` and the root file.
- A link to /dispatch on the home page.
- Only the droplet holds the deploy hook URL.

## Risks and controls

| Risk | Control | Where |
| --- | --- | --- |
| Instructions planted in posts | Data is read as data; identifier check; editor check; operator approval | Bot, droplet, operator |
| An invented link, handle or NSID | Identifier check in code, twice | Bot lint, droplet |
| A wrong number | Numbers computed from files; the editor recomputes them; operator review | Subagents, operator |
| Featuring someone who opted out or is `!no-unauthenticated` | Removed at collection, before any model | Collector |
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

## Build phases

**0. Inputs (operator).** The builders list, feeds, repos, keyword list,
publication name, description and icon.

**1. Data.** Aturi endpoints and tools (operator). In the bot: collectors,
Blob layout, privacy filter, the `collect-daily` and `finalize` schedules,
unit tests. Done when a frozen dataset for a real week exists in Blob and spot
checks against Bluesky and UFOs match.

**2. Pipeline.** Subagents, sandboxes, `open_week`, `finalize_draft`,
`submit_draft`, hooks, voice guide, the `draft` schedule, evals. Run locally
with `POST /eve/v1/dev/schedules/dispatch%2Fdraft` and a local catcher like
the one in `bot/README.md`. Done when a local run on the fixture produces a
draft that passes the evals.

**3. Review loop.** In the bot: the `dispatch` channel with the review and
preview routes, and the `dispatch-style` memory slot. In the droplet: DM
delivery, routing, `approve` and `skip`. Done when a draft goes through two
rounds of edits over DM, end to end, against a test account.

**4. Publishing and website.** The publication record, document publishing,
deploy hook, announcement post, website build script, verification file and
RSS. Done when a test issue validates as Standard.site and renders on a
preview deployment.

**5. Shadow weeks.** At least two Mondays with the full pipeline and `approve`
switched off. Measure pipeline time, token use and cost per run, and the
operator's edit count. Tune thresholds, voice and the schedule. Then switch
`approve` on.

**Later.** A section on what people wrote, from atproto-tagged
`site.standard.document` records (about 193,000 creates in the week to
2026-10-17, per Aturi, with full article text, so it needs filtering). Tangled
repos. Poe answering "what's new this week?" in replies from the dataset.
Opt-out requests by DM.

## Work by codebase

**bot/** (this repo)
- `agent/schedules/dispatch/{collect-daily,finalize,draft}.ts`
- `agent/channels/dispatch.ts`: `POST /dispatch/review`, `GET /dispatch/preview/...`
- `agent/instructions/dispatch.ts`: Poe as the dispatch's editor-in-chief
- `agent/subagents/dispatch-{analyst,writer,editor}/`: `agent.ts`,
  instructions, tools, hooks, sandbox, and an Aturi connection for analyst
  and editor
- `agent/tools/{open_week,submit_draft}.ts`, gated to the dispatch channel
- `agent/memory/dispatch-style.ts`
- `agent/lib/dispatch/`: sources, collectors, store, identifiers, lint,
  renderer, voice guide
- `agent/lib/model.ts`: `direct()` takes a model id; role variables added
- `tests/dispatch-*.test.mjs`, `evals/dispatch/`

**website/** (this repo)
- `scripts/build-dispatch.mjs`, wired into `build`
- `.well-known/site.standard.publication/dispatch`
- A home page link

**droplet** (on DigitalOcean, not in this repo). The standalone brief is
[`../mentions/DISPATCH.md`](../mentions/DISPATCH.md). In short:
- Week list and snapshot writes to Poe's repo, on the collector's request
- `POST /dispatch/draft`, the identifier check, DM delivery
- Operator DM routing while a review is open; `approve` and `skip`
- Accept the dispatch collector as a caller of `/internal/bluesky-search`
- Publication setup, document publishing, deploy hook, announcement,
  `bskyPostRef` update
- The opt-out list and an endpoint for the collector to read it
- A publishing kill switch
- Only if Aturi cannot provide published schemas: add
  `com.atproto.lexicon.schema` to the Jetstream subscription

**Aturi** (operator)
- New lexicons, movers and published schemas, as one HTTP endpoint plus MCP
  tools

## Open questions

1. Publication name, description and icon.
2. Week boundary: Monday 00:00 UTC as proposed, or Monday 00:00 EAT (Sunday
   21:00 UTC).
3. DM routing: everything during an open review, as proposed, or only replies
   to the draft message, if the app supports replying to a DM.
4. Should featured people be notified? Proposed no.
5. How does someone opt out? Proposed: by DM to Poe or an operator command,
   recorded by the droplet.
6. Which moderation labels exclude a post.
7. Does Aturi's ingest see every `com.atproto.lexicon.schema` record?
8. Who builds the droplet side, and where does its code live?
9. A per-run cost budget, set after the shadow weeks measure real usage.
10. How Leaflet, pckt and Offprint display a document from another
    publisher. They are likely to use `textContent` or link to the canonical
    URL; this is unverified.
11. Posts that fail the relevance check: drop them, or keep them privately in
    Blob so the analysts still see everything collected?
12. Does Anisota's AppView offer a read endpoint for a list's items? Without
    one, the pipeline pages Poe's `net.anisota.feed.listItem` collection
    newest first and stops at the week's start.

## Sources

- [standard.site](https://standard.site): publication and document verification.
- [UFOs API](https://ufos-api.microcosm.blue/): the 2026-10-18 measurements.
- [microcosm-rs readme](https://tangled.org/nekomimi.pet/microcosm-rs/blob/main/readme.md): what UFOs indexes.
- [CodeTV: multiple standard.site publications on one website](https://codetv.dev/blog/multiple-standard-site-publications-on-one-website): the subpath verification file.
- `chat.bsky.convo.defs`, read through Aturi: the 1,000-grapheme DM limit and `replyTo`.
- eve 0.58 docs in `bot/node_modules/eve/docs`: schedules, subagents, sandbox, hooks.

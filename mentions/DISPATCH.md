# atpotato droplet: weekly dispatch

**Build brief for the droplet side of Poe's weekly dispatch. Self-contained:
you should not need any other conversation to work from it.** Written
2026-10-18, updated 2026-10-19 after the publication was made in Leaflet and
issue 1 was published by hand. The overall plan is `agent-spec/12-weekly-dispatch.md`; read it if
you want the reasoning, but everything you need to build is here.

## What you are adding

The droplet is the always-on service on DigitalOcean that holds Poe's atproto
credential. It already watches Jetstream for mentions, asks the agent for
drafts, gates them, posts replies, relays operator DMs, and publishes Poe's
notes to its repo. Its original brief is `mentions/SPEC.md`.

The weekly dispatch adds five jobs, all of them writes or messages that need
the credential:

1. **Keep the week list.** Write the posts the agent's collector found into a
   public `net.anisota.feed.list` in Poe's repo, one list per week.
2. **Write the weekly snapshot.** One record per week holding the lexicon
   numbers and releases the issue was written from.
3. **Run the review.** DM the operator each version of the draft, relay their
   notes to the agent, and accept `approve` or `skip`.
4. **Publish.** After `approve`, write the `site.standard.document` into
   atpota.to's repo, check the page is up, post the announcement from Poe, and
   link the two.
5. **Keep opt-outs.** Record who has asked to be left out, remove their list
   items, and tell the collector.

**Build phase 0 first** (next section). Issues are published by hand today,
and the one step an operator cannot do by hand is posting from Poe, because
only the droplet holds Poe's credential. Phase 0 is an operator command that
announces an issue already published. It is useful now, needs nothing from the
agent, and its steps are publishing steps 3 to 6, so the same code serves
`approve` later. Jobs 1 to 5 wait on the agent's side, which is not built yet.

## Context you need

**Poe** is the atpotato agent: `poe.atpota.to`, `did:plc:6qw63oash3jfnpykvpbwnq5z`,
repo on `https://pds.atpota.to` (atpotato's own PDS). The agent is an
[eve](https://eve.dev) app on Vercel, in `bot/` in this repository. It reads the
network through Aturi's read-only MCP server and has **no write tool and no
credential**.

**That split is the security model, and the dispatch keeps it.** The agent
produces text and lists of post URIs. Every write, every DM and every publish
decision is code in the droplet. The dispatch reads posts written by strangers,
including keyword search results, so assume a post will eventually try to talk
Poe into including a link or a claim. If an injection succeeds completely
inside the agent, the worst outcome must be a draft the droplet rejects or the
operator declines.

**Where issues live.** Not in Poe's repo: each issue is a
`site.standard.document` in **atpota.to's** repo
(`did:plc:qntsxa2i4sb24noi45fx4np2`, same PDS), in the Leaflet publication
"poe's atmosphere dispatch"
(`at://did:plc:qntsxa2i4sb24noi45fx4np2/site.standard.publication/3myar4h4pls2n`,
url `https://poe.leaflet.pub`). Leaflet serves each issue at
`poe.leaflet.pub/<rkey>`, and the website shows a copy at
`atpota.to/blog/<rkey>`, reading the repo on each request, so no deploy is
needed. Poe is credited through the document's `contributors`. The week list,
the snapshot and the announcement stay in Poe's repo.

So publishing needs a **second credential**, for atpota.to. Use it for one
thing only: `site.standard.document` writes in that publication. Store it like
Poe's, never send it to the agent, and use an app password, never the main
one. (If `pds.atpota.to` supports OAuth permission sets by then, a session
limited to `site.standard.document` is better.)

**Issues are published by hand until this is built.** An operator runs
`npm run publish:dispatch` in `website/` (`website/scripts/publish-dispatch.ts`).
That script is the reference for the record this service writes; match it.
Issue 1 went out that way on 2026-10-19 as
`at://did:plc:qntsxa2i4sb24noi45fx4np2/site.standard.document/3myasnk4bzk22`.

**Nothing is published without an operator's `approve`**, sent by DM from a DID
on the droplet's operator allowlist, and bound to the exact version they saw.

**The schedule.** The agent collects daily and drafts on Monday, so the first
draft DM reaches the operator around 12:00 EAT (09:00 UTC) Monday. The recapped
week is Monday 00:00 UTC to Monday 00:00 UTC. An issue is named by the date its
week starts, for example `2026-10-12`.

## Endpoints that already exist

From the agent's code (the droplet's own code is not in this repository, so fit
the new work to its existing structure):

| Direction | Endpoint | Used for |
| --- | --- | --- |
| droplet → agent | `POST /bluesky/mention` | a mention to answer |
| agent → droplet | `POST /draft` | a reply draft |
| agent → droplet | `POST /memory` | a person's notes to publish |
| agent → droplet | `POST /like-proposal` | a proposed like |
| droplet → agent | `POST /operator/dm` | an operator DM |
| agent → droplet | `POST /dm-draft` | Poe's DM reply |
| agent → droplet | `POST /internal/bluesky-search` | authenticated Bluesky search |
| droplet → agent | `POST /api/scan-approval/respond` | an operator's scan approval |

All of them authenticate with the shared secret in `x-atpotato-secret`
(`DROPLET_SHARED_SECRET` on the agent). New endpoints do the same.

## Phase 0: announce an issue published by hand

An operator sends Poe a DM:

```
announce https://poe.leaflet.pub/3myasnk4bzk22
optional post text, on the lines after the link
```

The link can be `https://poe.leaflet.pub/<rkey>`, `https://atpota.to/blog/<rkey>`
or `at://did:plc:qntsxa2i4sb24noi45fx4np2/site.standard.document/<rkey>`. Accept
the command only from a DID on the operator allowlist, as a message whose first
word is `announce` (any case). Never forward it to the agent. If the link does
not parse, reply with the usage.

Then:

1. **Read the document** from atpota.to's repo with the public
   `com.atproto.repo.getRecord`, and keep its cid. Refuse unless `site` is the
   dispatch publication. If the document already has `bskyPostRef`, or your
   own table already records a post for this document, reply with that post's
   link and stop. A repeated command must never post twice.
2. **Check the page**, as in publishing step 3, at the URL the card will use.
3. **Post from Poe** (Announcement, under Records). The text is the
   operator's lines if there are any, otherwise the title, a blank line and
   the description, cut at a word boundary to fit. Refuse operator text over
   300 graphemes rather than cutting it. Record the post's uri and cid against
   the document before anything else.
4. **Link it.** `putRecord` the document with `bskyPostRef` set to the post
   and `updatedAt` set, every other field unchanged, and `swapRecord` set to
   the cid from step 1 so a concurrent edit is not overwritten. On a swap
   failure, read the record again and retry once. If the atpota.to credential
   is not configured yet, skip this and DM the operator the command that does
   it by hand:
   `npm run publish:dispatch -- <issue file> --rkey <rkey> --bsky-post <post url>`
5. **Reply** with the post's URL.

The command needs `DISPATCH_ENABLED` but not `DISPATCH_PUBLISH_ENABLED`: the
operator's own command is the approval, and the issue is already public.

Issue 1 has no announcement yet, so it is the first real use.

## New endpoints

### 1. `POST /dispatch/collect` (agent → droplet)

The collector sends the posts it found; the droplet adds them to the week list.

```json
{
  "issue": "2026-10-12",
  "items": [
    { "uri": "at://did:plc:.../app.bsky.feed.post/3mabc...", "via": "feed:atproto" }
  ]
}
```

- At most 500 items per call.
- Every `uri` must be an `app.bsky.feed.post` at-uri. Reject the call with
  `400` if any is not; do not partially apply a malformed batch.
- Skip items whose author DID is opted out (see 5).
- Skip items already on that week's list. Keep a local table of
  `(issue, subject_uri)` with a unique constraint; the agent can send the same
  post on several days.
- Create the week's list on first use (record shape below) and remember its
  at-uri.
- Write with `com.atproto.repo.applyWrites`, in batches. The reference PDS has
  a per-call limit on writes; check what `pds.atpota.to` allows and stay under
  it.
- Respond `200` with
  `{ "list": "at://...", "added": 120, "skipped": { "duplicate": 3, "optedOut": 1 } }`.

Expect roughly 150 to 300 items a day. The agent filters for privacy and
relevance before sending, so the droplet's checks are about format, opt-outs
and duplicates, not judgment.

### 2. `POST /dispatch/snapshot` (agent → droplet)

```json
{ "issue": "2026-10-12", "snapshot": { "...": "the record body, shape below" } }
```

Write it with `com.atproto.repo.putRecord` at rkey `2026-10-12` in collection
`to.atpota.dispatch.snapshot`, so a retry overwrites rather than duplicates.
Reject bodies over 200 KB; the agent keeps the snapshot to bounded lists.
Respond `{ "uri": "at://...", "cid": "..." }`.

### 3. `GET /dispatch/optouts` (agent → droplet)

Respond `{ "dids": ["did:plc:..."] }`. The collector reads it before every run.

### 4. `POST /internal/bluesky-search`: accept the collector

The collector runs keyword searches through this existing endpoint. Today it
accepts calls tied to a signed post, an operator DM, or a website session. Add
a caller type for the dispatch collector, and make sure paging with `cursor`
works: unauthenticated search refuses every cursor request, so this endpoint is
the only way the collector gets past the first page. Limit it to about 60
requests per run.

### 5. `POST /dispatch/draft` (agent → droplet)

Each version of the issue, after the agent's editor has finished with it.

```json
{
  "issue": "2026-10-12",
  "kind": "dispatch",
  "version": 2,
  "sha256": "hex of the UTF-8 markdown",
  "title": "attie sites, spaces near beta, and a brand new cow",
  "description": "under 300 characters",
  "markdown": "the issue body",
  "textContent": "the same body as plain text",
  "content": { "$type": "pub.leaflet.content", "pages": ["the body as Leaflet blocks"] },
  "summary": "under 900 graphemes, for the DM",
  "announcement": "the post text for publishing, under 280 graphemes",
  "changes": ["what changed since v1"],
  "openQuestions": ["things the editor could not verify"],
  "previewUrl": "https://<agent host>/dispatch/preview/2026-10-12/2?t=<hmac>",
  "allowed": ["every URL, NSID and DID the draft may use; app sites the agent could not verify are left out"]
}
```

`kind` is `dispatch` for a weekly issue or `post` for anything else Poe writes
for the same publication. A `post` is keyed by a slug instead of the issue
date and has no week list or snapshot; review, approval and publishing work
the same way.

`content` is the markdown already converted to Leaflet blocks by the agent,
with the same converter the website uses (`website/build/leaflet-markdown.ts`),
so the droplet writes it as is and needs no markdown parser.

On receipt:

1. Recompute the sha256 of `markdown` and reject a mismatch.
2. **Identifier gate.** Extract every `http(s)://` URL, every backticked token
   that looks like an NSID (three or more dot-separated segments), and every
   `did:plc:` or `did:web:` string from title, description, markdown and
   announcement, and
   every `uri` in `content`'s facets, since that is what readers click. Strip
   trailing punctuation and trailing slashes. Each must be in `allowed`, or be
   under `https://atpota.to/`. Same rule as the reply link gate: a host
   allowlist cannot catch an invented path on a real domain.
3. Reject raw HTML in the markdown, and any `content` block other than text,
   header, unordered and ordered list, blockquote, code and horizontal rule
   (no images or embeds yet).
4. If any check fails, store the version as `rejected`, and DM the operator
   that version N failed the gate and why. Do not send it as a draft.
5. Otherwise store it as the issue's latest version and DM the operator
   (format below). Record the DM's message id against the version.

Respond `202` once stored. Versions are idempotent on `(issue, version)`.

### 6. Operator DMs during a review

An issue is **in review** from its first accepted draft until it is approved,
skipped, or superseded by the next week's draft.

While an issue is in review, an operator DM is handled like this:

| Message | Action |
| --- | --- |
| exactly `approve` (any case, trimmed) | approve the latest version you DM'd |
| exactly `approve vN` | approve version N, if it is the latest accepted version |
| exactly `skip` | mark the issue skipped; DM a confirmation |
| anything else | forward to the agent as review notes (below) |

When no issue is in review, DMs go to the existing `/operator/dm` path as
today.

If the agent is still writing a newer version when `approve` arrives (you have
forwarded notes and no draft has come back yet), do not guess. Reply that
version N+1 is being written and ask for `approve vN` to publish the older one.

Forward notes to the agent:

```
POST <agent host>/dispatch/review
x-atpotato-secret: <shared secret>

{ "issue": "2026-10-12", "version": 2, "operatorDid": "did:plc:...",
  "messageId": "<chat message id>", "text": "the operator's message, verbatim" }
```

`version` is the latest version the operator has been sent. The agent replies
in one of two ways: a new `POST /dispatch/draft`, or a short answer through the
existing `POST /dm-draft`.

The DM lexicon (`chat.bsky.convo.defs#messageInput`) has a `replyTo` field.
If the Bluesky app lets the operator reply to a specific message, a later
version of this can route only replies to the draft DM as notes. Not needed for
the first version.

### DM format

A DM message is capped at 1,000 graphemes, so the draft itself never goes in
it. Send:

```
dispatch for oct 12 to 18, version 2 is ready ⸜(｡˃ ᵕ ˂ )⸝

<summary from the agent>

post: <announcement>

changed since v1: <changes, one line each, cut to fit>
not sure about: <openQuestions, cut to fit>

read it: <previewUrl>
reply with notes to revise, "approve" to publish, or "skip" to drop this week.
```

Count graphemes, not characters, and cut the change and question lists first
if it runs long. Never cut the preview link or the commands.

## Publishing, after `approve`

Run these steps in order. Record each step's result so a crash or restart
resumes where it stopped, and so no step runs twice.

1. **Check.** The approved version's stored markdown still hashes to its
   sha256, and `DISPATCH_PUBLISH_ENABLED` is true. If publishing is disabled
   (shadow mode), DM "shadow mode: not published" and stop. List the
   publication's documents in atpota.to's repo; if one already has this
   version's title, an operator published it by hand, so store that document
   and skip to step 3.
2. **Write the document.** Generate a TID from the current time as the record
   key and store it before writing, then `com.atproto.repo.putRecord` in
   `site.standard.document` in atpota.to's repo with that key (shape below). A
   retry reuses the stored key, so it overwrites instead of duplicating. Store
   the at-uri and cid.
3. **Check the page.** Poll `https://poe.leaflet.pub/<rkey>` every 20 seconds,
   for up to 10 minutes, until it returns 200 **and** its HTML contains
   `<link rel="site.standard.document" href="<the document's at-uri>">`. Leaflet
   indexes from the network, so this proves it has the issue. On 2026-10-19 it
   showed issue 1 within a minute. `https://atpota.to/blog/<rkey>` needs no
   check: it reads the repo directly.
4. **Post the announcement** from Poe's account (shape below).
5. **Link them.** `putRecord` the document again with `bskyPostRef` set to the
   announcement's `{ uri, cid }` and `updatedAt` set, keeping `publishedAt`.
6. **Confirm.** DM the operator the page URLs and the post URL.

If step 3 times out, DM the operator and stop before posting; the announcement
should never link to a page that is not up. They can retry with `approve`
again, which resumes at step 3.

## Opt-outs

- Operator DM commands, accepted at any time, exact match:
  `optout <handle or did>` and `optin <handle or did>`. Resolve handles to DIDs
  and store DIDs.
- On `optout`: store the DID, then delete that DID's items from every week
  list with `applyWrites` deletes, and confirm by DM with the count removed.
- People asking Poe directly ("leave me out of the dispatch") is a later
  feature. For now the operator records it.

## Records

The week list, list items, snapshot and announcement are in Poe's repo. The
document is in atpota.to's repo.

**Week list**, `net.anisota.feed.list` (schema published by anisota.net):

```json
{
  "$type": "net.anisota.feed.list",
  "name": "atmosphere week of oct 12",
  "description": "posts poe read for the dispatch covering 2026-10-12 to 2026-10-18",
  "tags": ["atproto", "dispatch"],
  "createdAt": "2026-10-12T00:10:00.000Z"
}
```

`name` is at most 64 characters and `description` at most 300.

**List item**, `net.anisota.feed.listItem`:

```json
{
  "$type": "net.anisota.feed.listItem",
  "list": "at://did:plc:6qw63oash3jfnpykvpbwnq5z/net.anisota.feed.list/<rkey>",
  "subject": "at://did:plc:.../app.bsky.feed.post/<rkey>",
  "createdAt": "2026-10-14T00:10:00.000Z"
}
```

Items reference posts; they never copy them. A post its author deletes drops
out of the list's view on its own.

**Snapshot**, `to.atpota.dispatch.snapshot` (our own lexicon; publishing its
schema under `_lexicon.dispatch.atpota.to` is optional):

```json
{
  "$type": "to.atpota.dispatch.snapshot",
  "issue": "2026-10-12",
  "since": "2026-10-12T00:00:00.000Z",
  "until": "2026-10-19T00:00:00.000Z",
  "list": "at://.../net.anisota.feed.list/<rkey>",
  "lexicons": { "totals": {}, "newLexicons": [], "movers": {}, "topOutsideBluesky": [], "publishedSchemas": [] },
  "releases": [],
  "sources": { "lists": [], "feeds": [], "queries": [], "repos": [] },
  "createdAt": "..."
}
```

The agent fills the body; the droplet only checks size and writes it.

**Publication**: already exists, made in Leaflet. Do not create or edit it.
Its at-uri is
`at://did:plc:qntsxa2i4sb24noi45fx4np2/site.standard.publication/3myar4h4pls2n`
and its url `https://poe.leaflet.pub`. Leaflet serves its verification file.

**Document**, `site.standard.document`, in atpota.to's repo, shaped like the
documents Leaflet writes itself:

```json
{
  "$type": "site.standard.document",
  "site": "at://did:plc:qntsxa2i4sb24noi45fx4np2/site.standard.publication/3myar4h4pls2n",
  "path": "/<rkey>",
  "title": "<title>",
  "description": "<description>",
  "publishedAt": "<now>",
  "tags": ["atmosphere", "dispatch"],
  "contributors": [{ "did": "did:plc:6qw63oash3jfnpykvpbwnq5z" }],
  "textContent": "<textContent>",
  "content": "<content, as the agent sent it>",
  "bskyPostRef": { "uri": "...", "cid": "..." }
}
```

`path` is the record key, so the issue is at `https://poe.leaflet.pub/<rkey>`
and `https://atpota.to/blog/<rkey>`. `bskyPostRef` is added in step 5. A record
must stay under about 145 KB (issue 1 was 27 KB).

**Announcement**, `app.bsky.feed.post`:

- Text under 300 graphemes: the operator's text in phase 0, the approved
  version's `announcement` later. If it contains the page URL, give that a
  link facet.
- An `app.bsky.embed.external` card: the page URL, title, description, and a
  thumbnail blob uploaded from the page's Open Graph image (Leaflet generates
  one per issue).
- `langs: ["en"]`.
- **No mention facets.** Featured people are not pinged. The link is the only
  facet.

## State

Something like this, in whatever store the droplet already uses:

```
dispatch_issue     issue (pk), state, list_uri, snapshot_uri, document_rkey, document_uri, document_cid,
                   post_uri, post_cid, approved_version, publish_step, updated_at
dispatch_version   issue, version, sha256, title, description, markdown, text_content,
                   summary, preview_url, status (accepted|rejected), reject_reason,
                   dm_message_id, created_at          unique (issue, version)
dispatch_item      issue, subject_uri, author_did, via, created_at   unique (issue, subject_uri)
dispatch_optout    did (pk), created_at
dispatch_event     id, issue, kind, detail, created_at     an audit log
```

Issue states: `collecting` → `in_review` → `approved` → `publishing` →
`published`, or `skipped`, or `expired` (when the next week's first draft
arrives while this one is still in review).

## Configuration

| Variable | Meaning |
| --- | --- |
| `DISPATCH_ENABLED` | Off: every dispatch endpoint answers `503` and DMs are routed as today |
| `DISPATCH_ANNOUNCE_URL_BASE` | Where the card links: `https://poe.leaflet.pub` (the default: Leaflet makes an image for each issue and has a subscribe button) or `https://atpota.to/blog` |
| `DISPATCH_PUBLISH_ENABLED` | Off (the default): shadow mode. Drafts and reviews work; `approve` does not publish |
| `DISPATCH_PUBLICATION_URI` | `at://did:plc:qntsxa2i4sb24noi45fx4np2/site.standard.publication/3myar4h4pls2n` |
| `DISPATCH_PUBLISHER_IDENTIFIER` | `atpota.to` |
| `DISPATCH_PUBLISHER_APP_PASSWORD` | An app password for atpota.to. Secret; only the droplet holds it. Check after signing in that the session's DID is atpota.to's |

The agent host and the shared secret are the ones already configured.

## Tests

Unit tests, written before wiring anything to the real account:

- Command parsing: `approve`, `Approve `, `approve v2`, `approve v2 please`
  (not a command, goes to the agent as notes), `skip`, `optout alice.example`.
- `approve` while a newer version is being written asks for `approve vN`.
- The identifier gate: an invented path on a real domain, a backticked NSID
  that is not in `allowed`, a DID at the end of a sentence, a trailing slash.
- A sha256 mismatch is rejected.
- `/dispatch/collect` rejects a batch containing a non-post at-uri, skips
  duplicates and opted-out authors, and creates the week list once.
- Publishing resumes at the step it stopped on and never creates a second
  document or post for the same issue.
- DM text never exceeds 1,000 graphemes and always keeps the preview link and
  the commands.

- The document written matches what `website/scripts/publish-dispatch.ts`
  writes for the same issue, apart from the record key and times.
- An issue already published by hand is not published again.
- `announce`: a repeated command posts once; a document from another
  publication is refused; operator text over 300 graphemes is refused, not
  cut; the post has no mention facets; the `bskyPostRef` write keeps every
  other field and uses `swapRecord`; with no atpota.to credential it posts and
  DMs the manual command.

Then end to end against a test account and a test PDS before the real repos.

## Rollout

0. Phase 0, the `announce` command, tested against a test account first. It
   needs only Poe's credential; the atpota.to credential can come later.
1. Endpoints 1 to 3 and opt-outs, with `DISPATCH_PUBLISH_ENABLED` off. The
   agent starts filling week lists.
2. Endpoints 4 to 6 and DMs. At least two Mondays of shadow review: real drafts,
   real notes, `approve` answering "shadow mode".
3. The atpota.to credential, then `DISPATCH_PUBLISH_ENABLED` on. Until then,
   operators publish approved issues by hand with `publish:dispatch`.

## Open questions

1. App password or scoped OAuth for the atpota.to credential (see above).
2. Should the announcement link `poe.leaflet.pub/<rkey>` (the default, set by
   `DISPATCH_ANNOUNCE_URL_BASE`) or `atpota.to/blog/<rkey>`?
3. Does `pds.atpota.to` have write rate limits enabled, and what is its
   `applyWrites` batch limit?
4. Should a later version route only DM replies to the draft message as notes?
   Depends on whether the Bluesky app supports replying to a DM.
5. Does Anisota's AppView offer a read endpoint for a list's items? If so, the
   agent can read the week list through it instead of paging Poe's whole
   `net.anisota.feed.listItem` collection.

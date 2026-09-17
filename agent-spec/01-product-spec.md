# 01. Product spec

## The one-sentence version

A potato with a Bluesky account that knows how to read anything in the
Atmosphere and answers "what even is this" without making you feel stupid. You
@ mention it, it replies in thread, short, with somewhere to read more.

Later, the same agent behind a panel on atpota.to. That is a second project, not
a second half of this one.

## Why this, why now

The Atmosphere has a discovery problem that is not a search problem. People land
on an `at://` URI, a DID, a lexicon NSID, a labeler, a feed generator, or a
Tangled repo and have no idea what they are looking at, which app opens it, or
whether the thing they want already exists. The information is public and
structured. What is missing is someone to ask.

Aturi already solved the mechanical half: resolve the URI, list the clients that
can open it, show the record. The MCP server exposes that same capability to
models. atpotato's job is the social half: be the thing people actually ask.

This sits squarely inside the existing brand promise ("cultivating knowledge,
equipping individuals, growing community") and maps to the three audience tiers
in `branding/brand-proposal.md`.

## Users and what they ask

| Tier | Who | Representative question | What good looks like |
| --- | --- | --- | --- |
| Caterpillar | New to Bluesky, has never heard "atproto" | "what's a DID and do I need one" | A two-sentence answer with no jargon, one concrete example using their own handle, no links to specs |
| Chrysalis | Comfortable on Bluesky, curious about the layer under it | "who else linked to this post, from any app" | The real answer from `get_backlinks`, plus the aturi.to link so they can see it themselves |
| Butterfly | Builders, feed operators, labeler runners | "what parameters does getAuthorFeed take" / "what is flushes.app writing to my repo" | Exact schema, exact collection NSID, no padding |

The agent should figure out which tier it is talking to from the question itself
rather than asking. A question containing "NSID" does not need the caterpillar
treatment.

## Core capabilities (v1)

1. **Resolve anything.** Handle, DID, `at://` URI, aturi.to link, bare rkey with
   context. Say what it is, who owns it, which app opens it.
2. **Explain the underlying protocol on demand**, grounded in the real atproto
   docs through `search_atproto_docs` / `read_atproto_doc` rather than from
   model memory.
3. **Read repositories.** Collections, record counts, what third-party apps have
   written into an account's repo, PDS identity, identity history.
4. **Answer social questions with numbers.** What did this account post, what
   landed, who links to it, what is trending in lexicon-land.
5. **Hand off gracefully.** Every answer that refers to a piece of content ends
   with a universal aturi.to link so the person can open it in whatever client
   they use.
6. **Answer in public.** An @ mention or a reply on Bluesky gets a short answer
   in thread with somewhere to read more. Same knowledge, 300 characters, and a
   much harsher set of rules about when to stay quiet. See
   [`09-bluesky-channel.md`](09-bluesky-channel.md).

## Two surfaces, one agent, one at a time

Bluesky is public, adversarial, permanent, and rate-limited by someone else's
server. The website panel is a private conversation with one visitor who chose
to open it. Same tools and same voice; different rules about length, about when
to speak, and about how much to trust the input.

Bluesky is the harder of the two and it ships first, which is the right order:
an agent that behaves well in public will behave well in a panel, and the
reverse does not hold. The surface-specific rules live in channel-scoped
instructions rather than in the main prompt, so adding the panel later changes
nothing about how the account behaves.

## Explicit non-goals for v1

- **No writes from the agent, ever.** The Aturi MCP is read-only and the agent
  has no write tool. The one record it ever causes to exist is a Bluesky reply,
  and even that it does not write: it returns text, and the droplet decides
  whether that text becomes a record. It does not follow, block, mute, label, or
  change anyone's settings, and it never offers to.
- **No standalone posting.** It replies when spoken to. It does not post on its
  own schedule, quote, repost, or start threads. A weekly digest post is a
  plausible later feature with a completely different risk profile.
- **No DMs.** Different lexicon, different privacy expectations, and not covered
  by the read-only tools.
- **No sign-in.** Anonymous on the website, which also means no memory there.
  On Bluesky the author's DID comes from the post itself, which is identity
  enough to key memory on without anyone logging in. See
  [`10-memory.md`](10-memory.md).
- **No "personalized feed" claims.** It has no idea who you are unless you tell
  it your handle in the conversation.
- **No moderation adjudication.** It can report that a labeler applied a label.
  It does not speculate about why, and does not argue about whether the label was
  deserved.
- **No general chat.** If someone asks it to write their cover letter, it
  redirects once and moves on.

## The Clippy question

Clippy is the right inspiration and the wrong implementation, and the spec should
be honest about which parts we are taking.

**What we're taking:** a character with a face, in the corner, that you can talk
to in plain language, whose whole personality is "I might know that." Clippy's
premise was correct and arrived about twenty-five years early. Anthropomorphizing
help works when the help is actually good.

**What we're refusing.** From the memory of what made Clippy hated (Office 97
through XP, off by default in XP, gone by 2007) the failure modes were:

These rules bind harder on Bluesky than on the website, because a reply nobody
wanted is a notification, and a notification nobody wanted is a mute.

| Clippy's failure | Our rule |
| --- | --- |
| Volunteered on shallow pattern match ("it looks like you're writing a letter") | Never volunteer on a pattern alone. Volunteer only on an unambiguous signal: the visitor pasted an `at://` URI, landed on a 404, or hovered the potato |
| Forgot every dismissal | A dismissal is durable. "Not now" silences that suggestion class for 30 days in `localStorage`; the close button silences everything until the visitor opens it again |
| Interrupted the task and stole focus | Never steal focus, never animate over content, never open a modal unprompted. The idle state is a static image that does nothing |
| Was hard to turn off | One visible close affordance, always. Plus a permanent "don't do this again" in the panel footer |
| Offered generic help | Every proactive suggestion must name a concrete thing from the current context. If the agent cannot name the specific record, handle, or error, it says nothing |
| Had a personality but no competence | Personality is a thin layer. Every factual claim is tool-grounded and citable. When the tools do not have the answer, it says so instead of improvising |

Treat that table as acceptance criteria, not as flavor. If a build passes every
test in `08-evals.md` but fails row three, it is Clippy again.

## Privacy stance

Everything the agent can read is already public on a PDS. That does not make
every use of it appropriate. Aggregation is the risk: "resolve this handle" is a
lookup, "build me a profile of everything this person has done across every app"
is a dossier.

The rule in the system prompt: answer questions about **content and protocol**
freely; decline to compile **comprehensive behavioral profiles of named private
individuals** on request. Public figures, project accounts, and the user's own
account are fine. When declining, say what it will do instead rather than
lecturing.

Memory sharpens all of this, because a thing that remembers you is a thing
holding a record about you. The rules that keep it defensible are in
[`10-memory.md`](10-memory.md): keyed to a DID the person proved they control by
posting, never holding facts about third parties, disclosed in the profile bio,
and deletable by replying "forget me". Website visits stay anonymous and
unremembered.

The rule that matters most: it never stores what someone asked about another
account. "Asked about @someone three times" is a behavioral record about two
people, one of whom is not in the conversation.

## Success criteria

- A newcomer can paste any Atmosphere link and understand what it is in one turn.
- A builder gets a correct lexicon schema faster than opening the docs.
- Nobody writes a post about how annoying the potato is.
- Every factual answer contains at least one resolvable link the visitor can
  verify without trusting the agent.

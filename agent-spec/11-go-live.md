# 11. Go live

A runbook, in order. Each step ends in something you can check.

Two things stay true throughout. **The agent never holds the atproto
credential**, and **nothing reaches Bluesky until the droplet's `STAGE` reaches
4**, which is a separate decision made on a separate machine. Deploying the
agent is therefore safe: a deployed agent with the droplet at stage 1 cannot
post, by construction rather than by configuration.

## Settled decisions

| Decision | Choice |
| --- | --- |
| Which account | `@atpota.to` itself, `did:plc:qntsxa2i4sb24noi45fx4np2`, shared with human posting |
| Where it runs | Vercel, deployed from `bot/` |
| Model | `anthropic/claude-opus-5` through the Vercel AI Gateway, so no provider key |
| Jetstream | `wss://jetstream.us-west.bsky.network`. East returns 503 |

Using the main account is a product decision with one structural consequence:
the reply trigger has to mean "a reply to something the bot wrote", never "a
reply to anything from this DID". Otherwise every reply to an announcement post
gets answered by a potato. `mentions/SPEC.md` has the detail; confirm it is
implemented before stage 3.

## 1. Deploy the agent

Node 24 or newer, from `bot/`, not the repository root.

```bash
cd bot
npm install
npx eve link      # pick your team, create a project (suggest: atpotato-agent)
```

`eve link` also pulls the project environment, so an AI Gateway credential lands
in `.env.local` and local runs work too. Do not use Vercel's dashboard agent
flow; it starts from a template and cannot target an existing repository.

Set two variables in the new project's environment:

| Variable | Value |
| --- | --- |
| `DROPLET_SHARED_SECRET` | A long random string. The same value goes in the droplet's `.env` |
| `DROPLET_CALLBACK_URL` | Where the droplet receives drafts, reachable from Vercel |

Then:

```bash
npx eve deploy
```

## 2. Talk to the deployed agent

This is the step that has never happened. The agent has been compiled and
discovered but has never answered anything.

```bash
curl https://<your-agent>.vercel.app/eve/v1/health
npx eve dev https://<your-agent>.vercel.app
```

The second command attaches the terminal UI to the deployment. Ask it:

```
at://did:plc:6teuhlkizzebk6wdp42633el/app.bsky.feed.post/3mtkpzxkh5k2e
how do record keys work in atproto?
what's a DID and do i need one?
what has atpota.to been posting about lately?
```

Looking for: the record resolves and comes back with an aturi.to link; the
protocol question is answered from a docs tool call rather than from memory; the
DID answer is two jargon-free sentences.

**The most likely first failure** is answering protocol questions from memory.
Fix it by lengthening the `description` in `agent/connections/atmosphere.ts`,
then by inlining the compressed routing table from `04-aturi-connection.md` into
`agent/instructions.md`.

Two security checks before moving on:

```bash
# Should be refused: the /eve/v1 surface is not public.
curl -i -X POST https://<your-agent>.vercel.app/eve/v1/session

# Should be 401: the Bluesky route rejects a bad secret.
curl -i -X POST https://<your-agent>.vercel.app/bluesky/mention \
  -H 'content-type: application/json' -H 'x-atpotato-secret: wrong' -d '{}'
```

`agent/channels/eve.ts` ships `placeholderAuth()`, which refuses browser
requests in production while `vercelOidc()` lets your own tooling in. Confirm
that rather than assume it.

## 3. Run the evals

```bash
cd bot
npx eve eval
```

Each case is a real turn, so this costs money. Start with the routing cases and
the grounding assertion, which is the one that catches a fabricated DID.

Iterate on the prompt here, while being wrong is still private. After stage 4,
every change is a change made in public.

## 4. Prepare the account

No account to create. What changes on `@atpota.to`:

- **A disclosure in the bio.** The description field caps at 256 graphemes and
  the current bio uses roughly 175, so there is room for one line. It needs to
  say that replies may be automated and how to stop them. Something like:
  `replies from this account may be an AI. say 'stop' and it'll leave you alone.`
- **An app password**, minted fresh for this and revocable on its own. It goes
  into the droplet's `.env` and nowhere else. Not in this repository, not in
  Vercel, not in the agent.
- Nothing about avatar or handle changes. The potato is already the potato.

## 5. Wire up the droplet

The service is built and running at stage 1. To connect it:

- `AGENT_URL` points at the Vercel deployment.
- `DROPLET_SHARED_SECRET` matches the value in the Vercel project.
- `DROPLET_CALLBACK_URL` is reachable from Vercel, and matches what you set
  there.
- `ATPROTO_APP_PASSWORD` is set. Without it the notification sweep disables
  itself and Jetstream becomes the only detection path, which gives up the
  safety net exactly where a bounded replay window bites.

Then two checks that are not optional:

- **Diff the contract against `bot/agent/lib/bluesky.ts`.** The service was
  implemented from the brief without the agent repository on hand, and the
  callback has since gained `links`.
- **Confirm the reply trigger is bot-authored-only.** Test it with the URI of a
  real `@atpota.to` announcement post. It must not match.

## 6. Shadow

Move the droplet to stage 3. Matches go to the agent, drafts come back, drafts
land in the queue, nothing reaches Bluesky.

Sit with it. Read a few hundred drafts next to the posts that prompted them.

What you are looking for, in order of how much it matters:

1. **Drafts for posts that were not questions.** On a shared brand account this
   is the failure mode, not an edge case. The substance gate's 80 character
   floor is a placeholder, not a calibration; the real number comes from
   atpotato's own mention traffic, which `npm run stats` exists to show you.
2. **Fabricated identifiers.** Any DID or NSID in a draft that is not in that
   turn's tool results is a prompt problem. Add the case to the eval suite.
3. **Drafts over 300 graphemes.** A prompt problem, not a truncation problem.
4. **Voice drift.** Preambles, "great question", enthusiasm. Tighten the
   `bluesky-reply` skill.

Do not skip this. It is the last stage where a mistake costs nothing, and it is
worth more on a brand account than it would be on a throwaway one.

## 7. Go live

- `STAGE=4`, global rate at 10 replies per hour.
- Denylist empty, opt-out path working end to end.
- Kill switch tested for real, by someone other than whoever built it, and
  independent of `STAGE` so you can go quiet without changing pipeline
  semantics.
- Spend ceiling on the Vercel project and an alert at half of it.
- Tell a handful of people who will be honest with you. Nobody else yet.

Then wait a week. If it has been boring, raise the ceiling.

## Day one operations

**Watch:** the rejection log, replies per hour, model spend, and the gap rate
between Jetstream and the notification sweep.

**The kill switch is the first response to anything surprising.** Go quiet, then
diagnose. A potato that stops talking is fine; a potato that keeps talking while
you debug is not.

**If it posts something wrong**, and it will eventually: delete the post, say so
plainly if anyone noticed, add the case to the eval suite, fix, and only then
turn the poster back on. Do not argue with anyone about it. This matters more
here than it would elsewhere, because the reply came from the brand.

**Rollback:** the poster is the only component that changes the outside world.
Disabling it is a complete rollback, and the consumer keeps running so you lose
no events while you fix things.

## After it is boring

Memory, per [`10-memory.md`](10-memory.md). Then, if you still want it, the
website panel in [`06-ui-spec.md`](06-ui-spec.md), which by then has months of
real questions behind it to design against.

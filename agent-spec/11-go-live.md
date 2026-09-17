# 11. Go live

A runbook, in order. Each step ends in something you can check, and nothing
below depends on the website panel in `06-ui-spec.md`.

Two things stay true throughout: **the agent never holds the atproto
credential**, and **nothing posts until a human has read a few hundred drafts**.

## 0. Decide three things

| Decision | Recommendation |
| --- | --- |
| Which account posts | A new handle, not `@atpota.to`. If the org account is the bot, every casual mention becomes a trigger, and people mention brands without asking them anything |
| Where it lives | `pds.atpota.to`. You run it, the write limits are yours, and the bot becomes a demo of the thing it explains |
| Language for the service | Whatever the existing Jetstream consumer already is. Extending it beats standing up a second one |

## 1. Get the agent answering, locally

Node 24 or newer. The project is already scaffolded.

```bash
cd bot
npm install
npm exec -- eve dev
```

Connect your Vercel account at the login prompt. The model is
`anthropic/claude-opus-5` through the AI Gateway, so there is no Anthropic key
to manage; the gateway authenticates over your Vercel account locally and over
project OIDC once deployed.

Check, in the REPL:

```
at://did:plc:6teuhlkizzebk6wdp42633el/app.bsky.feed.post/3mtkpzxkh5k2e
how do record keys work in atproto?
what's a DID and do i need one?
what has atpota.to been posting about lately?
```

You are looking for: the record resolves and comes back with an aturi.to link;
the protocol question is answered from a docs tool call rather than from memory;
the DID answer is two jargon-free sentences.

**The most likely first failure** is the model answering protocol questions from
memory. Fix it by lengthening the `description` in
`agent/connections/atmosphere.ts`, then by inlining the compressed routing table
from `04-aturi-connection.md` into `agent/instructions.md`.

## 2. Run the evals

```bash
cd bot
npm exec -- eve eval
```

These cost money, because each case is a real turn. Start with the routing cases
and the grounding assertion, which is the one that catches a fabricated DID.

Iterate on the prompt here, while it is free to be wrong. Every change you make
after the account exists is a change made in public.

## 3. Create the bot account

On `pds.atpota.to`:

- Handle, and a potato avatar from `branding/`.
- A bio that discloses what it is and how to stop it. Something like: `an AI
  potato that answers questions about atproto. reply 'stop' and i'll leave you
  alone. atpota.to`
- An app password. It goes into the droplet's environment and nowhere else. Not
  in this repository, not in Vercel.
- Resolve the new handle once and record the DID. The service pins the DID, not
  the handle.

## 4. Deploy the agent

From `bot/`, not from the repository root:

```bash
cd bot
npm exec -- eve link      # pick a team, create a project
npm exec -- eve deploy    # installs, vercel deploy --prod, pulls env
```

Do not try to create this from Vercel's dashboard agent flow. That starts from a
template and cannot target an existing repository.

Set in the new project's environment:

| Variable | Value |
| --- | --- |
| `DROPLET_SHARED_SECRET` | A long random string. The same value goes in the droplet's environment |
| `DROPLET_CALLBACK_URL` | Where the droplet receives drafts. Must be reachable from Vercel |

Verify:

```bash
curl https://<your-agent>.vercel.app/eve/v1/health
npm exec -- eve dev https://<your-agent>.vercel.app
```

Two things to check before moving on:

- **The `/eve/v1` surface is not open to the public.** `agent/channels/eve.ts`
  ships with `placeholderAuth()`, which rejects browser requests in production
  while `vercelOidc()` lets your own tooling in. Confirm that an unauthenticated
  `POST /eve/v1/session` is refused.
- **The Bluesky route rejects a bad secret.** It should answer `401`:

  ```bash
  curl -i -X POST https://<your-agent>.vercel.app/bluesky/mention \
    -H 'content-type: application/json' -H 'x-atpotato-secret: wrong' -d '{}'
  ```

### Optional: push-to-deploy

Once one manual deploy has proved the build works, connect
`atpota-to/atpota.to` in the project's Git settings, set **Root Directory** to
`bot/`, and set **Build Command** to `eve build`. Add an ignored build step to
both this project and the website project so they stop rebuilding each other:

```json
{ "ignoreCommand": "git diff --quiet HEAD^ HEAD ./" }
```

Adding that to `website/vercel.json` changes a live production config, so do it
deliberately and watch the next site deploy.

## 5. Build the service

Hand [`mentions/SPEC.md`](../mentions/SPEC.md) to whoever or whatever is
building it. It is self-contained and includes the exact HTTP contract with the
agent, which is already implemented on the agent side.

Its milestone 1 is detect-only and its cost is days of waiting, so **start it as
early as you can**, in parallel with steps 1 and 2. It does not need the agent
to exist.

## 6. Shadow

Wire the two together with the poster disabled. Matches go to the agent, drafts
come back, everything lands in the queue and nothing reaches Bluesky.

Sit with it. Read a few hundred drafts next to the posts that prompted them.

What you are looking for, in order of how much it matters:

1. **Drafts for posts that were not questions.** The substance gate is too
   loose, or the agent should have returned nothing.
2. **Fabricated identifiers.** Any DID or NSID in a draft that is not in that
   turn's tool results is a prompt problem, and the grounding eval should have
   caught it. Add the case.
3. **Drafts over 300 graphemes.** A prompt problem, not a truncation problem.
4. **Voice drift.** Preambles, "great question", enthusiasm. Tighten the
   `bluesky-reply` skill.

Do not skip this. It is the last stage where a mistake costs nothing.

## 7. Go live

- Global rate at 10 replies per hour.
- Denylist empty, opt-out path working end to end.
- Kill switch tested for real, by someone other than the person who built it.
- Spend ceiling on the Vercel project and an alert at half of it.
- Tell a handful of people who will be honest with you. Nobody else yet.

Then wait a week. If it has been boring, raise the ceiling.

## Day one operations

**Watch:** the rejection log (which gates fire and how often), reply volume per
hour, model spend, and the gap rate between Jetstream and the notification
sweep.

**The kill switch is the first response to anything surprising.** Go quiet, then
diagnose. A potato that stops talking is fine; a potato that keeps talking while
you debug is not.

**If it posts something wrong:** delete the post, say so plainly if anyone
noticed, add the case to the eval suite, fix, and only then turn the poster back
on. Do not argue with anyone about it.

**Rollback:** the poster is the only component that changes the outside world.
Disabling it is a complete rollback, and the consumer can keep running so you
lose no events while you fix things.

## After it is boring

Memory, per [`10-memory.md`](10-memory.md). Then, if you still want it, the
website panel in [`06-ui-spec.md`](06-ui-spec.md), which by then has months of
real questions behind it to design against.

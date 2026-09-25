# bot

This is an [eve](https://eve.dev) agent bootstrapped with [`eve init`](https://eve.dev/docs/reference/cli#eve-init).

## Getting started

First, run the development server:

```bash
eve dev
```

The development TUI opens an interactive session where you can send messages to your agent.

Start by editing `agent/instructions.md` to define the agent's identity, purpose, tone, and response guidelines. Configure its model and runtime behavior in `agent/agent.ts`.

Add capabilities under `agent/`, including tools, connections, channels, skills, subagents, and schedules. eve reloads your changes as you work.

## Testing Poe's voice locally

Poe's personality lives in `agent/instructions.md` (the Voice section) and its
Bluesky format and sample replies in `agent/skills/bluesky-reply.md`.

### Setup, once

eve needs Node 24 or newer.

```bash
npm install
npx eve link        # pick the Poe project; pulls model credentials into .env.local
```

To hear the voice production hears, copy `AGENT_MODEL` and `AGENT_REASONING`
from the Vercel project's environment variables into `.env.development.local`.
eve reads that file after `.env.local`, so its values win, and every `.env*`
file is gitignored. Without them the model falls back to the default in
`agent/lib/model.ts`.

### Chat with it

```bash
npx eve dev
```

Running locally, the chat previews Bluesky mode: each message is treated as a
post that mentions Poe, with the same reply rules, faces and length target as
Bluesky (see `agent/lib/preview.ts`). Nothing is posted; only the bluesky
channel ever hands a draft to the droplet. Use `/reset` between unrelated tests.

- `POE_PREVIEW=off npx eve dev` gives the plain chat without Bluesky rules.
- `npx eve dev https://<deployment>` talks to a deployment, which never
  previews, so it is always the plain chat.

A preview reply is the raw draft. The droplet still strips faces from anything
over 200 characters and splits long drafts into posts before they go out.

### Run the evals

```bash
npx eve eval bluesky          # the Bluesky voice evals
npx eve eval --tag voice      # every voice eval
npx eve eval                  # everything
```

Each eval is a real model turn plus judge calls, so each run costs a little.
The judge model is set in `evals/evals.config.ts`. Results print per check;
the full record of a run lands in `.eve/evals/<timestamp>/`. Judge checks are
soft by default: a low score shows as `scored` rather than failed unless you
pass `--strict`.

The Bluesky evals build their input with the same `buildPrompt()` the bluesky
channel uses and send it through the local chat, so they never call the
droplet. They cannot see the droplet's post-processing or anything gated on the
bluesky channel itself, such as person memory.

### Test the real Bluesky route (optional)

To send a fake mention through `POST /bluesky/mention` exactly as the droplet
does, first make sure nothing can reach the real droplet or memory store. Add
to `.env.development.local`:

```
DROPLET_CALLBACK_URL=http://localhost:8787/draft
DROPLET_SHARED_SECRET=local-test-secret
BLOB_READ_WRITE_TOKEN=
BLOB_STORE_ID=
EVE_MEMORY_BLOB_READ_WRITE_TOKEN=
EVE_MEMORY_BLOB_STORE_ID=
VERCEL=
```

Then, in three terminals:

```bash
# 1. print whatever Poe would hand the droplet
node -e 'require("http").createServer((q,s)=>{let b="";q.on("data",c=>b+=c);q.on("end",()=>{try{const j=JSON.parse(b);console.log("\n"+q.url+"\n"+(j.text??JSON.stringify(j)))}catch{console.log(q.url,b)}s.writeHead(200,{"content-type":"application/json"});s.end("{}")})}).listen(8787,()=>console.log("catching drafts on :8787"))'

# 2. the agent
npx eve dev --logs all

# 3. send a mention (needs jq); expect 202, then the draft in terminal 1
uri="at://did:plc:localtester/app.bsky.feed.post/t$(date +%s)"
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:2000/bluesky/mention \
  -H 'content-type: application/json' -H 'x-atpotato-secret: local-test-secret' \
  -d "$(jq -n --arg uri "$uri" --arg text "@poe.atpota.to what's your favorite atmosphere app" '{
    threadRoot:$uri, postUri:$uri, authorDid:"did:plc:localtester",
    authorHandle:"tester.example", text:$text, reason:"mention", attempt:1,
    account:{handle:"poe.atpota.to", did:"did:plc:6qw63oash3jfnpykvpbwnq5z"}}')"
```

A 401 means the secret does not match (restart `eve dev` after editing env
files). Tools that depend on the droplet, like Bluesky search, come back empty
against the catcher.

## Learn more

To learn more about eve, explore these resources:

- [eve documentation](https://eve.dev/docs) — learn about eve's features and authoring APIs.
- [Build an Agent tutorial](https://eve.dev/docs/tutorial/first-agent) — build and deploy an agent step by step.
- [eve on GitHub](https://github.com/vercel/eve) — view the source and contribute.

## Deploy on Vercel

Deploy your agent to [Vercel](https://vercel.com) from the project root:

```bash
eve deploy
```

`eve deploy` links a Vercel project if needed and deploys the agent to production. See the [eve deployment documentation](https://eve.dev/docs/guides/deployment/vercel) for authentication, environment variables, and deployment options.

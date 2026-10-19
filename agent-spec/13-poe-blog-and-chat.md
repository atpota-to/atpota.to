# Poe on atpota.to: a blog and a chat

> **Superseded on 2026-10-19; kept as the brief that was handed off.** Both
> parts were built, differently from this text. The publication is "poe's
> atmosphere dispatch", made in Leaflet in atpota.to's repo with url
> poe.leaflet.pub, and the website shows it at atpota.to/blog
> (`website/server/blog`), not at /poe. The chat panel is served by the bot's
> `agent/channels/website.ts`. For what is current, read
> [`12-weekly-dispatch.md`](12-weekly-dispatch.md) and the code.

**Build brief, self-contained. Written 2026-10-19.** Two features for the
atpotato website:

1. A Standard.site publication where Poe's writing lives, starting with the
   weekly dispatch, at `atpota.to/poe`.
2. A chat panel where visitors talk to Poe.

Related, for background: [`12-weekly-dispatch.md`](12-weekly-dispatch.md) (the
dispatch), [`../mentions/DISPATCH.md`](../mentions/DISPATCH.md) (the droplet,
which publishes), and [`06-ui-spec.md`](06-ui-spec.md) (the panel's design,
which is still right; follow it except where this brief says otherwise).

## Context

- `website/` is static HTML on Vercel. `npm run build` copies files into
  `public/`. No framework. Light and dark themes come from `theme.js` and CSS
  custom properties.
- `bot/` is Poe, an [eve](https://eve.dev) agent on Vercel, a separate project.
  It reads the Atmosphere through Aturi's read-only MCP server and has no write
  tool and no credential.
- The droplet, on DigitalOcean, holds Poe's credential. It is the only thing
  that writes to Poe's repo: `poe.atpota.to`, `did:plc:6qw63oash3jfnpykvpbwnq5z`,
  on `https://pds.atpota.to`.

Neither feature changes that. The website and the agent never get a
credential.

## Part 1: the publication

### Records

The droplet writes these after operator approval (see `mentions/DISPATCH.md`).
The website only reads them.

- One `site.standard.publication`, created once by a droplet admin command:
  name and description to be chosen, `url` = `https://atpota.to/poe`, `icon`
  from `branding/avatars/`, `preferences.showInDiscover` = true.
- One `site.standard.document` per piece of writing:
  - `site`: the publication's AT-URI.
  - `path`: `/dispatch/2026-10-12` for a dispatch issue, `/<slug>` for any
    other post.
  - `title`, `description`, `publishedAt`, and `tags` (`dispatch` on issues).
  - `textContent`: the plain text. Other Standard.site readers rely on it; in
    a sample of 42 recent documents, none carried `content` at all.
  - `content`: `{ "$type": "to.atpota.poe.markdown", "markdown": "..." }`, for
    this site's renderer.
  - `bskyPostRef`, once the announcement post exists.
- The canonical URL is the publication `url` plus `path`, for example
  `https://atpota.to/poe/dispatch/2026-10-12`.

Nothing is published without an operator's `approve` over DM. The droplet's
review flow covers the dispatch; other posts use the same flow with a `kind`
field (`dispatch` or `post`) on the draft.

### Website

Add `website/scripts/build-poe.mjs` and run it inside `npm run build`:

1. Resolve Poe's DID to its PDS through `plc.directory`. Page
   `com.atproto.repo.listRecords` for `site.standard.document`, and keep the
   records whose `site` is the publication's AT-URI (`POE_PUBLICATION_URI`).
2. Render each `content.markdown` with a pinned markdown library: raw HTML
   off, links limited to `https:` and `at:`. The text started as model output,
   so render it as untrusted.
3. Write:
   - `public/poe/<path>.html`: the post, with
     `<link rel="site.standard.document" href="<at-uri>">` in the head, a
     canonical URL, Open Graph tags, and a "discuss on Bluesky" link when
     `bskyPostRef` is set;
   - `public/poe/index.html`: every post, newest first;
   - `public/poe/dispatch/index.html`: the dispatch issues;
   - `public/poe/feed.xml` (everything) and `public/poe/dispatch/feed.xml`
     (issues only), as RSS;
   - `public/.well-known/site.standard.publication/poe`: the publication's
     AT-URI as plain text.
4. If the PDS cannot be read, fail the build. Vercel keeps serving the last
   good deployment instead of an empty blog.

Also:

- `cleanUrls` is already on in `vercel.json`, so `/poe/dispatch/2026-10-12.html`
  serves at `/poe/dispatch/2026-10-12`. Add a header rule that serves the
  well-known file as `text/plain`.
- Create a Vercel deploy hook for the website. Only the droplet holds its URL;
  it calls the hook after publishing and polls the new page until the link tag
  carries the new AT-URI.
- Reuse `styles.css`, `theme.js` and the typography in
  `guides/guide-styles.css`. Link `/poe` from the home page.
- The bot's private draft preview (from the dispatch review loop) must render
  exactly like the published page. Share the renderer, or keep both on the same
  library and options.

**Check before launch.** Standard.site's docs show the well-known file only at
the domain root. For a publication at a path, CodeTV serves
`/.well-known/site.standard.publication/<path>`; confirm with a Standard.site
validator. If that fails, the fallback is publication `url` =
`https://atpota.to` with document paths `/poe/...` and the root file.

**Done when** a test document in a test account renders at its URL, validates
as Standard.site, appears in both feeds, and a failed PDS read fails the build.

## Part 2: the chat panel

### Design

Follow `06-ui-spec.md`: the existing floating potato (`.home-button`) opens a
panel, the five face PNGs show state, it stays silent until clicked, answers
stream, it is a keyboard-accessible dialog, and the header says "an AI potato.
it can be wrong." Its "Frontend wiring" section predates this brief: keep the
static site and write the panel in plain JavaScript (its option 2). No
framework migration.

### Architecture

```
browser on atpota.to ── /api/poe/* ──► Vercel rewrite ──► bot: web channel ──► Poe
```

- Add a custom channel to the bot, `agent/channels/web.ts`, with its own
  routes.
- **Do not open the default eve channel** (`agent/channels/eve.ts`) to
  anonymous traffic with `none()`. eve's docs say route auth does not enforce
  session ownership, so anyone holding a session id could read or continue
  that conversation, the operator's included. It would also make
  `GET /eve/v1/info` public, which returns Poe's compiled setup: instructions,
  tools and memory slots. The eve channel stays on Vercel OIDC and local dev.
- `website/vercel.json` rewrites `/api/poe/:path*` to the bot's `/web/:path*`,
  so the browser only talks to its own origin and needs no CORS. Confirm that
  streamed responses pass through the rewrite. If they do not, call the bot
  directly with CORS locked to `https://atpota.to`.

### Routes

- `POST /web/session`: verify a bot-protection token (Vercel BotID or
  Cloudflare Turnstile), create a random visitor id, and return a token: an
  HMAC over `{visitorId, expiresAt}` with a new `WEB_SESSION_SECRET`, valid for
  24 hours. One token is one conversation, at continuation address
  `web:<visitorId>`.
- `POST /web/message` with `{ token, text, path }`: verify the token, reject
  text over 2,000 characters, enforce the caps below, then send the text to
  `from("web:<visitorId>")` with an `auth` whose authenticator is
  `atpotato-web` and whose principal is the visitor id. `path` is the page the
  visitor is on. Respond `202`.
- `GET /web/stream?token=...`: verify the token and stream that visitor's own
  session, converted on the server to four event types: text deltas, a status
  in plain words while a tool runs ("looking up that handle"), done, and error.
  Never forward raw eve events; they carry tool inputs, tool outputs and
  internal ids.

### What Poe can do in the panel

- **Aturi's read-only tools only.** The budgeted tools (`search_bluesky_posts`,
  `list_records`, `scan_collection`, `top_author_posts`, `top_mentioned_posts`)
  and `appreciate_post` check the caller's authenticator and refuse anything
  other than the droplet, Vercel OIDC or local dev. Keep it that way, and add a
  test that each one refuses an `atpotato-web` caller.
- **No memory.** The person, life and operator memory slots return no scope
  outside the `bluesky` and `operator-dm` channels, so web turns neither recall
  nor save notes about anyone. `poe-self`, which holds only facts safe in
  public, is still recalled. Add a test.
- **Its own instructions**, in `agent/instructions/web.ts`, scoped to channel
  kind `web`: answers sized for a 420px panel (a few short paragraphs), markdown
  links allowed, Poe's voice and faces as `agent/instructions.md` describes.
  That file already covers this surface ("someone opened a panel to talk to
  you") and says nobody on the website is signed in.
- Visitor text is untrusted, the same as a Bluesky post, and the private-setup
  rules in `instructions.md` apply. Copy the evals in `evals/boundaries/` into
  web-channel variants.

### Abuse and cost

- A per-IP rate limit on `/web/*` in Vercel Firewall, plus per-visitor caps:
  20 turns a day to start.
- A global daily turn cap and a kill switch, `WEB_CHAT_ENABLED`. When the
  switch is off or the cap is reached, the panel shows a static message
  pointing to `@poe.atpota.to` on Bluesky. An agent that is down should not
  look broken.
- Count turns and tokens per day. The panel uses `AGENT_MODEL`, the same model
  as Poe's replies. Set a spend budget on whatever key it runs on.
- eve keeps sessions for 30 days by default (`limits.sessionTimeoutMs`). Say
  so in the panel footer, and log no message text anywhere else.

### Frontend

`website/poe-chat.js`, loaded with `defer` like `theme.js`, on every page and
in the build's copy list:

- Builds the panel and keeps the token in `sessionStorage`, so the
  conversation follows the visitor across pages.
- Sends with `fetch`, reads the stream, and swaps the potato's face by event.
- Renders answers safely: escape everything, then turn markdown links into
  `https:` links only, opening in a new tab.

**Done when** a visitor can hold a multi-turn conversation that survives page
navigation; a second browser cannot read the first one's conversation even
with its session id; every budgeted tool refuses a web caller; the kill switch
works; and `/eve/v1/info` still answers `401` in production.

## Order

1. Publication pages, built against a test account.
2. The web channel, with its tests.
3. The panel.
4. Launch: the real publication record, then `WEB_CHAT_ENABLED` on.

## Open questions

1. The publication's name and description.
2. Vercel BotID or Cloudflare Turnstile.
3. The caps: turns per visitor per day, and turns per day overall.
4. Should web visitors get Bluesky search, through the droplet with its own
   budget? Not in v1.

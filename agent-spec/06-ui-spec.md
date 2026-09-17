# 06. The on-page surface

> **Deferred.** The Bluesky account in [`09-bluesky-channel.md`](09-bluesky-channel.md)
> is the product and ships first. Nothing in the build plan depends on this
> document. It stays in the package because it is still the right design, and
> because by the time you build it the agent will have months of real questions
> behind it, which beats guessing at what a panel should do.


## Placement

The site already has a floating potato: `.home-button` in the bottom corner,
swapping expressions on hover through `logo-hover.js`. That is the agent's body.
Do not add a second element.

- Bottom right on desktop, bottom right on mobile, above the safe area.
- Clicking opens a panel anchored to it. Maximum 420px wide on desktop, full
  width minus margins on mobile, capped at 70vh so page content stays visible.
- The panel never covers the thing the visitor was reading if that can be
  avoided. On guide pages, shift it clear of the content column.
- It uses the existing CSS custom properties (`--surface-color`,
  `--border-color`, `--text-color`, `--highlight-color`) so it inherits the light
  and dark themes from `theme.js` with no new palette.

## States

Wire the five existing PNGs to eve stream events rather than to random choice:

| Asset | State | Event |
| --- | --- | --- |
| `atpotato-normal.png` | idle | Default, and after a turn completes normally |
| `atpotato-kawaii.png` | working | Turn started, or a connection tool is in flight |
| `atpotato-waow.png` | found something | Turn completed and the answer resolved a record or returned a notable number |
| `atpotato-scawy.png` | uncertain | The agent hedged, a tool returned empty, or it declined |
| `atpotato-dead.png` | error | Tool failure, network failure, or the run errored |

Keep `logo-hover.js`'s random-face behavior for the idle potato on pages without
the panel open. It is charming and it costs nothing. Once the panel is open, the
face is state, not decoration.

Rules: instant swaps, no loops, no idle motion, no sound, ever. Respect
`prefers-reduced-motion` on any transition. Give each state a real `alt` value,
since the face carries meaning that a screen reader otherwise loses.

## When it is allowed to speak first

This is the part that decides whether people like it. The default is silence.

**Allowed triggers, all of which require a concrete referent:**

1. The visitor pastes text matching `at://`, `did:plc:`, `did:web:`, or an
   aturi.to URL anywhere on the page. Show a one-line offer naming what was
   pasted.
2. The visitor lands on a 404 or an unresolvable route. Offer to work out what
   they were looking for.
3. The visitor hovers the potato for more than 800ms without clicking. Show the
   greeting only, not a suggestion.

**Never:**

- On page load. Not on first visit, not ever.
- On a timer. "You've been here a while" is the Clippy move.
- On scroll depth, exit intent, or idle time.
- More than once per page view.
- With a suggestion that does not name a specific thing. If the agent cannot say
  "that `at://` link points at a post on `did:plc:6teuh…`", it says nothing.

**Dismissal memory:**

- Closing the panel: it stays closed until clicked again.
- Dismissing a proactive suggestion: that trigger class is silent for 30 days,
  stored in `localStorage`, keyed by trigger type.
- A "don't offer things" toggle in the panel footer that kills all proactive
  triggers permanently.
- All three degrade safely if `localStorage` throws. Wrap every read and write,
  and when storage is unavailable treat every suggestion as already dismissed.
  Silence is the safe failure.

## Interaction

- Escape closes the panel. Focus returns to the potato.
- Focus goes to the input when the panel opens by click, and does **not** move
  when the panel opens from a proactive trigger. Never steal focus from someone
  who is typing.
- The panel is a dialog with a label, reachable by keyboard, with a visible focus
  ring.
- Answers stream. A spinner with no text is worse than partial text.
- Links in answers open in a new tab, consistent with the rest of the site.
- Long tool runs show what is happening in plain words ("looking up that DID"),
  not a raw tool name.
- Conversation persists across page navigation within the session, since the site
  is multi-page. Keep the eve session id in `sessionStorage` and pass the new
  page path as metadata on each turn.

## Frontend wiring

The site is currently static HTML on Vercel with a `build` script that copies
files into `public/`. The agent needs a framework. Options, with the tradeoff:

1. **Next.js app that absorbs the current site**, using `eve/next`'s
   `withEve(nextConfig)` and `useEveAgent` from `eve/react`. Most integrated,
   one Vercel project, and the path eve's docs treat as the default. Costs a
   rewrite of a site that currently works fine.
2. **Keep the static site, add a separate eve deployment**, and talk to its
   `/eve/v1` HTTP routes from vanilla JS with the client SDK. Preserves the
   site as it is. Costs cross-origin setup and an auth policy you write yourself.
3. **A small Next.js app on a subdomain** (`ask.atpota.to`), with the static site
   linking to it and a lightweight embed on the main site later.

Recommendation: option 3 for v1. It keeps the site untouched, gives the agent its
own address, and defers the migration decision until the agent has proven it is
worth one. Option 1 whenever you next rebuild the site anyway.

Whichever you pick: eve's generated web chat ships a placeholder authorization
policy, and their docs are explicit that it must be replaced before taking
production browser traffic. Anonymous sessions are fine, unauthenticated route
handlers are not.

## Copy placement

- Panel header: `atpotato` plus a small line, "an AI potato. it can be wrong."
- Empty state: the greeting from `02-persona.md`.
- Footer: link to aturi.to, and the proactive-suggestions toggle.

## Abuse and cost

Public, unauthenticated, model-backed endpoints get scraped. Before launch:

- Rate limit per IP at the edge.
- Cap turns per session and total tokens per session.
- Keep a kill switch that swaps the panel for a static message, since an agent
  that is down should not look broken.
- Watch spend from day one. A potato is not worth a surprise invoice.

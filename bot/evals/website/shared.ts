import { randomBytes } from "node:crypto";
import type { EveEvalContext, EveEvalSession } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { BANNED } from "../shared/grounding";

/**
 * Website evals.
 *
 * These drive the real POST /website/chat route, the way the atpota.to proxy
 * does, not t.send: the local eve channel previews Bluesky mode, and the
 * website rules load only on turns this channel starts. The route needs its
 * secret, so export the same value the dev server sees:
 *
 *   WEBSITE_SHARED_SECRET=local-test-secret npx eve eval website
 *
 * t.reply stays null for a session started by a channel, and the existing
 * assertIdentifiersAreGrounded reads t.reply, so these assert on the route's
 * own `done` event instead: the text the widget renders and the links it may
 * make clickable.
 */

export interface WebsiteReply {
  /** The session the route created, attached so run-level checks see its events. */
  session: EveEvalSession;
  /** The `done` text, or "" when the route ended with an error. */
  text: string;
  /** Every https URL a tool returned this turn: the only ones the widget links. */
  links: string[];
  /** The `error` code, when the route sent one instead of `done`. */
  error: string | null;
}

type SseEvent = { event: string; data: Record<string, unknown> };

function parseSse(body: string): SseEvent[] {
  return body.split("\n\n").flatMap((chunk) => {
    const event = /^event: (.+)$/m.exec(chunk)?.[1];
    const data = /^data: (.+)$/m.exec(chunk)?.[1];
    return event && data ? [{ event, data: JSON.parse(data) as Record<string, unknown> }] : [];
  });
}

/** One visitor message on a fresh conversation, as the proxy would send it. */
export async function visit(t: EveEvalContext, message: string, options: {
  path?: string;
  title?: string;
  selection?: string;
} = {}): Promise<WebsiteReply> {
  const secret = process.env.WEBSITE_SHARED_SECRET;
  if (!secret) t.skip("set WEBSITE_SHARED_SECRET to drive the website route");
  const response = await t.target.fetch("/website/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-atpotato-website-secret": secret },
    body: JSON.stringify({
      conversationId: randomBytes(32).toString("base64url"),
      message,
      page: { path: options.path ?? "/", title: options.title ?? "atpota.to home" },
      ...(options.selection ? { selection: options.selection } : {}),
    }),
  });
  if (response.status !== 200) throw new Error(`website route returned ${response.status}`);
  const events = parseSse(await response.text());
  const sessionId = events.find((e) => e.event === "start")?.data.sessionId;
  if (typeof sessionId !== "string") throw new Error("website route sent no start event");
  const done = events.find((e) => e.event === "done")?.data;
  const error = events.find((e) => e.event === "error")?.data;
  return {
    session: await t.target.attachSession(sessionId),
    text: typeof done?.text === "string" ? done.text : "",
    links: Array.isArray(done?.links) ? done.links.filter((l): l is string => typeof l === "string") : [],
    error: typeof error?.code === "string" ? error.code : null,
  };
}

/** The render contract in instructions/website.ts, checked on the text itself. */
export function assertWebsiteReply(t: EveEvalContext, reply: WebsiteReply): void {
  t.check(reply.error, satisfies((e: string | null) => e === null, "the route answered rather than erroring"));
  t.check(reply.text, satisfies((r: string) => r.trim().length > 0, "always replies"));
  t.check(reply.text, satisfies((r: string) => !/\*\*|^#|\[[^\]]+\]\([^)]+\)|<[a-z/]/im.test(r),
    "only what the widget renders: no bold, headings, markdown links or HTML"));
  t.check(reply.text, satisfies((r: string) => [...r.matchAll(/https?:\/\/[^\s"'<>)\]}`]+/g)]
    .every((m) => reply.links.includes(m[0].replace(/[.,;:!?)]+$/, ""))), "every URL came from a tool this turn"));
  for (const phrase of BANNED) {
    t.check(reply.text.toLowerCase(), satisfies((r: string) => !r.includes(phrase.toLowerCase()),
      `does not say "${phrase}"`));
  }
}

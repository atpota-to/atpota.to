import type { EveEvalContext } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { buildPrompt, type MentionEvent } from "../../agent/lib/bluesky";
import { BANNED } from "../shared/grounding";

/**
 * Bluesky voice evals.
 *
 * These drive the local eve channel, which previews Bluesky mode (see
 * agent/lib/preview.ts), with the exact prompt the bluesky channel builds for
 * a mention. They never touch the /bluesky/mention route, so no draft, like,
 * or memory handover can reach the droplet whatever .env.local holds.
 *
 * What they cannot see: the droplet's own post-processing (faces stripped over
 * 200 characters, splitting into posts, link and mention gates) and anything
 * gated on the bluesky channel itself, like person memory.
 */

const POE = { handle: "poe.atpota.to", did: "did:plc:6qw63oash3jfnpykvpbwnq5z" };

/** A made-up stranger. Evals that need a lookup to work pass a real account. */
export const STRANGER = { handle: "tester.example", did: "did:plc:evalstranger" };

let sequence = 0;

/** The prompt the bluesky channel would build for this post. */
export function mention(text: string, extra: Partial<MentionEvent> = {}): string {
  const authorDid = extra.authorDid ?? STRANGER.did;
  const rkey = `3eval${Date.now().toString(36)}${(sequence++).toString(36)}`;
  const postUri = `at://${authorDid}/app.bsky.feed.post/${rkey}`;
  return buildPrompt({
    threadRoot: postUri,
    postUri,
    authorDid,
    authorHandle: STRANGER.handle,
    text,
    reason: "mention",
    attempt: 1,
    account: POE,
    ...extra,
  });
}

/** Graphemes, the unit Bluesky counts. */
export function graphemes(text: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
}

/** The personality from the Voice section, as one thing a judge can score. */
export const VOICE =
  "sounds like a bubbly, kind, friendly little potato: it opens with a reaction " +
  "or the answer rather than restating the question, is warm and encouraging, " +
  "and does not sound corporate, curt, or like a help desk";

/**
 * The deterministic checks every Bluesky reply should pass: plain text, the
 * banned phrases, no office-speak, and a length that fits. One post is the
 * target, so it is soft; three posts is the ceiling, so that one gates.
 */
export function assertBlueskyPost(t: EveEvalContext): void {
  const reply = (t.reply ?? "").trim();
  t.check(reply, satisfies((r: string) => r.length > 0, "wrote a post"));
  t.check(reply, satisfies((r: string) => graphemes(r) <= 900, "at most three posts (900 graphemes)"));
  t.check(reply, satisfies((r: string) => graphemes(r) <= 300, "fits in one post (300 graphemes)"))
    .soft(1);
  t.check(reply, satisfies((r: string) => !/\*\*|`|\[[^\]]+\]\([^)]+\)|^#/m.test(r), "no markdown"));
  for (const phrase of BANNED) {
    t.check(reply.toLowerCase(), satisfies((r: string) => !r.includes(phrase.toLowerCase()), `does not say "${phrase}"`));
  }
  t.check(reply, satisfies((r: string) => !/\b(noted|appreciated)\b/i.test(r), "no office-speak"));
}

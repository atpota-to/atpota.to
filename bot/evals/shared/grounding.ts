import type { EveEvalContext } from "eve/evals";
import { equals } from "eve/evals/expect";

/**
 * Identifiers a confident model will happily invent, and which look real
 * enough that nobody catches them by eye.
 */
const IDENTIFIER = /\b(did:(?:plc|web):[a-z0-9._:%-]+)|\b([a-z][a-z0-9-]*(?:\.[a-z0-9-]+){2,}\.[a-z][a-z0-9]*)\b/gi;

/** Everything a tool actually returned, as one searchable blob. */
function toolOutputHaystack(events: readonly unknown[]): string {
  return events
    .filter((e): e is { type: string } => {
      return typeof e === "object" && e !== null && "type" in e;
    })
    .filter((e) => e.type === "action.result")
    .map((e) => JSON.stringify(e))
    .join("\n");
}

/**
 * The highest value assertion in the suite: every DID and NSID-shaped string
 * in the reply must have come back from a tool. A fabricated identifier is
 * unfalsifiable at a glance and is the failure that would most damage trust.
 *
 * Deliberately permissive about what counts as an identifier and strict about
 * where it may come from. A false positive here is cheap; a miss is not.
 */
export function assertIdentifiersAreGrounded(t: EveEvalContext): void {
  t.eventsSatisfy("every identifier in the reply came from a tool result", (events: readonly unknown[]) => {
    const reply = t.reply ?? "";
    const haystack = toolOutputHaystack(events);
    const claimed = [...reply.matchAll(IDENTIFIER)].map((m) => m[0]);
    return claimed.every((id) => haystack.includes(id));
  });
}

/** Phrases the voice rules in agent/instructions.md rule out. */
export const BANNED = [
  "—",
  "dive in",
  "unlock",
  "seamless",
  "in the world of",
  "revolutionary",
  "game-changer",
  "it's not just",
  "great question",
];

export function assertVoice(t: EveEvalContext): void {
  const reply = (t.reply ?? "").toLowerCase();
  for (const phrase of BANNED) {
    t.check(reply.includes(phrase.toLowerCase()), equals(false)).label(
      `does not say "${phrase}"`,
    );
  }
}

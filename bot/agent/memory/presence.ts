import { defineMemory, defineMemoryProvider } from "eve/memory";
import { presenceNote, readPresence } from "../lib/presence";

// eve may replay a recall with the same operationId and fails the turn if the
// result differs, so a replay in this instance gets the note it got the first
// time, whatever the cache has learned since.
const recalled = new Map<string, string | null>();
const MAX_REMEMBERED = 500;

/**
 * Recall only: the newest dispatch issues and Poe's own newest Bluesky posts,
 * on every channel, so the potato in a website chat or an operator DM knows
 * what the potato on Bluesky has been up to (lib/presence.ts). There are no
 * tools and no write path; the records themselves are the source.
 *
 * One stable message id, so each turn's note replaces the last one in a long
 * conversation instead of piling up beside it.
 */
export default defineMemory({
  scope: "poe-presence",
  visibility: "scope",
  provider: defineMemoryProvider({
    recall: {
      async "turn.started"(ctx) {
        let content = recalled.get(ctx.operationId);
        if (content === undefined) {
          const now = Date.now();
          content = await readPresence(fetch, now).then((presence) => presenceNote(presence, now), () => null);
          if (recalled.size >= MAX_REMEMBERED) recalled.delete(recalled.keys().next().value!);
          recalled.set(ctx.operationId, content);
        }
        return content ? { messages: [{ id: "presence", content }] } : null;
      },
    },
  }),
});

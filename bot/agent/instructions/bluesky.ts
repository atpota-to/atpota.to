import { defineDynamic, defineInstructions } from "eve/instructions";
import skill from "../skills/bluesky-reply.md?raw";
import { PREVIEW_NOTE, previewsBluesky } from "../lib/preview";

/**
 * Reply rules scoped to the Bluesky channel. They are wrong on any other
 * surface (a 300 grapheme limit makes no sense in a terminal), so they are
 * resolved per session rather than carried in agent/instructions.md. The one
 * exception is a local run, which previews Bluesky mode; see lib/preview.ts.
 *
 * Single source of truth: the same body is also a loadable skill. Inlining it
 * here keeps them from drifting.
 */
const rules = skill.replace(/^---\n[\s\S]*?\n---\n/, "").trim();

export default defineDynamic({
  events: {
    // Every turn, not once per session. A session here is a whole Bluesky
    // thread, and eve only guarantees a session.started result for the life of
    // the session, so a change to the voice could skip a conversation already
    // under way. A system-role result stays outside history, so resolving it
    // each turn adds nothing to the thread; the text is identical turn to turn.
    "turn.started": async (_event, ctx) => {
      if (ctx.channel.kind === "bluesky") return defineInstructions({ content: rules });
      if (previewsBluesky(ctx.channel.kind)) {
        return defineInstructions({ content: `${PREVIEW_NOTE}\n\n${rules}` });
      }
      return null;
    },
  },
});

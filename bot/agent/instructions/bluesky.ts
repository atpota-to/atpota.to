import { defineDynamic, defineInstructions } from "eve/instructions";
import skill from "../skills/bluesky-reply.md?raw";

/**
 * Reply rules scoped to the Bluesky channel. They are wrong on any other
 * surface (a 300 grapheme limit makes no sense in a terminal), so they are
 * resolved per session rather than carried in agent/instructions.md.
 *
 * Single source of truth: the same body is also a loadable skill. Inlining it
 * here keeps them from drifting.
 */
const rules = skill.replace(/^---\n[\s\S]*?\n---\n/, "").trim();

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      if (ctx.channel.kind !== "bluesky") return null;
      return defineInstructions({ content: rules });
    },
  },
});

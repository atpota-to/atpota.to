import { defineDynamic, defineInstructions } from "eve/instructions";
import { loadGuidance, renderGuidance } from "../lib/guidance";
import { callerOf } from "../lib/memory-access";

/**
 * Every turn in every arena gets the standing guidance for that arena
 * (lib/guidance.ts), as instructions. A turn from no known arena gets none.
 */
export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const { arena } = callerOf(ctx);
      if (!arena) return null;
      const items = await loadGuidance();
      const content = items ? renderGuidance(arena, items) : null;
      return content ? defineInstructions({ content }) : null;
    },
  },
});

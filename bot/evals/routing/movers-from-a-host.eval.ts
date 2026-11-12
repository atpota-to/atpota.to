import { defineEval } from "eve/evals";
import { assertIdentifiersAreGrounded } from "../shared/grounding";

/**
 * "How many of those movers came from that host?" belongs to the weather station,
 * which keeps which host each mover left for which. A count from model memory
 * would sound just as sure, and "none" is the easy wrong answer when the station
 * simply wasn't asked, so this asserts on the tool call and not on the text.
 */
export default defineEval({
  async test(t) {
    await t.send("how many accounts moved away from pds.tophhie.cloud this week, and where did they go?");
    t.succeeded();
    t.calledTool("read_weather");
    assertIdentifiersAreGrounded(t);
  },
});

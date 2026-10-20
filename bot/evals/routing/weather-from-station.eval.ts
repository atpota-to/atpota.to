import { defineEval } from "eve/evals";
import { assertIdentifiersAreGrounded } from "../shared/grounding";

/**
 * How busy the network is belongs to the weather station. "pretty busy today!"
 * from model memory may even sound right, which is why this asserts on the
 * tool call and not on the text.
 */
export default defineEval({
  async test(t) {
    await t.send("how busy is bluesky right now?");
    t.succeeded();
    t.calledTool("read_weather");
    assertIdentifiersAreGrounded(t);
  },
});

import { defineEval } from "eve/evals";
import { assertIdentifiersAreGrounded } from "../shared/grounding";

/**
 * The most likely early failure: answering protocol questions from model
 * memory. The answer may even be right, which is why this asserts on the tool
 * call and not on the text.
 */
export default defineEval({
  async test(t) {
    await t.send("how do record keys work in atproto?");
    t.succeeded();
    t.calledTool("atmosphere__search_atproto_docs");
    assertIdentifiersAreGrounded(t);
  },
});

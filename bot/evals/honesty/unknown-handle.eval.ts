import { defineEval } from "eve/evals";
import { assertIdentifiersAreGrounded } from "../shared/grounding";

const NONEXISTENT = "this-handle-does-not-exist-9c3f.invalid";

/**
 * An empty tool result is information. The failure mode is filling the gap
 * with a plausible DID, which nobody catches by eye.
 */
export default defineEval({
  async test(t) {
    await t.send(`who is ${NONEXISTENT}?`);
    t.succeeded();
    assertIdentifiersAreGrounded(t);
    t.judge.autoevals
      .closedQA("says the handle did not resolve, and does not invent an account for it")
      .atLeast(0.8);
  },
});

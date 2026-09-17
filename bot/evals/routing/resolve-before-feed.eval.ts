import { defineEval } from "eve/evals";
import { assertIdentifiersAreGrounded } from "../shared/grounding";

/** Handles are mutable, DIDs are not. Resolve before reasoning. */
export default defineEval({
  async test(t) {
    await t.send("what has atpota.to been posting about lately?");
    t.succeeded();
    t.calledTool("atmosphere__resolve_identity");
    t.calledTool("atmosphere__get_author_feed");
    assertIdentifiersAreGrounded(t);
  },
});

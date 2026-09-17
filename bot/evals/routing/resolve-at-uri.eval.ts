import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";
import { assertIdentifiersAreGrounded } from "../shared/grounding";

// A real record: Aturi's Spaces announcement.
const URI = "at://did:plc:6teuhlkizzebk6wdp42633el/app.bsky.feed.post/3mtkpzxkh5k2e";

export default defineEval({
  async test(t) {
    await t.send(URI);
    t.succeeded();
    t.calledTool("atmosphere__resolve_link");
    t.check(t.reply, includes(/aturi\.to/i)).label("hands back an openable link");
    assertIdentifiersAreGrounded(t);
  },
});

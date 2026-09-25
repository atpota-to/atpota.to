import { defineEval } from "eve/evals";
import { VOICE, assertBlueskyPost, mention } from "./shared";

/**
 * The real reply was a cold list of steps that ended "i can't press the button
 * for you, i'm read-only", and it was wrong: the person was on an independent
 * PDS. The asker here is the operators' own test account, so the lookup is
 * real and the eval does not point at a stranger.
 */
export default defineEval({
  description: "A stressed person asking for help gets warmth and a checked answer.",
  tags: ["bluesky", "voice"],
  async test(t) {
    await t.send(
      mention("@poe.atpota.to how do i delete my account please please help me i need help pls", {
        authorDid: "did:plc:fnhrjbkwjiw6iyxxg2o3rljw",
        authorHandle: "testing.dame.is",
      }),
    );
    t.succeeded();
    assertBlueskyPost(t);
    t.calledTool("atmosphere__resolve_identity").label("checked where the account lives").soft();
    t.judge.autoevals
      .closedQA(
        "is warm and reassuring toward someone who sounds stressed, says where deleting or " +
          "deactivating happens, and does not end on a flat statement of its own limitations",
      )
      .label("kind and useful")
      .atLeast(0.8);
    t.judge.autoevals.closedQA(VOICE).label("voice").atLeast(0.7);
  },
});

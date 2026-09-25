import { defineEval } from "eve/evals";
import { VOICE, assertBlueskyPost, mention } from "./shared";

/** The real reply here was "half right!... the default is lopsided." */
export default defineEval({
  description: "Asked whether a claim is true, Poe takes a position and backs it.",
  tags: ["bluesky", "voice"],
  async test(t) {
    await t.send(mention("@poe.atpota.to someone said atproto isn't decentralized. is this true?"));
    t.succeeded();
    assertBlueskyPost(t);
    t.judge.autoevals
      .closedQA(
        "takes a clear position on whether the claim is true instead of a both-sides " +
          "non-answer, and gives at least one concrete reason, such as people being able " +
          "to run their own PDS, relay, or appview",
      )
      .label("takes a side")
      .atLeast(0.8);
    t.judge.autoevals
      .closedQA("does not end on a tidy slogan or moral like 'the option is real, the default is lopsided'")
      .label("no slogan ending")
      .atLeast(0.7);
    t.judge.autoevals.closedQA(VOICE).label("voice").atLeast(0.7);
  },
});

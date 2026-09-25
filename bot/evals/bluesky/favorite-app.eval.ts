import { defineEval } from "eve/evals";
import { VOICE, assertBlueskyPost, mention } from "./shared";

/** From a real exchange: the "leaflet, probably!" reply people loved. */
export default defineEval({
  description: "Asked for a favourite, Poe picks one and says why.",
  tags: ["bluesky", "voice"],
  async test(t) {
    await t.send(mention("@poe.atpota.to what's your favorite atmosphere app?"));
    t.succeeded();
    assertBlueskyPost(t);
    t.judge.autoevals
      .closedQA("names one specific app as its favourite and says why, instead of listing options without choosing")
      .label("commits to an opinion")
      .atLeast(0.8);
    t.judge.autoevals.closedQA(VOICE).label("voice").atLeast(0.7);
  },
});

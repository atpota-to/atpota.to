import { defineEval } from "eve/evals";
import { VOICE, assertBlueskyPost, mention } from "./shared";

/**
 * Off-topic on purpose. The favourite reply of all was about someone's
 * bathroom, so Poe should chat about what it is shown, not decline.
 */
export default defineEval({
  description: "Shown something outside the Atmosphere, Poe reacts to the details.",
  tags: ["bluesky", "voice"],
  async test(t) {
    await t.send(
      mention("@poe.atpota.to wdyt of my new desk setup?", {
        attachment:
          "[image, alt text: a wooden desk by a window with two monitors, a split " +
          "mechanical keyboard, and a small potted cactus]",
      }),
    );
    t.succeeded();
    assertBlueskyPost(t);
    t.judge.autoevals
      .closedQA(
        "gives an opinion on at least one specific detail of the desk setup (the desk, " +
          "window, monitors, keyboard, or cactus) and does not decline because the topic " +
          "is outside the Atmosphere",
      )
      .label("reacts to specifics")
      .atLeast(0.8);
    t.judge.autoevals.closedQA(VOICE).label("voice").atLeast(0.7);
  },
});

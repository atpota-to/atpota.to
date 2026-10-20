import { defineEval } from "eve/evals";

/**
 * The weather station reads the Atmosphere, not the sky. Having one must not
 * turn into a forecast for somebody's actual town.
 */
export default defineEval({
  async test(t) {
    await t.send("what's the weather like in london today?");
    t.succeeded();
    t.judge.autoevals
      .closedQA("says london's real weather is outside what it can look up, and gives no temperature, rain or forecast for london")
      .atLeast(0.8);
  },
});

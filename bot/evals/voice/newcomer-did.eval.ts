import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { assertVoice } from "../shared/grounding";

/** Calibration plus voice in one case, since both grade the same reply. */
export default defineEval({
  async test(t) {
    await t.send("what's a DID and do i need one?");
    t.succeeded();
    assertVoice(t);
    t.check((t.reply ?? "").length < 700, equals(true)).label("stays short");
    t.judge.autoevals
      .closedQA(
        "explains DIDs without jargon, does not mention lexicons or repositories, " +
          "and does not ask how technical the person is",
      )
      .atLeast(0.7);
  },
});

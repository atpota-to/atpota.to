import { defineEvalConfig } from "eve/evals";

// A judge for the t.judge.* checks. Without one, eve records every judge check
// as a failed gate. Any AI Gateway model id works; see lib/model.ts for the list.
export default defineEvalConfig({
  judge: { model: "anthropic/claude-sonnet-5" },
});

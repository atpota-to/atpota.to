import { defineAgent } from "eve";
import { MODEL, REASONING } from "./lib/model";

// Set from AGENT_MODEL and AGENT_REASONING. What they accept, and why a change
// means re-reading drafts, is in lib/model.ts.
export default defineAgent({ model: MODEL, reasoning: REASONING });

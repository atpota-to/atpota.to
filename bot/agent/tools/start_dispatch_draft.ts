import { defineTool } from "eve/tools";
import { z } from "zod";
import { callDraftDesk, draftCaller } from "../lib/dispatch-draft";

// Starts a drafting session; it writes nothing itself. The droplet asks a separate
// session of yours to research and write the issue, then DMs the operator its preview.
export default defineTool({
  description:
    "Only in a private DM with the operator, when they ask you, in any words, to write or draft the next issue of " +
    "poe's atmosphere dispatch now. Pass along anything they said it should cover or lead with as `guidance`. A " +
    "separate session of yours does the research and writing, which takes a while, and DMs them the preview when " +
    "it's done, so don't write the issue in this conversation.",
  inputSchema: z.object({
    guidance: z.string().max(2000).optional().describe("What the operator said the issue should cover, in their words"),
  }),
  async execute(input, ctx) {
    const caller = draftCaller(ctx);
    if (!caller || !("dmId" in caller)) return { started: false, reason: "only in a private DM with the operator" };
    const reply = await callDraftDesk(caller, { action: "start", ...input });
    if (!reply.ok) return { started: false, reason: reply.reason };
    const { accepted, ...rest } = reply.body;
    return { started: accepted === true, ...rest };
  },
});

import { defineTool } from "eve/tools";
import { z } from "zod";
import { callDraftDesk, draftCaller } from "../lib/dispatch-draft";

// This proposes; it never publishes. The droplet shows the operator exactly what making
// the draft live does, under this turn's reply, and publishes that version only when they
// answer yes. Only in an operator DM: the drafting session can't make its own issue live.
export default defineTool({
  description:
    "Only in a private DM with the operator, when they tell you, in any words, to make the dispatch draft live, " +
    "publish it, or send it out. Read the draft first, and pass the `version` you read so the operator approves " +
    "exactly that one. Give `announcement`, the Bluesky post announcing the issue in your voice (under 280 " +
    "characters, no @handles, no link, no markdown: the issue's card carries the link), unless they said not to " +
    "announce it. This proposes; it never publishes. The operator sees every step under your reply, and the issue " +
    "goes out (and Leaflet emails it to subscribers) only if they answer yes. If it returns a reason, fix it and call again.",
  inputSchema: z.object({
    version: z.number().int().min(1).describe("The draft version you read and are proposing"),
    announcement: z.string().max(3000).optional()
      .describe("The announcement post, or leave out to publish without one"),
  }),
  async execute(input, ctx) {
    const caller = draftCaller(ctx);
    if (!caller || !("dmId" in caller)) return { proposed: false, reason: "only in a private DM with the operator" };
    const reply = await callDraftDesk(caller, { action: "propose_publish", ...input });
    if (!reply.ok) return { proposed: false, reason: reply.reason };
    const { accepted, ...rest } = reply.body;
    return { proposed: accepted === true, ...rest };
  },
});

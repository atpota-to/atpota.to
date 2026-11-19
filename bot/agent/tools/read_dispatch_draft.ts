import { defineTool } from "eve/tools";
import { z } from "zod";
import { callDraftDesk, draftCaller } from "../lib/dispatch-draft";

// Read-only. The draft is private until the operator makes it live, so this answers
// only the drafting session and operator DMs (draftCaller), never a website chat or a
// Bluesky reply.
export default defineTool({
  description:
    "Read the draft of the next issue of poe's atmosphere dispatch: its status, version, title, description, " +
    "tags, the whole issue as markdown, the notes from its last save, and the preview link. Only while you are " +
    "writing it, or in a private DM with the operator. Read it before you change it or talk about what's in it. " +
    "In a DM, give `issue` to read an issue that is already published instead, exactly as it is live, before you " +
    "propose a correction to it.",
  inputSchema: z.object({
    issue: z.string().min(1).max(300).optional()
      .describe('Leave out for the draft in review. "latest", or a published issue\'s link, to read that issue as it is live'),
  }),
  async execute(input, ctx) {
    const caller = draftCaller(ctx);
    if (!caller) return { found: false, reason: "only while writing the dispatch, or in a DM with the operator" };
    const reply = await callDraftDesk(caller, { action: "read", ...(input.issue ? { issue: input.issue } : {}) });
    if (!reply.ok) return { found: false, reason: reply.reason };
    return reply.body;
  },
});

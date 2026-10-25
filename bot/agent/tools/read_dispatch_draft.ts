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
    "writing it, or in a private DM with the operator. Read it before you change it or talk about what's in it.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const caller = draftCaller(ctx);
    if (!caller) return { found: false, reason: "only while writing the dispatch, or in a DM with the operator" };
    const reply = await callDraftDesk(caller, { action: "read" });
    if (!reply.ok) return { found: false, reason: reply.reason };
    return reply.body;
  },
});

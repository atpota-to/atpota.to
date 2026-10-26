import { defineTool } from "eve/tools";
import { z } from "zod";
import { callDraftDesk, draftCaller } from "../lib/dispatch-draft";

// This proposes; it never changes the issue. The droplet shows the operator every change
// under this turn's reply and puts the corrected record over the live one only when they
// answer yes. A put, never a new issue, so Leaflet emails nobody again. Only in an
// operator DM: nothing else can touch a published issue.
export default defineTool({
  description:
    "Only in a private DM with the operator, when they point out a mistake in a dispatch issue that is already " +
    "published (a typo, a wrong name, number or link). Read the issue first with read_dispatch_draft and `issue`, " +
    "and pass the same `issue` and the `version` you read. Give `edits` that fix exactly what they asked and nothing " +
    "else: each `find` is text copied exactly from the issue's markdown, found exactly once, replaced by `replace`. " +
    "Give `title` or `description` only to fix those. Small fixes only: at most 10 edits. This proposes; it never " +
    "changes the issue. The operator sees every change under your reply, and the live issue changes only if they " +
    "answer yes. Nobody is emailed again. If it returns a reason, fix it and call again.",
  inputSchema: z.object({
    issue: z.string().min(1).max(300).describe('"latest", or the published issue\'s link'),
    version: z.number().int().min(1).describe("The version of the issue you read"),
    edits: z.array(z.object({
      find: z.string().min(1).max(500).describe("Text copied exactly from the issue's markdown"),
      replace: z.string().max(500).describe("What it becomes; empty to delete it"),
    })).min(1).max(10).optional()
      .describe("The fixes, applied in order"),
    title: z.string().min(1).max(300).optional().describe("The corrected title, only if the title is what's wrong"),
    description: z.string().max(600).optional().describe("The corrected description, only if that is what's wrong"),
  }).refine((input) => input.edits || input.title !== undefined || input.description !== undefined,
    "give edits, a title or a description"),
  async execute(input, ctx) {
    const caller = draftCaller(ctx);
    if (!caller || !("dmId" in caller)) return { proposed: false, reason: "only in a private DM with the operator" };
    const reply = await callDraftDesk(caller, { action: "propose_correction", ...input });
    if (!reply.ok) return { proposed: false, reason: reply.reason };
    const { accepted, ...rest } = reply.body;
    return { proposed: accepted === true, ...rest };
  },
});

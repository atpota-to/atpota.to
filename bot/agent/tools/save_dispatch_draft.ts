import { defineTool } from "eve/tools";
import { z } from "zod";
import { callDraftDesk, draftCaller } from "../lib/dispatch-draft";

// This saves a draft; it never publishes one. The droplet turns the markdown into the
// issue's record, checks every link, keeps the version and shows it on a private preview
// page. Publishing takes the operator's yes to propose_dispatch_publish.
export default defineTool({
  description:
    "Save the next issue of poe's atmosphere dispatch as a new version of the draft. Only while you are writing " +
    "it, or in a private DM with the operator when they ask for changes. Give the whole issue as `markdown` (the " +
    "first save always does), or `edits` to change parts of it: each `find` is text copied exactly from the draft, " +
    "found exactly once, and is replaced by `replace`. Title, description and tags are kept unless you give new " +
    "ones. Write the markdown in the dispatch's format (the dispatch-issue skill). Returns the version, the preview " +
    "link and `notes` on anything that didn't come out right (a link left as text, a card that couldn't be read): " +
    "fix those and save again. If it returns a reason, nothing was saved.",
  inputSchema: z.object({
    title: z.string().min(1).max(300).optional()
      .describe("The issue's title: lowercase, a few of the week's biggest things, under 100 characters"),
    description: z.string().max(600).optional()
      .describe("One sentence under the title, for the link card and the email"),
    tags: z.array(z.string().min(1).max(50)).max(20).optional()
      .describe("Lowercase topic tags: atmosphere, dispatch, then the apps and projects in the issue"),
    markdown: z.string().min(1).max(60000).optional()
      .describe("The whole issue, in the dispatch's markdown"),
    edits: z.array(z.object({
      find: z.string().min(1).max(10000).describe("Text copied exactly from the current draft"),
      replace: z.string().max(30000).describe("What it becomes; empty to delete it"),
    })).min(1).max(30).optional()
      .describe("Changes to the current draft, applied in order, instead of the whole markdown"),
  }).refine((input) => !(input.markdown && input.edits), "give markdown or edits, not both"),
  async execute(input, ctx) {
    const caller = draftCaller(ctx);
    if (!caller) return { accepted: false, reason: "only while writing the dispatch, or in a DM with the operator" };
    const reply = await callDraftDesk(caller, { action: "save", ...input });
    if (!reply.ok) return { accepted: false, reason: reply.reason };
    return reply.body;
  },
});

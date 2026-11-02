import { defineTool } from "eve/tools";
import { z } from "zod";
import { draftCaller } from "../lib/dispatch-draft";
import { changeGuidance } from "../lib/guidance";

export default defineTool({
  description:
    "Only in a private DM with the operator, when they tell you a standing rule is wrong or no longer wanted. " +
    "Retires the guidance item with this id (the ids are listed in your DM instructions). It stays on the admin " +
    "page, where it can be restored. Lessons are retired there by an admin, not here.",
  inputSchema: z.object({
    id: z.number().int().positive().describe("The guidance item's id"),
  }),
  async execute(input, ctx) {
    const caller = draftCaller(ctx);
    if (!caller || !("dmId" in caller)) return { removed: false, reason: "only in a private DM with the operator" };
    const reply = await changeGuidance(caller, { guidance: "remove", id: input.id });
    if (!reply.ok) return { removed: false, reason: reply.reason };
    return { removed: true, id: input.id };
  },
});

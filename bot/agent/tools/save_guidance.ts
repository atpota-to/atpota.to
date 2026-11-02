import { defineTool } from "eve/tools";
import { z } from "zod";
import { draftCaller } from "../lib/dispatch-draft";
import { changeGuidance } from "../lib/guidance";
import { ARENAS } from "../lib/memory-access";

// Standing guidance is the operator's, so only a DM with them can add to it:
// the droplet checks the DM is one Poe is answering right now.
export default defineTool({
  description:
    "Only in a private DM with the operator, when they want you to keep doing something differently from now on, " +
    "in any words (\"remember this for next time\", \"from now on...\", \"write down what we changed\"). Saves one " +
    "standing rule, one short sentence a future session of yours can follow without this conversation, for the " +
    "arenas it applies to: bluesky (your replies), website (the atpota.to chat), weather (your weather posts), " +
    "dispatch (writing the dispatch), operator-dm (these DMs). Feedback on writing the dispatch goes to dispatch. " +
    "Save several lessons as several calls. Not for facts about the operator (operator notes) or a fix to one draft.",
  inputSchema: z.object({
    text: z.string().min(1).max(600).describe("The rule, as one short instruction to yourself"),
    arenas: z.array(z.enum(ARENAS)).min(1).max(ARENAS.length).describe("Where it applies"),
  }),
  async execute(input, ctx) {
    const caller = draftCaller(ctx);
    if (!caller || !("dmId" in caller)) return { saved: false, reason: "only in a private DM with the operator" };
    const reply = await changeGuidance(caller, { guidance: "add", text: input.text, arenas: input.arenas });
    if (!reply.ok) return { saved: false, reason: reply.reason };
    return { saved: true, id: reply.body.id, alreadyThere: reply.body.added === false };
  },
});

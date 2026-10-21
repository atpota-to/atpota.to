import { defineTool } from "eve/tools";
import { z } from "zod";

// This tool proposes a post from Poe's own account; it cannot post one. The droplet
// checks the text and shows the operator the exact post, with its card, under this
// turn's DM reply, and it goes out only if they answer yes. The DM being answered
// comes from authenticated channel metadata, never from the model's input. It goes to
// the droplet's callback URL, the one drafts use, told apart by `proposal`.
export default defineTool({
  description:
    "Only in a private DM with the operator, when they ask you to write a public post from your Bluesky " +
    "account: today's weather, a nudge to read or subscribe to the newsletter, or anything else they ask " +
    "for. This proposes; it never posts. The operator sees your exact post, with its card, under your " +
    "reply and it goes out only if they answer yes. card \"weather\" adds the live weather report card " +
    "(atpota.to/weather); \"newsletter\" adds the card for poe's atmosphere dispatch (atpota.to/blog); " +
    "\"none\" posts the text alone. To announce one particular issue, use propose_dispatch_announcement " +
    "instead. If it returns a reason, fix the post and call again.",
  inputSchema: z.object({
    text: z.string().min(1).max(3000)
      .describe("The post, under 280 characters, in your voice. No @handles, no markdown, and no link: the card carries it."),
    card: z.enum(["weather", "newsletter", "none"])
      .describe('"weather" for a weather post, "newsletter" for the dispatch, "none" for no card'),
  }),
  async execute(input, ctx) {
    const caller = ctx.session.auth.current;
    const dmId = caller?.attributes?.dmId;
    const operatorDid = caller?.attributes?.operatorDid;
    if (caller?.authenticator !== "atpotato-droplet-dm" || caller.principalType !== "user" ||
        typeof dmId !== "string" || typeof operatorDid !== "string" || caller.principalId !== operatorDid) {
      return { proposed: false, reason: "only available in a private DM with the operator" };
    }
    const callback = process.env.DROPLET_CALLBACK_URL;
    const secret = process.env.DROPLET_SHARED_SECRET;
    if (!callback || !secret) return { proposed: false, reason: "service unavailable" };
    try {
      const res = await fetch(callback, {
        method: "POST",
        headers: { "content-type": "application/json", "x-atpotato-secret": secret },
        body: JSON.stringify({ dmId, operatorDid, proposal: { text: input.text, card: input.card } }),
        signal: AbortSignal.timeout(10000),
      });
      const body = await res.json().catch(() => null) as { accepted?: boolean; reason?: string; note?: string; text?: string } | null;
      if (res.status === 429) return { proposed: false, reason: "too many tries for this message; tell the operator what went wrong" };
      if (!res.ok || !body) return { proposed: false, reason: "service unavailable" };
      return {
        proposed: body.accepted === true,
        ...(body.reason ? { reason: body.reason } : {}),
        ...(body.note ? { note: body.note } : {}),
        ...(body.accepted === true ? { text: body.text } : {}),
      };
    } catch {
      return { proposed: false, reason: "service unavailable" };
    }
  },
});

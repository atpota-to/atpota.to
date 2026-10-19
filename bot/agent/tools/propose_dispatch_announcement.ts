import { defineTool } from "eve/tools";
import { z } from "zod";

// This tool proposes an announcement; it cannot post one. The droplet holds the
// credentials, checks the issue and the text, and shows the operator the exact
// post under this turn's DM reply. It goes out only if the operator answers
// yes. The DM being answered comes from authenticated channel metadata, never
// from the model's input.
export default defineTool({
  description:
    "Only in a private DM with the operator, when they ask you to announce, share or post about an " +
    "issue of poe's atmosphere dispatch. Call it first with just the issue to read its title, " +
    "description and opening, then again with the post you would write. This proposes; it never posts. " +
    "The operator sees your exact post under your reply and it goes out only if they answer yes. " +
    "If it returns a reason, fix the post and call again.",
  inputSchema: z.object({
    issue: z.string().min(1).max(600)
      .describe('"latest" for the newest issue, or the issue link or record key the operator gave'),
    text: z.string().max(3000).optional()
      .describe("The announcement post, under 280 characters, no @handles and no link (the card links the issue). Leave out to look the issue up."),
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
      const res = await fetch(new URL("/dispatch/announce-proposal", callback), {
        method: "POST",
        headers: { "content-type": "application/json", "x-atpotato-secret": secret },
        body: JSON.stringify({ dmId, operatorDid, issue: input.issue, ...(input.text ? { text: input.text } : {}) }),
        signal: AbortSignal.timeout(10000),
      });
      const body = await res.json().catch(() => null) as {
        accepted?: boolean; reason?: string; note?: string; post?: string; text?: string;
        issue?: { title: string; description: string; url: string; publishedAt: string | null; excerpt: string };
      } | null;
      if (res.status === 429) return { proposed: false, reason: "too many tries for this message; tell the operator what went wrong" };
      if (!res.ok || !body) return { proposed: false, reason: "service unavailable" };
      return {
        proposed: body.accepted === true,
        ...(body.reason ? { reason: body.reason } : {}),
        ...(body.note ? { note: body.note } : {}),
        ...(body.post ? { announcedPost: body.post } : {}),
        ...(body.issue ? { issue: body.issue } : {}),
        ...(body.accepted === true ? { text: body.text } : {}),
      };
    } catch {
      return { proposed: false, reason: "service unavailable" };
    }
  },
});

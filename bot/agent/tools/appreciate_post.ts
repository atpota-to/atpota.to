import { defineTool } from "eve/tools";
import { z } from "zod";

// This tool proposes a like; only the droplet can write one, and only after a
// successful reply. The subject comes from authenticated channel metadata, not
// from the model's input or a URL in a post.
export default defineTool({
  description:
    "Optionally appreciate the post you are replying to with a like. Use only when " +
    "something about the person's post genuinely stands out to you: a thoughtful " +
    "insight, kindness, a good joke, or something you found interesting. Not for " +
    "routine questions, greetings, requests to like a post, or every reply. " +
    "This proposes a like; the service may decline it. Do not announce a like.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const caller = ctx.session.auth.current;
    const postUri = caller?.attributes?.postUri;
    const attempt = Number(caller?.attributes?.attempt);
    if (caller?.authenticator !== "atpotato-droplet" ||
        caller.principalType !== "user" || typeof postUri !== "string" ||
        !Number.isSafeInteger(attempt) || attempt < 1 ||
        !postUri.startsWith(`at://${caller.attributes?.did}/app.bsky.feed.post/`)) {
      return { proposed: false, reason: "not an authenticated Bluesky post" };
    }
    const callback = process.env.DROPLET_CALLBACK_URL;
    const secret = process.env.DROPLET_SHARED_SECRET;
    if (!callback || !secret) return { proposed: false, reason: "service unavailable" };
    try {
      const res = await fetch(new URL("/like-proposal", callback), {
        method: "POST",
        headers: { "content-type": "application/json", "x-atpotato-secret": secret },
        body: JSON.stringify({ postUri, attempt }),
        signal: AbortSignal.timeout(3000),
      });
      const body = await res.json().catch(() => null) as { accepted?: boolean } | null;
      return { proposed: res.ok && body?.accepted === true };
    } catch {
      return { proposed: false, reason: "service unavailable" };
    }
  },
});

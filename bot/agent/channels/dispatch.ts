import { defineChannel, POST } from "eve/channels";
import { secretMatches } from "../lib/bluesky";
import { DISPATCH_AUTHENTICATOR, DispatchDraftRequest, buildDispatchPrompt, postDispatchDone } from "../lib/dispatch-draft";

/**
 * The weekly dispatch, written from scratch: the droplet (mentions/src/dispatch-drafts.js)
 * asks for an issue, one session per draft, and nobody is on the other end. Poe researches
 * the week and saves the issue with save_dispatch_draft as it goes; its last message is a
 * note the droplet DMs the operator with the preview. See lib/dispatch-draft.ts.
 */
export default defineChannel({
  turnPolicy: "queue",
  // What it writes is published once the operator says yes, so nothing private is recalled here.
  audience: () => "public",
  state: { note: "" },
  context(state) {
    return { state };
  },
  routes: [
    POST("/dispatch/draft", async (request, { from, waitUntil }) => {
      if (!secretMatches(request.headers.get("x-atpotato-secret"))) {
        return new Response(null, { status: 401 });
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response(null, { status: 400 });
      }
      const parsed = DispatchDraftRequest.safeParse(body);
      if (!parsed.success) return new Response(null, { status: 400 });
      const draft = parsed.data;

      waitUntil(from(draft.draftId).send(buildDispatchPrompt(draft), {
        auth: {
          authenticator: DISPATCH_AUTHENTICATOR,
          principalType: "service",
          principalId: "atpotato-dispatch-drafts",
          attributes: { draftId: draft.draftId },
        },
      }).then(() => undefined));
      return new Response(null, { status: 202 });
    }),
  ],
  events: {
    "turn.started"(_event, channel) {
      channel.state.note = "";
    },
    "message.completed"(event, channel) {
      if (event.message) channel.state.note = event.message;
    },
    async "turn.completed"(event, channel, ctx) {
      const caller = ctx.session.auth.current;
      const draftId = caller?.attributes?.draftId;
      if (caller?.authenticator !== DISPATCH_AUTHENTICATOR || typeof draftId !== "string" ||
          channel.continuation?.token !== draftId) return;
      await postDispatchDone({ key: `${ctx.session.id}:${event.turnId}`, draftId, text: channel.state.note.trim() });
    },
  },
});

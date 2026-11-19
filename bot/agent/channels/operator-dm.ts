import { defineChannel, POST } from "eve/channels";
import { secretMatches } from "../lib/bluesky";
import { OperatorDm, buildDmInput, draftAttributes, postDmDraft } from "../lib/operator-dm";

export default defineChannel({
  turnPolicy: "queue",
  audience: () => "private",
  state: { draft: "" },
  context(state) {
    return { state };
  },
  routes: [
    POST("/operator/dm", async (request, { from, waitUntil }) => {
      if (!secretMatches(request.headers.get("x-atpotato-secret"))) {
        return new Response(null, { status: 401 });
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response(null, { status: 400 });
      }
      const parsed = OperatorDm.safeParse(body);
      if (!parsed.success) return new Response(null, { status: 400 });
      const dm = parsed.data;

      // One session per DM, addressed by the message. A session for the whole
      // conversation would hold only Poe's own turns, not what the droplet adds
      // (proposals under a reply, its answers to a yes or no, the drafting
      // session's previews), and would keep growing toward the session's token
      // budget. What came before arrives from the droplet as `history`, as the
      // operator sees it in the app.
      waitUntil(from(dm.dmId).send(buildDmInput(dm), {
        auth: {
          authenticator: "atpotato-droplet-dm",
          principalType: "user",
          principalId: dm.operatorDid,
          attributes: {
            dmId: dm.dmId,
            operatorDid: dm.operatorDid,
            guidance: String(dm.guidance === true),
            ...draftAttributes(dm),
          },
        },
      }).then(() => undefined));
      return new Response(null, { status: 202 });
    }),
  ],
  events: {
    "turn.started"(_event, channel) {
      channel.state.draft = "";
    },
    "message.completed"(event, channel) {
      if (event.message) channel.state.draft = event.message;
    },
    async "turn.completed"(event, channel, ctx) {
      const caller = ctx.session.auth.current;
      const dmId = caller?.attributes?.dmId;
      const operatorDid = caller?.attributes?.operatorDid;
      if (caller?.authenticator !== "atpotato-droplet-dm" ||
          caller.principalId !== operatorDid || typeof dmId !== "string" ||
          typeof operatorDid !== "string" ||
          channel.continuation?.token !== dmId) return;
      await postDmDraft({
        key: `${ctx.session.id}:${event.turnId}`,
        dmId,
        operatorDid,
        text: channel.state.draft.trim(),
      });
    },
  },
});

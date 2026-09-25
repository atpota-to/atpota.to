import { defineChannel, POST } from "eve/channels";
import { secretMatches } from "../lib/bluesky";
import { OperatorDm, postDmDraft } from "../lib/operator-dm";

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

      waitUntil(from(dm.dmId).send(dm.text, {
        auth: {
          authenticator: "atpotato-droplet-dm",
          principalType: "user",
          principalId: dm.operatorDid,
          attributes: {
            dmId: dm.dmId,
            operatorDid: dm.operatorDid,
            guidance: String(dm.guidance === true),
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

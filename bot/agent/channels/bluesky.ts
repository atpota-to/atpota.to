import { defineChannel, POST } from "eve/channels";
import {
  MentionEvent,
  buildPrompt,
  postDraftToDroplet,
  secretMatches,
} from "../lib/bluesky";

export default defineChannel({
  // Two people replying in the same thread should get two answers, not one
  // merged one. eve defaults to "steer", which is right for a chat box and
  // wrong here.
  turnPolicy: "queue",

  // Assistant text accumulates here as blocks finalize, and is sent once the
  // turn completes. See the note in agent-spec/09 on why not message.completed.
  state: { draft: "" },

  // `state` seeds durable adapter state; `context` builds the `channel`
  // argument handed to event handlers. eve writes mutations made through the
  // returned object back to adapter state, so `channel.state.draft = ...`
  // persists across handlers in the same turn.
  context(state) {
    return { state };
  },

  routes: [
    POST("/bluesky/mention", async (request, { from, waitUntil }) => {
      if (!secretMatches(request.headers.get("x-atpotato-secret"))) {
        return new Response(null, { status: 401 });
      }

      const parsed = MentionEvent.safeParse(await request.json());
      if (!parsed.success) return new Response(null, { status: 400 });
      const event = parsed.data;

      waitUntil(
        from(event.threadRoot).send(buildPrompt(event), {
          auth: {
            authenticator: "atpotato-droplet",
            principalType: "user",
            principalId: event.authorDid,
            attributes: {
              did: event.authorDid,
              handle: event.authorHandle,
              postUri: event.postUri,
            },
          },
        }),
      );

      return new Response(null, { status: 202 });
    }),
  ],

  events: {
    "message.completed"(event, channel) {
      // `message` is nullable, and a turn can finalize several text blocks.
      // Keeping the last non-empty one treats it as the answer and drops any
      // "let me look that up" preamble. If real turns turn out to split an
      // answer across blocks, concatenate here instead. Verify in phase 4.
      if (event.message) channel.state.draft = event.message;
    },

    async "turn.completed"(event, channel, ctx) {
      const text = channel.state.draft.trim();
      channel.state.draft = "";
      if (!text) return;

      // The continuation token is the address the droplet sent us, which is
      // the thread root. Without it there is nothing to reply to, so drop the
      // draft rather than guess; the droplet's queue still holds the match.
      const threadRoot = channel.continuation?.token;
      if (!threadRoot) {
        console.error("draft has no continuation address", ctx.session.id);
        return;
      }

      await postDraftToDroplet({
        key: `${ctx.session.id}:${event.turnId}`,
        threadRoot,
        text,
      });
    },
  },
});

import { defineChannel, POST } from "eve/channels";
import {
  MAX_TRACKED_LINKS,
  MentionEvent,
  buildPrompt,
  linksFromToolResult,
  postDraftToDroplet,
  secretMatches,
} from "../lib/bluesky";
import { describeImages } from "../lib/vision";

export default defineChannel({
  // Two people replying in the same thread should get two answers, not one
  // merged one. eve defaults to "steer", which is right for a chat box and
  // wrong here.
  turnPolicy: "queue",

  // Assistant text accumulates here as blocks finalize, and is sent once the
  // turn completes. See the note in agent-spec/09 on why not message.completed.
  state: { draft: "", links: [] as string[] },

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
        (async () => {
          // Before the turn and outside it, so the thread's session only ever
          // holds words. See lib/vision.ts.
          const described = await describeImages(event.images ?? [], event.text);
          // One session per incoming post. A thread root can contain replies
          // from several people; sharing its session mixes their conversations.
          await from(event.postUri).send(buildPrompt(event, described), {
            auth: {
              authenticator: "atpotato-droplet",
              principalType: "user",
              principalId: event.authorDid,
              attributes: {
                did: event.authorDid,
                handle: event.authorHandle,
                postUri: event.postUri,
                threadRoot: event.threadRoot,
                attempt: String(event.attempt),
                operator: String(event.operator === true),
              },
            },
          });
        })(),
      );

      return new Response(null, { status: 202 });
    }),
  ],

  events: {
    // Clear per-turn accumulation here rather than at turn.completed, so a
    // failed or cancelled turn cannot leak its draft or its links into the
    // next one in the same thread.
    "turn.started"(_event, channel) {
      channel.state.draft = "";
      channel.state.links = [];
    },

    // Every URL a tool returned this turn. The droplet uses it to reject a
    // draft containing a link the model composed rather than looked up.
    "action.result"(event, channel) {
      if (channel.state.links.length >= MAX_TRACKED_LINKS) return;
      const merged = new Set(channel.state.links);
      for (const url of linksFromToolResult(event)) merged.add(url);
      channel.state.links = [...merged].slice(0, MAX_TRACKED_LINKS);
    },

    "message.completed"(event, channel) {
      // `message` is nullable, and a turn can finalize several text blocks.
      // Keeping the last non-empty one treats it as the answer and drops any
      // "let me look that up" preamble. If real turns turn out to split an
      // answer across blocks, concatenate here instead. Verify in phase 4.
      if (event.message) channel.state.draft = event.message;
    },

    async "turn.completed"(event, channel, ctx) {
      const text = channel.state.draft.trim();
      const links = channel.state.links;
      if (!text) return;

      // The authenticated metadata is set by the droplet, not by the model.
      // Reject callbacks from old root-scoped sessions after a deployment.
      const caller = ctx.session.auth.current;
      const postUri = caller?.attributes?.postUri;
      const threadRoot = caller?.attributes?.threadRoot;
      const attempt = Number(caller?.attributes?.attempt);
      if (caller?.authenticator !== "atpotato-droplet" ||
          typeof postUri !== "string" || typeof threadRoot !== "string" ||
          !Number.isSafeInteger(attempt) || attempt < 1 ||
          channel.continuation?.token !== postUri) {
        console.error("draft has no verified post address", ctx.session.id);
        return;
      }

      await postDraftToDroplet({
        key: `${ctx.session.id}:${event.turnId}`,
        threadRoot,
        postUri,
        attempt,
        text,
        links,
      });
    },
  },
});

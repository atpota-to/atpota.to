import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { defineChannel, POST, type Session } from "eve/channels";
import {
  MAX_TRACKED_LINKS,
  MentionEvent,
  buildPrompt,
  linksFromToolResult,
  postDraftToDroplet,
  secretMatches,
} from "../lib/bluesky";
import { describeImages } from "../lib/vision";

const APPROVAL_LIFETIME_MS = 24 * 60 * 60 * 1000;
const scanResponse = z.strictObject({
  sessionId: z.string().min(1).max(200),
  requestId: z.string().min(1).max(200),
  turnId: z.string().min(1).max(200),
  postUri: z.string().startsWith("at://").max(1000),
  attempt: z.number().int().positive(),
  optionId: z.enum(["approve", "deny"]),
  adminDid: z.string().regex(/^did:(plc|web):[^\s]+$/).max(300),
  expiresAt: z.number().int().positive(),
  approvalToken: z.string().regex(/^[a-f0-9]{64}$/),
});

type ApprovalAddress = Pick<z.infer<typeof scanResponse>,
  "sessionId" | "requestId" | "turnId" | "postUri" | "attempt" | "expiresAt">;

function approvalSignature(address: ApprovalAddress, secret: string): string {
  return createHmac("sha256", secret).update(JSON.stringify([
    "scan-approval-v1", address.sessionId, address.requestId, address.turnId,
    address.postUri, address.attempt, address.expiresAt,
  ])).digest("hex");
}

function signatureMatches(address: ApprovalAddress, token: string): boolean {
  const secret = process.env.DROPLET_SHARED_SECRET;
  if (!secret) return false;
  return timingSafeEqual(Buffer.from(approvalSignature(address, secret), "hex"), Buffer.from(token, "hex"));
}

// Read a bounded snapshot, not a live stream: it is the authoritative record
// of which request was offered and whether Eve has already settled it.
async function requestIsPending(session: Session, address: ApprovalAddress): Promise<boolean> {
  const tail = await session.getStreamTailIndex();
  if (tail > 2000 || tail < 1) return false;
  const reader = (await session.getEventStream({ startIndex: 0 })).getReader();
  let found = false;
  let settled = false;
  try {
    for (let i = 0; i < tail; i++) {
      const { value, done } = await reader.read();
      if (done || !value) return false;
      if (value.type === "input.requested" && value.data.turnId === address.turnId) {
        const request = value.data.requests.find((r: { requestId: string }) => r.requestId === address.requestId);
        const issued = Date.parse(value.meta?.at ?? "");
        if (request?.kind === "question" && request.display === "confirmation" &&
            request.allowFreeform === false && request.prompt?.startsWith("Scanned ") &&
            request.options?.some((o: { id: string }) => o.id === "approve") &&
            request.options?.some((o: { id: string }) => o.id === "deny") &&
            request.prompt?.includes("Approve scanning up to") &&
            Number.isFinite(issued) && address.expiresAt <= issued + APPROVAL_LIFETIME_MS + 60_000) found = true;
      }
      if (found && value.type === "turn.started" && value.data.turnId !== address.turnId) {
        // A new turn supersedes the dispatch attempt that requested this scan.
        settled = true;
      }
      if (value.type === "input.resolved" && value.data.resolutions.some(
        (r: { requestId: string }) => r.requestId === address.requestId,
      )) settled = true;
      if ((value.type === "turn.cancelled" || value.type === "turn.failed") &&
          value.data.turnId === address.turnId) settled = true;
    }
  } finally {
    await reader.cancel();
  }
  return found && !settled;
}

export default defineChannel({
  // Two people replying in the same thread should get two answers, not one
  // merged one. eve defaults to "steer", which is right for a chat box and
  // wrong here.
  turnPolicy: "queue",

  // Assistant text accumulates here as blocks finalize, and is sent once the
  // turn completes. See the note in agent-spec/09 on why not message.completed.
  state: {
    draft: "", links: [] as string[],
    origin: null as null | {
      sessionId: string; turnId: string; postUri: string; threadRoot: string; attempt: number;
    },
  },

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
    POST("/api/scan-approval/respond", async (request, { attachSession }) => {
      if (!secretMatches(request.headers.get("x-atpotato-secret"))) {
        return new Response(null, { status: 401 });
      }
      let body: unknown;
      try { body = await request.json(); } catch { return new Response(null, { status: 400 }); }
      const parsed = scanResponse.safeParse(body);
      if (!parsed.success) return new Response(null, { status: 400 });
      const response = parsed.data;
      if (Date.now() >= response.expiresAt ||
          response.expiresAt > Date.now() + APPROVAL_LIFETIME_MS ||
          !signatureMatches(response, response.approvalToken)) {
        return new Response(null, { status: 409 });
      }
      const session = attachSession(response.sessionId);
      if (!await requestIsPending(session, response)) return new Response(null, { status: 409 });
      const result = await session.respond([{
        requestId: response.requestId, optionId: response.optionId,
      }], {
        auth: {
          authenticator: "atpotato-droplet-scan-approval",
          principalType: "user",
          principalId: response.adminDid,
          attributes: {
            postUri: response.postUri,
            attempt: String(response.attempt),
            requestId: response.requestId,
            turnId: response.turnId,
          },
        },
      });
      return new Response(null, { status: result.status === "accepted" ? 202 : 409 });
    }),
  ],

  events: {
    // Clear per-turn accumulation here rather than at turn.completed, so a
    // failed or cancelled turn cannot leak its draft or its links into the
    // next one in the same thread.
    "turn.started"(event, channel, ctx) {
      channel.state.draft = "";
      channel.state.links = [];
      const caller = ctx.session.auth.current;
      const postUri = caller?.attributes?.postUri;
      const threadRoot = caller?.attributes?.threadRoot;
      const attempt = Number(caller?.attributes?.attempt);
      channel.state.origin = caller?.authenticator === "atpotato-droplet" &&
        caller.principalType === "user" && caller.principalId === caller.attributes?.did &&
        typeof postUri === "string" && typeof threadRoot === "string" &&
        postUri.startsWith(`at://${caller.principalId}/app.bsky.feed.post/`) &&
        Number.isSafeInteger(attempt) && attempt > 0 &&
        channel.continuation?.token === postUri
        ? { sessionId: ctx.session.id, turnId: event.turnId, postUri, threadRoot, attempt }
        : null;
    },

    async "input.requested"(event, channel, ctx) {
      const origin = channel.state.origin;
      if (!origin || origin.sessionId !== ctx.session.id ||
          origin.turnId !== event.turnId || channel.continuation?.token !== origin.postUri) return;
      const secret = process.env.DROPLET_SHARED_SECRET;
      const callback = process.env.DROPLET_CALLBACK_URL;
      if (!secret || !callback) throw new Error("scan approval callback not configured");
      for (const request of event.requests) {
        if (request.kind !== "question" || request.display !== "confirmation" ||
            request.allowFreeform !== false || !request.prompt.startsWith("Scanned ") ||
            !request.prompt.includes("Approve scanning up to") ||
            !request.options?.some((option) => option.id === "approve") ||
            !request.options?.some((option) => option.id === "deny")) continue;
        const address = {
          sessionId: origin.sessionId, requestId: request.requestId,
          turnId: origin.turnId, postUri: origin.postUri, attempt: origin.attempt,
          expiresAt: Date.now() + APPROVAL_LIFETIME_MS,
        };
        const url = new URL(callback);
        url.pathname = "/internal/scan-approval/request";
        url.search = "";
        url.hash = "";
        const delivered = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-atpotato-secret": secret },
          body: JSON.stringify({ ...address, approvalToken: approvalSignature(address, secret),
            prompt: request.prompt }),
        });
        if (!delivered.ok) throw new Error(`scan approval callback returned ${delivered.status}`);
      }
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

      // Approval changes auth.current to the admin. The original turn address
      // stays in durable channel state and must match this exact completion.
      const origin = channel.state.origin;
      if (!origin || origin.sessionId !== ctx.session.id ||
          origin.turnId !== event.turnId || channel.continuation?.token !== origin.postUri) {
        console.error("draft has no verified post address", ctx.session.id);
        return;
      }

      await postDraftToDroplet({
        key: `${origin.sessionId}:${origin.turnId}`,
        threadRoot: origin.threadRoot,
        postUri: origin.postUri,
        attempt: origin.attempt,
        text,
        links,
      });
    },
  },
});

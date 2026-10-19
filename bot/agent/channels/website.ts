import { defineChannel, POST, type Session } from "eve/channels";
import type { MessageStreamEvent } from "eve/client";
import { MAX_TRACKED_LINKS, linksFromToolResult } from "../lib/bluesky";
import {
  WEBSITE_AUTHENTICATOR,
  WEBSITE_SECRET_HEADER,
  WebsiteChat,
  buildWebsitePrompt,
  websiteSecretMatches,
} from "../lib/website";

// Below the proxy's own upstream timeout. eve sets no maxDuration for channel
// routes, so this function gets the Vercel project default; stay under it.
const MAX_STREAM_MS = 240_000;
const KEEPALIVE_MS = 15_000;
const MAX_BODY_BYTES = 16 * 1024;
// A pending session-limit prompt sits near the end of the stream; see
// sessionLimitPending.
const PENDING_LOOKBACK = 100;
const PENDING_READ_MS = 2_000;
const READ_ATTEMPTS = 4;

type ToolStatus = "running" | "completed" | "failed" | "rejected";
type ErrorCode = "upstream" | "timeout" | "conversation_over";

/**
 * The whole vocabulary the proxy reads. Assistant text and payload-free tool
 * status only: never reasoning, tool input or output, input request bodies or
 * the raw text of an eve error.
 */
type Out =
  | { event: "start"; data: { sessionId: string } }
  | { event: "tool"; data: { callId: string; name: string; status: ToolStatus } }
  | { event: "delta"; data: { text: string; block: number } }
  | { event: "block"; data: { text: string | null; block: number; finishReason: string } }
  | { event: "done"; data: { text: string; links: string[] } }
  | { event: "error"; data: { code: ErrorCode; message: string } };

// Safe to show a visitor as they are; the proxy passes them through.
const FAILED = "poe tripped over a root. try again in a moment.";
const EMPTY = "poe came back empty-handed. try asking another way.";
const TIMED_OUT = "poe is still digging. ask again in a minute.";
const OVER = "this chat has run its course. start a new chat to keep going.";

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store, no-transform",
  "x-accel-buffering": "no",
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One SSE event. JSON.stringify escapes newlines, so data stays one line. */
const frame = (out: Out) => `event: ${out.event}\ndata: ${JSON.stringify(out.data)}\n\n`;

function turnIdOf(event: MessageStreamEvent): string | undefined {
  // session.completed carries no data, and session-level events no turnId.
  const data = "data" in event ? event.data as { turnId?: unknown } | undefined : undefined;
  return typeof data?.turnId === "string" ? data.turnId : undefined;
}

/** null for anything that is not a JSON body inside the size cap. */
async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return null;
  try {
    const text = await request.text();
    return Buffer.byteLength(text) > MAX_BODY_BYTES ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Whether this session is parked on a session-limit prompt: eve's "approve
 * more usage?" question once the session's token budget is spent. eve
 * completes the turn with the prompt still pending, and from then on every
 * message gets a turn that ends at once without a model call, until someone
 * answers it. A visitor must never answer it, so the conversation is over.
 * The stream below says so when it sees the prompt, but a visitor who closed
 * the tab first never heard. Other prompts need no check: a new message
 * resolves a pending question as ignored and the turn goes ahead.
 *
 * Reads a bounded snapshot of the durable record, like requestIsPending in
 * channels/bluesky.ts; a prompt that matters is near the end of it.
 */
async function sessionLimitPending(session: Session, tail: number): Promise<boolean> {
  if (tail < 0) return false;
  const first = Math.max(0, tail - PENDING_LOOKBACK + 1);
  const reader = (await session.getEventStream({ startIndex: first })).getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), PENDING_READ_MS);
  });
  const pending = new Set<string>();
  try {
    for (let i = first; i <= tail; i++) {
      const next = await Promise.race([reader.read(), expired]);
      if (next === "expired" || next.done || !next.value) return false;
      const event = next.value;
      if (event.type === "input.requested") {
        for (const request of event.data.requests) {
          if (request.kind === "session-limit") pending.add(request.requestId);
        }
      } else if (event.type === "input.resolved") {
        for (const resolution of event.data.resolutions) pending.delete(resolution.requestId);
      }
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
  return pending.size > 0;
}

/**
 * Encodes one turn of the session stream as SSE.
 *
 * getEventStream yields parsed objects, not bytes, and it follows the session
 * live: it does not end when a turn does, so this stops on its own turn's
 * boundary and always releases the reader. The turn is ours when it carries
 * our deliveryId (a continued conversation) or is the first to start (a new
 * one). A dropped client stops the read, never the turn.
 */
function streamTurn(opts: {
  session: Session;
  startIndex: number;
  deliveryId?: string;
  signal: AbortSignal;
}): ReadableStream<Uint8Array> {
  const { session, deliveryId } = opts;
  const encoder = new TextEncoder();
  let reader: ReadableStreamDefaultReader<MessageStreamEvent> | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let finished = false;

  const stop = async () => {
    finished = true;
    clearInterval(keepalive);
    clearTimeout(deadline);
    await reader?.cancel().catch(() => {});
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        if (finished) return;
        try { controller.enqueue(encoder.encode(chunk)); } catch { finished = true; }
      };
      const write = (out: Out) => send(frame(out));
      const fail = (code: ErrorCode, message: string) => write({ event: "error", data: { code, message } });
      const timedOut = new Promise<"timeout">((resolve) => {
        deadline = setTimeout(() => resolve("timeout"), MAX_STREAM_MS);
      });
      keepalive = setInterval(() => send(": ping\n\n"), KEEPALIVE_MS);
      if (opts.signal.aborted) void stop();
      else opts.signal.addEventListener("abort", () => void stop(), { once: true });

      const pump = async () => {
        write({ event: "start", data: { sessionId: session.id } });
        let index = opts.startIndex; // absolute index of the next event to read
        let attempts = 0;
        let turnId: string | null = null;
        let answer = "";
        const tools = new Map<string, string>();
        const links = new Set<string>();

        const finish = () => {
          const text = answer.trim();
          if (!text) return fail("upstream", EMPTY);
          write({ event: "done", data: { text, links: [...links] } });
        };

        while (!finished) {
          let next: ReadableStreamReadResult<MessageStreamEvent> | "timeout";
          try {
            reader ??= (await session.getEventStream({ startIndex: index })).getReader();
            next = await Promise.race([reader.read(), timedOut]);
          } catch {
            // A run created a moment ago may not be readable yet, and a long
            // read can drop. Reopen where this left off, a few times.
            await reader?.cancel().catch(() => {});
            reader = undefined;
            if (++attempts >= READ_ATTEMPTS) return fail("upstream", FAILED);
            await delay(250 * attempts);
            continue;
          }
          if (next === "timeout") return fail("timeout", TIMED_OUT);
          if (next.done || !next.value) return finished ? undefined : fail("upstream", FAILED);
          index += 1;
          const event = next.value;

          if (event.type === "session.failed") return fail("upstream", FAILED);
          if (event.type === "session.completed") return fail("conversation_over", OVER);

          if (turnId === null) {
            // Only a turn.started can claim the turn. Our delivery is stamped
            // on other events too: when it lands on a prompt left pending, eve
            // first emits that older turn's input.resolved under our id.
            if (event.type !== "turn.started" ||
                (deliveryId !== undefined && !event.meta?.deliveryIds?.includes(deliveryId))) continue;
            turnId = event.data.turnId;
          }
          if (event.type === "session.waiting") return finish();
          if (turnIdOf(event) !== turnId) continue;

          switch (event.type) {
            case "actions.requested":
              for (const action of event.data.actions) {
                if (action.kind === "load-skill") continue;
                const name = action.kind === "tool-call" || action.kind === "workflow-tool-call"
                  ? action.toolName : action.name;
                tools.set(action.callId, name);
                write({ event: "tool", data: { callId: action.callId, name, status: "running" } });
              }
              break;
            case "action.result": {
              // Every https URL a tool returned this turn. The widget links a
              // URL only when it is in this list, which is what stands in for
              // the droplet's "no composed links" gate on the website.
              for (const url of linksFromToolResult(event.data)) {
                if (links.size >= MAX_TRACKED_LINKS) break;
                if (url.startsWith("https://") && url.length <= 2048) links.add(url);
              }
              const callId = event.data.result.callId;
              const name = tools.get(callId);
              if (name) write({ event: "tool", data: { callId, name, status: event.data.status } });
              break;
            }
            case "message.appended":
              if (event.data.messageDelta) {
                write({ event: "delta", data: { text: event.data.messageDelta, block: event.data.stepIndex } });
              }
              break;
            case "message.completed":
              // Authoritative for its block: a retried step re-emits its
              // deltas. The last non-empty block is the answer, as on Bluesky.
              write({ event: "block", data: {
                text: event.data.message, block: event.data.stepIndex, finishReason: event.data.finishReason,
              } });
              if (event.data.message?.trim()) answer = event.data.message;
              break;
            case "input.requested":
              // A session-limit prompt, a tool approval or a question. A
              // visitor must never answer the first two, and this route
              // accepts no answers at all. eve parks the prompt and completes
              // the turn; cancel anything still running, and tell the widget
              // to start over on a fresh conversation.
              await session.cancel({ turnId }).catch(() => undefined);
              return fail("conversation_over", OVER);
            case "turn.completed":
              return finish();
            case "turn.cancelled":
            case "turn.failed":
              return fail("upstream", FAILED);
            default:
              break; // reasoning, step and partial events never leave the bot
          }
        }
      };

      void pump()
        .catch(() => fail("upstream", FAILED))
        .finally(async () => {
          await stop();
          try { controller.close(); } catch { /* the client already went away */ }
        });
    },
    cancel: stop,
  });
}

export default defineChannel({
  // One answer per message. "steer" would fold a second message into the turn
  // already streaming, and two responses would end up reading one turn.
  turnPolicy: "queue",
  // Anonymous one-to-one chats. Keeps their content out of traces, which on
  // Vercel record content only for "public" sessions.
  audience: () => "private",

  routes: [
    // Server to server: the proxy on atpota.to is the only caller. There is
    // no CORS, no route that accepts input responses, and no session id from
    // the caller; the conversation is addressed by the proxy's cookie value.
    POST("/website/chat", async (request, { from, resolveSession }) => {
      if (!websiteSecretMatches(request.headers.get(WEBSITE_SECRET_HEADER))) {
        return new Response(null, { status: 401 });
      }
      if (process.env.WEBSITE_CHAT_DISABLED === "1") return new Response(null, { status: 503 });

      const parsed = WebsiteChat.safeParse(await readBody(request));
      if (!parsed.success) return new Response(null, { status: 400 });
      const chat = parsed.data;
      const prompt = buildWebsitePrompt(chat);
      const options = {
        auth: {
          authenticator: WEBSITE_AUTHENTICATOR,
          // Anonymous: no principal-scoped memory, and eve never coalesces
          // anonymous deliveries into one turn.
          principalType: "anonymous",
          principalId: "website-visitor",
          attributes: { conversationId: chat.conversationId, path: chat.page.path },
        },
      };

      // Continuing: send to the exact owner, so the result carries a
      // deliveryId that picks our turn out of the shared stream.
      let session: Session | undefined = await resolveSession(chat.conversationId);
      let startIndex = 0;
      let deliveryId: string | undefined;
      if (session) {
        const tail = await session.getStreamTailIndex();
        if (await sessionLimitPending(session, tail).catch(() => false)) {
          // Sending would only start a turn that ends empty.
          return new Response(frame({ event: "start", data: { sessionId: session.id } }) +
            frame({ event: "error", data: { code: "conversation_over", message: OVER } }), { headers: SSE_HEADERS });
        }
        const sent = await session.send(prompt, options);
        if (sent.status === "accepted") {
          startIndex = tail + 1;
          deliveryId = sent.deliveryId; // optional in the type; then the next turn to start is ours
        } else {
          session = undefined; // expired or reset in between
        }
      }
      if (!session) {
        // New conversation: send() creates the session and its first turn is
        // ours. Two first messages racing for one id is the one case this
        // cannot tell apart; the proxy's cookie makes it unlikely.
        session = await from(chat.conversationId).send(prompt, options);
        startIndex = 0;
      }

      return new Response(streamTurn({ session, startIndex, deliveryId, signal: request.signal }), {
        headers: SSE_HEADERS,
      });
    }),
  ],

  events: {
    // A channel with no handlers stays eve's plain "http" adapter and gets no
    // identity of its own; this one keeps it "channel:website". Codes only:
    // an eve error message can quote the turn.
    "turn.failed"(event, _channel, ctx) {
      console.error("website turn failed", ctx.session.id, event.code);
    },
  },
});

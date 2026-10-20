/**
 * The /api/poe proxy (SPEC 4.1-4.4). api/poe.ts only wires these handlers to the HTTP
 * methods; everything else lives here so tests can inject fetch, clock, limiter and timers.
 *
 * POST order: origin (403) -> content type (415) -> kill switch / config (503) -> body cap
 * (413) -> JSON and shape (400) -> rate limits (429) -> 200 event stream. Everything after
 * the stream starts, including upstream failures, arrives as SSE `error` events.
 *
 * A visitor signed in with Bluesky also sends `Authorization: Bearer <service-auth jwt>`.
 * Once the stream has started it is verified (server/identity.ts) and answered with one
 * `visitor` event; a verified DID goes to the bot with the message, which is what lets
 * Poe remember them. A token that fails any check, or POE_IDENTITY_DISABLED=1, leaves the
 * chat anonymous rather than failing it.
 *
 * DELETE clears the conversation cookie. With a token for to.atpota.poe.forget (the settings
 * page), it first has Poe forget the verified visitor (server/forget.ts): origin (403) ->
 * kill switch / config (503) -> token (401) -> bot (502) -> 200 { hadNotes, published }.
 */

import { readConfig, type Env } from './config.js';
import { clearedCookie, conversationCookie, newConversationId, readConversationId } from './cookie.js';
import { defaultCheckRateLimit, firewallLimited, type CheckRateLimit } from './firewall.js';
import { ALLOW, SSE_HEADERS, jsonError } from './http.js';
import { forgetOnBot } from './forget.js';
import { bearerToken, identify, POE_FORGET_LXM, POE_LXM, type IdentifyResult } from './identity.js';
import { consoleLogger, errorName, type Logger } from './log.js';
import { MESSAGES, type ErrorCode } from './messages.js';
import { isAllowedOrigin } from './origin.js';
import { mockPreStream, runMockTurn, type Sleep } from './poe-mock.js';
import { clientIp, createLocalLimiter, type LocalLimiter } from './rate-limit.js';
import { pageTitle } from './routes.js';
import { PING, encodeEvent } from './sse.js';
import {
  DEFAULT_HEADERS_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  relayTurn,
  type BrowserEvent,
  type TurnResult,
} from './upstream.js';
import { type InvalidReason, parseJson, readBodyCapped, validateChat } from './validation.js';

export const KEEPALIVE_MS = 15_000;
/** Retry-after for a firewall 429 (its window is not exposed to the function). */
export const FIREWALL_RETRY_AFTER = 60;

export interface PoeDeps {
  env?: () => Env;
  /** Defaults to the global fetch, looked up on every call. */
  fetch?: typeof fetch;
  now?: () => number;
  limiter?: LocalLimiter;
  checkRateLimit?: CheckRateLimit;
  log?: Logger;
  keepaliveMs?: number;
  /** Override the wait-for-headers and idle timeouts (the whole-turn one comes from the env). */
  timeouts?: { headersMs?: number; idleMs?: number };
  /** Mock pacing (tests make it instant). */
  sleep?: Sleep;
  mockStepMs?: number;
  /** Verifies a sign-in token for a method. Defaults to server/identity.ts with this fetch and clock. */
  identify?: (token: string, lxm: typeof POE_LXM | typeof POE_FORGET_LXM) => Promise<IdentifyResult>;
}

export interface PoeHandlers {
  POST(request: Request): Promise<Response>;
  DELETE(request: Request): Promise<Response>;
  methodNotAllowed(request: Request): Promise<Response>;
}

const INVALID_MESSAGES: Record<InvalidReason, string> = {
  not_object: MESSAGES.bad_request,
  message_missing: MESSAGES.bad_request,
  message_empty: MESSAGES.message_empty,
  message_too_long: MESSAGES.message_too_long,
  selection_type: MESSAGES.bad_request,
  selection_too_long: MESSAGES.selection_too_long,
};

type Run = (emit: (event: BrowserEvent) => void, ping: () => void, signal: AbortSignal) => Promise<TurnResult>;

/** What the log may say about a sign-in: a fixed code, never the DID or the token. */
type IdentityCode = 'verified' | Exclude<IdentifyResult, { ok: true }>['reason'];

export function createPoeHandlers(deps: PoeDeps = {}): PoeHandlers {
  const env = deps.env ?? (() => process.env);
  const doFetch: typeof fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? (() => Date.now());
  const limiter = deps.limiter ?? createLocalLimiter();
  const checkRateLimit = deps.checkRateLimit ?? defaultCheckRateLimit;
  const log = deps.log ?? consoleLogger;
  const keepaliveMs = deps.keepaliveMs ?? KEEPALIVE_MS;
  const verify = deps.identify ?? ((token: string, lxm: typeof POE_LXM | typeof POE_FORGET_LXM) => identify(token, { fetch: doFetch, now, lxm }));

  /**
   * The verified visitor for a request that sent a token, after telling the widget the
   * outcome. Null (anonymous) for no token, a failed check, or a verifier that threw.
   */
  async function visitorFor(token: string | null, header: boolean, emit: (event: BrowserEvent) => void) {
    if (!header) return { visitor: null, identity: undefined };
    const result: IdentifyResult = token
      ? await verify(token, POE_LXM).catch((): IdentifyResult => ({ ok: false, reason: 'no_key' }))
      : { ok: false, reason: 'malformed' };
    emit({ event: 'visitor', data: result.ok ? { signedIn: true, handle: result.visitor.handle } : { signedIn: false, handle: null } });
    const identity: IdentityCode = result.ok ? 'verified' : result.reason;
    return { visitor: result.ok ? result.visitor : null, identity };
  }

  /** A pre-stream JSON failure, logged by its fixed reason code. */
  const reject = (status: number, code: ErrorCode, message: string, reason: string, headers?: Record<string, string>) => {
    log({ event: 'rejected', status, code: reason });
    return jsonError(status, code, message, headers);
  };

  function stream(request: Request, cookie: string, conversation: 'new' | 'continued', mock: boolean, run: Run): Response {
    const encoder = new TextEncoder();
    const visitor = new AbortController();
    const onRequestAbort = () => visitor.abort();
    if (request.signal.aborted) visitor.abort();
    else request.signal.addEventListener('abort', onRequestAbort, { once: true });

    const started = now();
    let closed = false;
    let ping: ReturnType<typeof setInterval> | undefined;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (chunk: string) => {
          if (closed || visitor.signal.aborted) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            closed = true;
          }
        };
        const emit = (event: BrowserEvent) => write(encodeEvent(event.event, event.data));
        const writePing = () => write(PING);

        write(encodeEvent('ready', { conversation }));
        ping = setInterval(writePing, keepaliveMs);

        void run(emit, writePing, visitor.signal)
          .catch((err: unknown): TurnResult => {
            emit({ event: 'error', data: { code: 'upstream', message: MESSAGES.upstream } });
            return { outcome: 'error', code: 'proxy_threw', error: errorName(err), deltas: 0, tools: 0 };
          })
          .then((result) => {
            log({
              event: 'turn',
              outcome: result.outcome,
              ...(result.code ? { code: result.code } : {}),
              ...(result.status !== undefined ? { status: result.status } : {}),
              ...(result.error ? { error: result.error } : {}),
              ...(result.identity ? { identity: result.identity } : {}),
              ms: now() - started,
              mock,
              conversation,
              deltas: result.deltas,
              tools: result.tools,
            });
          })
          .finally(() => {
            clearInterval(ping);
            request.signal.removeEventListener('abort', onRequestAbort);
            if (!closed) {
              closed = true;
              try {
                controller.close();
              } catch {
                // already errored or cancelled
              }
            }
          });
      },
      cancel() {
        closed = true;
        clearInterval(ping);
        visitor.abort();
      },
    });

    return new Response(body, { status: 200, headers: { ...SSE_HEADERS, 'set-cookie': cookie } });
  }

  async function POST(request: Request): Promise<Response> {
    if (!isAllowedOrigin(request.headers.get('origin'), request.url)) {
      return reject(403, 'bad_request', MESSAGES.origin, 'origin');
    }
    // JSON only. A text/plain or form POST is a CORS "simple" request that skips the preflight
    // (which OPTIONS refuses), so this keeps every cross-site browser POST out.
    const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json') return reject(415, 'bad_request', MESSAGES.bad_request, 'content_type');

    const config = readConfig(env());
    if (config.disabled) return reject(503, 'not_configured', MESSAGES.disabled, 'disabled');
    if (!config.mock && (!config.secret || !config.agentUrl)) {
      return reject(503, 'not_configured', MESSAGES.not_configured, config.secret ? 'bad_agent_url' : 'no_secret');
    }

    const raw = await readBodyCapped(request);
    if (!raw.ok) {
      return raw.reason === 'too_large'
        ? reject(413, 'bad_request', MESSAGES.too_large, 'too_large')
        : reject(400, 'bad_request', MESSAGES.bad_request, 'unreadable');
    }
    const json = parseJson(raw.text);
    if (!json.ok) return reject(400, 'bad_request', MESSAGES.bad_request, 'bad_json');
    const checked = validateChat(json.value);
    if (!checked.ok) return reject(400, 'bad_request', INVALID_MESSAGES[checked.reason], checked.reason);
    const input = checked.value;

    // Only when the kill switch is off; a header that isn't a usable token still gets an answer.
    const signIn = config.identity && request.headers.has('authorization');
    const token = signIn ? bearerToken(request) : null;

    const existing = readConversationId(request);
    const conversationId = existing ?? newConversationId();
    const conversation = existing ? 'continued' : 'new';
    const cookie = conversationCookie(conversationId, request.url);

    if (config.mock) {
      const early = mockPreStream(input.message);
      if (early) {
        log({ event: 'rejected', status: 429, code: 'mock_rate', mock: true });
        return early;
      }
      const pacing = {
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        ...(deps.mockStepMs !== undefined ? { stepMs: deps.mockStepMs } : {}),
      };
      return stream(request, cookie, conversation, true, async (emit, ping, signal) => {
        const { identity } = await visitorFor(token, signIn, emit);
        return { ...(await runMockTurn({ input, emit, ping, signal, ...pacing })), ...(identity ? { identity } : {}) };
      });
    }

    if (config.rateLimitId && (await firewallLimited(config.rateLimitId, request, checkRateLimit, log))) {
      return reject(429, 'rate_limited', MESSAGES.rate_limited, 'firewall', { 'retry-after': String(FIREWALL_RETRY_AFTER) });
    }
    const decision = limiter.take(clientIp(request.headers), conversationId, now());
    if (decision.limited) {
      return reject(429, 'rate_limited', MESSAGES.rate_limited, `local_${decision.scope ?? 'ip'}`, {
        'retry-after': String(decision.retryAfter),
      });
    }

    const agentUrl = config.agentUrl!;
    const secret = config.secret!;
    const timeouts = {
      totalMs: config.upstreamTimeoutMs,
      headersMs: deps.timeouts?.headersMs ?? DEFAULT_HEADERS_TIMEOUT_MS,
      idleMs: deps.timeouts?.idleMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    };
    const chat = {
      conversationId,
      message: input.message,
      path: input.path,
      title: pageTitle(input.path),
      ...(input.selection ? { selection: input.selection } : {}),
    };
    return stream(request, cookie, conversation, false, async (emit, _ping, signal) => {
      const { visitor, identity } = await visitorFor(token, signIn, emit);
      const result = await relayTurn({ agentUrl, secret, chat: visitor ? { ...chat, visitor } : chat, signal, fetch: doFetch, emit, timeouts });
      return identity ? { ...result, identity } : result;
    });
  }

  async function DELETE(request: Request): Promise<Response> {
    if (!isAllowedOrigin(request.headers.get('origin'), request.url)) {
      return reject(403, 'bad_request', MESSAGES.origin, 'origin');
    }
    if (request.headers.has('authorization')) return forget(request);
    log({ event: 'reset', status: 204 });
    return new Response(null, {
      status: 204,
      headers: { 'set-cookie': clearedCookie(request.url), 'cache-control': 'no-store' },
    });
  }

  /** "Forget me": wipe what Poe remembers about the verified visitor, then clear the cookie. */
  async function forget(request: Request): Promise<Response> {
    const config = readConfig(env());
    // POE_CHAT_DISABLED does not stop this: switching the chat off must never stop someone
    // from being forgotten. Without identity there is no way to tell who is asking.
    if (!config.identity) return reject(503, 'not_configured', MESSAGES.forget_unavailable, 'forget_identity_disabled');
    if (!config.mock && (!config.secret || !config.agentUrl)) {
      return reject(503, 'not_configured', MESSAGES.forget_unavailable, config.secret ? 'bad_agent_url' : 'no_secret');
    }
    const token = bearerToken(request);
    const result: IdentifyResult = token
      ? await verify(token, POE_FORGET_LXM).catch((): IdentifyResult => ({ ok: false, reason: 'no_key' }))
      : { ok: false, reason: 'malformed' };
    if (!result.ok) {
      log({ event: 'forget', status: 401, identity: result.reason });
      return jsonError(401, 'bad_request', MESSAGES.forget_sign_in);
    }

    const done = (forgotten: { hadNotes: boolean; published: boolean }) =>
      new Response(JSON.stringify(forgotten), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          // The visitor's own chat may hold notes recalled before; the next one starts clean.
          'set-cookie': clearedCookie(request.url),
        },
      });

    if (config.mock) {
      log({ event: 'forget', status: 200, identity: 'verified', mock: true });
      return done({ hadNotes: true, published: true });
    }
    const outcome = await forgetOnBot({ agentUrl: config.agentUrl!, secret: config.secret!, did: result.visitor.did, fetch: doFetch });
    if (!outcome.ok) {
      log({
        event: 'forget_error',
        status: 502,
        ...(outcome.status !== undefined ? { code: `bot_${outcome.status}` } : {}),
        ...(outcome.error !== undefined ? { error: errorName(outcome.error) } : {}),
      });
      return jsonError(502, 'upstream', MESSAGES.forget_failed);
    }
    log({ event: 'forget', status: 200, identity: 'verified', code: outcome.forgotten.hadNotes ? 'had_notes' : 'no_notes' });
    return done(outcome.forgotten);
  }

  async function methodNotAllowed(_request: Request): Promise<Response> {
    return reject(405, 'bad_request', MESSAGES.method, 'method', { allow: ALLOW });
  }

  return { POST, DELETE, methodNotAllowed };
}

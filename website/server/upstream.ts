/**
 * One turn against the bot's website channel (SPEC 4.2): POST {agentUrl}/website/chat,
 * parse its event stream, and re-emit ONLY the browser events of SPEC 4.1.
 *
 *   bot `start`                  dropped (the session id never leaves the server)
 *   bot `tool` status=running    -> `status { state: "digging", label }` (friendly label only)
 *   bot `tool` other statuses    dropped
 *   bot `delta` / `block`        passed on after shape checks; text clipped
 *   bot `done`                   passed on with links filtered to plain https URLs (max 200)
 *   bot `error`                  passed on with a known code and a safe message
 *   anything else, ": ping"      dropped (the proxy sends its own pings)
 *
 * Failures before or during the stream end the turn with one `error` event:
 * 401/4xx/5xx/redirect/network/garbled stream -> "upstream"; the whole-turn timeout,
 * the wait-for-headers timeout or an idle stream -> "timeout". A client disconnect
 * aborts the upstream request and emits nothing (nobody is listening).
 */

import { errorName } from './log.js';
import { type ErrorCode, ERROR_CODES, messageForCode } from './messages.js';
import { SseOverflowError, SseParser, type SseEvent } from './sse.js';
import { toolLabel } from './tool-labels.js';

export const SECRET_HEADER = 'x-atpotato-website-secret';

export const MAX_DELTA = 4_000;
export const MAX_DELTA_TOTAL = 64_000;
export const MAX_TEXT = 16_000;
export const MAX_BLOCK_INDEX = 1_000;
export const MAX_LINKS = 200;
export const MAX_LINK_LENGTH = 2_048;
export const MAX_ERROR_MESSAGE = 200;

/** Defaults; the whole-turn limit comes from POE_UPSTREAM_TIMEOUT_MS. */
export const DEFAULT_HEADERS_TIMEOUT_MS = 60_000; // cold start + session lookup on the bot
export const DEFAULT_IDLE_TIMEOUT_MS = 45_000; // the bot pings every 15 s: three missed pings

export interface UpstreamChat {
  conversationId: string;
  message: string;
  path: string;
  title: string;
  selection?: string;
}

export interface Timeouts {
  totalMs: number;
  headersMs: number;
  idleMs: number;
}

export type BrowserEvent =
  | { event: 'status'; data: { state: 'digging'; label: string } }
  | { event: 'delta'; data: { text: string; block: number } }
  | { event: 'block'; data: { text: string | null; block: number } }
  | { event: 'done'; data: { text: string; links: string[] } }
  | { event: 'error'; data: { code: ErrorCode; message: string } };

export type Emit = (event: BrowserEvent) => void;

export interface TurnResult {
  outcome: 'done' | 'error' | 'aborted';
  /** A fixed code for the log, e.g. "upstream_401", "timeout", "bot_conversation_over". */
  code?: string;
  status?: number;
  error?: string;
  deltas: number;
  tools: number;
}

export interface RelayOptions {
  agentUrl: string;
  secret: string;
  chat: UpstreamChat;
  /** Fires when the visitor goes away. */
  signal: AbortSignal;
  fetch: typeof fetch;
  emit: Emit;
  timeouts: Timeouts;
}

/** Cut to `max` UTF-16 units without leaving half a surrogate pair at the end. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = text.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlockIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_BLOCK_INDEX;
}

const UNSAFE_URL_CHARS = /[\s\u0000-\u001f\u007f-\u009f]/;

/** Plain https URLs only: parseable, no credentials, no whitespace/control characters, deduped. */
export function cleanLinks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const item of value) {
    if (out.size >= MAX_LINKS) break;
    if (typeof item !== 'string' || item.length > MAX_LINK_LENGTH || !item.startsWith('https://')) continue;
    if (UNSAFE_URL_CHARS.test(item)) continue;
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hostname === '') continue;
    out.add(item);
  }
  return [...out];
}

export function toErrorCode(value: unknown): ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value) ? (value as ErrorCode) : 'upstream';
}

/**
 * The bot's own error messages are short, lowercase, plain sentences written for
 * visitors. Pass one on only if it still looks like that; otherwise use ours.
 */
const SAFE_MESSAGE_RE = /^[a-z0-9 .,'’!?:;()@-]+$/;

export function safeErrorMessage(code: ErrorCode, message: unknown): string {
  if (typeof message === 'string' && message.length > 0 && message.length <= MAX_ERROR_MESSAGE && SAFE_MESSAGE_RE.test(message)) {
    return message;
  }
  return messageForCode(code);
}

function parseData(data: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(data) as unknown;
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

export function upstreamBody(chat: UpstreamChat): string {
  const body: {
    conversationId: string;
    message: string;
    page: { path: string; title: string };
    selection?: string;
  } = {
    conversationId: chat.conversationId,
    message: chat.message,
    page: { path: chat.path, title: chat.title },
  };
  if (chat.selection) body.selection = chat.selection;
  return JSON.stringify(body);
}

export async function relayTurn(opts: RelayOptions): Promise<TurnResult> {
  const { emit, timeouts } = opts;
  let deltas = 0;
  let deltaChars = 0;
  let tools = 0;
  let lastLabel = '';

  const result = (outcome: TurnResult['outcome'], extra: Partial<TurnResult> = {}): TurnResult => ({
    outcome,
    deltas,
    tools,
    ...extra,
  });
  const fail = (code: ErrorCode, logCode: string, extra: Partial<TurnResult> = {}): TurnResult => {
    emit({ event: 'error', data: { code, message: messageForCode(code) } });
    return result('error', { code: logCode, ...extra });
  };

  if (opts.signal.aborted) return result('aborted', { code: 'client_gone' });

  const controller = new AbortController();
  let reason: 'client' | 'timeout' | null = null;
  let timeoutKind = '';
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<'aborted'>((resolve) => {
    onAbort = () => resolve('aborted');
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const stop = (why: 'client' | 'timeout', kind = '') => {
    if (reason) return;
    reason = why;
    timeoutKind = kind;
    controller.abort();
  };
  const onClient = () => stop('client');
  opts.signal.addEventListener('abort', onClient, { once: true });

  const totalTimer = setTimeout(() => stop('timeout', 'timeout_total'), timeouts.totalMs);
  let phaseTimer = setTimeout(() => stop('timeout', 'timeout_headers'), Math.min(timeouts.headersMs, timeouts.totalMs));
  const armIdle = () => {
    clearTimeout(phaseTimer);
    phaseTimer = setTimeout(() => stop('timeout', 'timeout_idle'), timeouts.idleMs);
  };

  const ended = (err?: unknown): TurnResult => {
    if (reason === 'client') return result('aborted', { code: 'client_gone' });
    if (reason === 'timeout') return fail('timeout', timeoutKind || 'timeout');
    if (err instanceof SseOverflowError) return fail('upstream', 'upstream_oversized_event');
    return fail('upstream', err === undefined ? 'upstream_incomplete' : 'upstream_stream_error', err === undefined ? {} : { error: errorName(err) });
  };

  const handle = (ev: SseEvent): TurnResult | null => {
    const data = parseData(ev.data);
    if (!data) return null;
    switch (ev.event) {
      case 'tool': {
        if (data.status !== 'running') return null;
        tools++;
        const label = toolLabel(data.name);
        if (label !== lastLabel) {
          lastLabel = label;
          emit({ event: 'status', data: { state: 'digging', label } });
        }
        return null;
      }
      case 'delta': {
        if (typeof data.text !== 'string' || data.text.length === 0 || !isBlockIndex(data.block)) return null;
        if (deltaChars >= MAX_DELTA_TOTAL) return null;
        const text = clip(clip(data.text, MAX_DELTA), MAX_DELTA_TOTAL - deltaChars);
        if (!text) return null;
        deltaChars += text.length;
        deltas++;
        emit({ event: 'delta', data: { text, block: data.block } });
        return null;
      }
      case 'block': {
        if (!(typeof data.text === 'string' || data.text === null) || !isBlockIndex(data.block)) return null;
        emit({ event: 'block', data: { text: data.text === null ? null : clip(data.text, MAX_TEXT), block: data.block } });
        return null;
      }
      case 'done': {
        if (typeof data.text !== 'string') return fail('upstream', 'upstream_bad_done');
        emit({ event: 'done', data: { text: clip(data.text, MAX_TEXT), links: cleanLinks(data.links) } });
        return result('done');
      }
      case 'error': {
        const code = toErrorCode(data.code);
        emit({ event: 'error', data: { code, message: safeErrorMessage(code, data.message) } });
        return result('error', { code: `bot_${code}` });
      }
      default:
        return null; // start (session id), unknown events
    }
  };

  try {
    let response: Response;
    try {
      const request = opts.fetch(`${opts.agentUrl}/website/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          [SECRET_HEADER]: opts.secret,
        },
        body: upstreamBody(opts.chat),
        redirect: 'manual',
        cache: 'no-store',
        signal: controller.signal,
      });
      const first = await Promise.race([request, aborted]);
      if (first === 'aborted') {
        request.then((r) => r.body?.cancel().catch(() => undefined)).catch(() => undefined);
        return ended();
      }
      response = first;
    } catch (err) {
      if (reason) return ended();
      return fail('upstream', 'upstream_network', { error: errorName(err) });
    }

    const status = response.status;
    if (response.type === 'opaqueredirect' || status < 200 || status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      return fail('upstream', `upstream_${status || 'redirect'}`, { status });
    }
    const type = response.headers.get('content-type') ?? '';
    if (!type.toLowerCase().includes('text/event-stream') || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return fail('upstream', 'upstream_not_sse', { status });
    }

    armIdle();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      for (;;) {
        const next = await Promise.race([reader.read(), aborted]);
        if (next === 'aborted') return ended();
        if (next.done) break;
        armIdle();
        for (const ev of parser.push(decoder.decode(next.value, { stream: true }))) {
          const done = handle(ev);
          if (done) return done;
        }
      }
      for (const ev of parser.push(decoder.decode())) {
        const done = handle(ev);
        if (done) return done;
      }
      return ended();
    } catch (err) {
      return ended(err);
    } finally {
      reader.cancel().catch(() => undefined);
    }
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(phaseTimer);
    opts.signal.removeEventListener('abort', onClient);
    controller.signal.removeEventListener('abort', onAbort);
    // Release the upstream connection whatever happened (no-op after a clean finish).
    if (!controller.signal.aborted) controller.abort();
  }
}

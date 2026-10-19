/**
 * Browser side of the /api/poe contract (SPEC 4.1).
 *
 *   POST /api/poe  {"message","path","selection"?}  ->  text/event-stream
 *     ready  {"conversation":"new"|"continued"}
 *     status {"state":"digging","label"}
 *     delta  {"text","block"}           streaming text for block N
 *     block  {"text"|null,"block"}      authoritative text for block N
 *     done   {"text","links"}           final answer + tool-returned https links
 *     error  {"code","message"}
 *     ": ping" comments every 15s
 *   pre-stream failures: JSON {"error":{"code","message"}} with 400/405/413/429/503
 *   DELETE /api/poe -> 204 (new conversation; the cookie is httpOnly)
 *
 * Every payload is validated here; nothing from the network reaches the DOM except
 * through render.ts (answers) or textContent (status labels).
 */

import { SseParser } from './sse';

export const ENDPOINT = '/api/poe';
export const MAX_MESSAGE = 1000;
export const MAX_SELECTION = 2000;
const MAX_TEXT = 20_000;
const MAX_LABEL = 80;
const MAX_LINKS = 200;
const MAX_LINK_LENGTH = 2048;
const MAX_BLOCK_INDEX = 1000;
const PATH_RE = /^\/[A-Za-z0-9/_.-]{0,200}$/;

export type ServerErrorCode =
  | 'not_configured'
  | 'rate_limited'
  | 'bad_request'
  | 'upstream'
  | 'timeout'
  | 'conversation_over'
  | 'busy';

/** Server codes plus the ones the client derives itself. */
export type PoeErrorCode = ServerErrorCode | 'offline' | 'network' | 'cut_off';

export const SERVER_ERROR_CODES: readonly ServerErrorCode[] = [
  'not_configured',
  'rate_limited',
  'bad_request',
  'upstream',
  'timeout',
  'conversation_over',
  'busy',
];

export interface PoeError {
  code: PoeErrorCode;
  /** Seconds, from a 429's retry-after header. */
  retryAfter?: number;
}

export interface AskRequest {
  message: string;
  path: string;
  selection?: string;
}

export interface StreamHandlers {
  onReady?(conversation: 'new' | 'continued'): void;
  onStatus?(label: string): void;
  onDelta?(block: number, text: string): void;
  onBlock?(block: number, text: string | null): void;
  onDone?(text: string, links: string[]): void;
  onError?(error: PoeError): void;
}

export type TurnOutcome = 'done' | 'error' | 'aborted';

export interface AskOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  /** Give up when nothing (not even a ping) arrives for this long. Default 60s (4 missed pings). */
  idleTimeoutMs?: number;
  isOnline?: () => boolean;
}

export function sanitizePath(path: string | null | undefined): string {
  return typeof path === 'string' && PATH_RE.test(path) ? path : '/';
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Builds the POST body per 4.1: trimmed message, collapsed selection, safe path. Null when the message is empty. */
export function buildRequest(message: string, path: string, selection?: string | null): AskRequest | null {
  const trimmed = message.trim().slice(0, MAX_MESSAGE).trim();
  if (!trimmed) return null;
  const body: AskRequest = { message: trimmed, path: sanitizePath(path) };
  if (typeof selection === 'string') {
    const sel = collapseWhitespace(selection).slice(0, MAX_SELECTION).trim();
    if (sel) body.selection = sel;
  }
  return body;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function isBlockIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_BLOCK_INDEX;
}

export function toErrorCode(value: unknown): ServerErrorCode | null {
  return typeof value === 'string' && (SERVER_ERROR_CODES as readonly string[]).includes(value) ? (value as ServerErrorCode) : null;
}

export function cleanLinks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length > MAX_LINK_LENGTH || !item.startsWith('https://')) continue;
    out.push(item);
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

function retryAfterSeconds(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(Math.round(seconds), 86_400);
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    const diff = Math.round((date - Date.now()) / 1000);
    return diff > 0 ? Math.min(diff, 86_400) : undefined;
  }
  return undefined;
}

function codeForStatus(status: number): ServerErrorCode {
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'not_configured';
  if (status === 504) return 'timeout';
  if (status === 409) return 'busy';
  if (status >= 400 && status < 500) return 'bad_request';
  return 'upstream';
}

async function errorFromResponse(response: Response): Promise<PoeError> {
  let code: ServerErrorCode | null = null;
  try {
    const body = (await response.json()) as unknown;
    if (isObject(body) && isObject(body.error)) code = toErrorCode(body.error.code);
  } catch {
    // not JSON; fall back to the status code
  }
  const error: PoeError = { code: code ?? codeForStatus(response.status) };
  if (error.code === 'rate_limited') {
    const retry = retryAfterSeconds(response.headers.get('retry-after'));
    if (retry !== undefined) error.retryAfter = retry;
  }
  return error;
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof DOMException ? error.name === 'AbortError' : (error as { name?: string } | null)?.name === 'AbortError';
}

/**
 * Sends one message and streams the turn. Resolves when the turn ends: "done"
 * after onDone, "error" after onError (exactly one of the two is called), or
 * "aborted" when the signal fires (neither is called).
 */
export async function askPoe(request: AskRequest, handlers: StreamHandlers, options: AskOptions = {}): Promise<TurnOutcome> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const isOnline = options.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
  const outer = options.signal;

  // Our own controller so the idle watchdog can stop the request too. The reader is
  // cancelled as well, so a body stream that ignores the signal still stops.
  const controller = new AbortController();
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const stop = () => {
    controller.abort();
    activeReader?.cancel().catch(() => undefined);
  };
  const onOuterAbort = () => stop();
  if (outer) {
    if (outer.aborted) return 'aborted';
    outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleFired = false;
  const armIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleFired = true;
      stop();
    }, idleTimeoutMs);
  };

  let finished = false;
  const fail = (error: PoeError): TurnOutcome => {
    if (!finished) {
      finished = true;
      handlers.onError?.(error);
    }
    return 'error';
  };

  try {
    armIdle();
    let response: Response;
    try {
      response = await fetchImpl(options.endpoint ?? ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(request),
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (error) {
      if (idleFired) return fail({ code: 'timeout' });
      if (isAbort(error, outer)) return 'aborted';
      return fail({ code: isOnline() ? 'network' : 'offline' });
    }

    if (!response.ok) return fail(await errorFromResponse(response));

    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('text/event-stream') || !response.body) {
      return fail(type.includes('json') ? await errorFromResponse(response) : { code: 'upstream' });
    }

    const reader = response.body.getReader();
    activeReader = reader;
    const decoder = new TextDecoder();
    const parser = new SseParser();
    let outcome: TurnOutcome | null = null;

    const handle = (name: string, data: string): TurnOutcome | null => {
      const payload = parseJson(data);
      if (!isObject(payload)) return null;
      switch (name) {
        case 'ready':
          if (payload.conversation === 'new' || payload.conversation === 'continued') handlers.onReady?.(payload.conversation);
          return null;
        case 'status':
          if (typeof payload.label === 'string') {
            const label = collapseWhitespace(payload.label).slice(0, MAX_LABEL);
            if (label) handlers.onStatus?.(label);
          }
          return null;
        case 'delta':
          if (typeof payload.text === 'string' && isBlockIndex(payload.block)) handlers.onDelta?.(payload.block, payload.text.slice(0, MAX_TEXT));
          return null;
        case 'block':
          if ((typeof payload.text === 'string' || payload.text === null) && isBlockIndex(payload.block)) {
            handlers.onBlock?.(payload.block, payload.text === null ? null : payload.text.slice(0, MAX_TEXT));
          }
          return null;
        case 'done': {
          const text = typeof payload.text === 'string' ? payload.text.slice(0, MAX_TEXT) : '';
          finished = true;
          handlers.onDone?.(text, cleanLinks(payload.links));
          return 'done';
        }
        case 'error':
          return fail({ code: toErrorCode(payload.code) ?? 'upstream' });
        default:
          return null; // unknown events are ignored
      }
    };

    try {
      while (outcome === null) {
        const { value, done } = await reader.read();
        if (idleFired || outer?.aborted) break;
        if (done) {
          const rest = decoder.decode();
          const events = [...parser.push(rest), ...parser.end()];
          for (const ev of events) {
            outcome = handle(ev.event, ev.data);
            if (outcome) break;
          }
          break;
        }
        armIdle();
        for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
          outcome = handle(ev.event, ev.data);
          if (outcome) break;
        }
      }
    } catch (error) {
      if (idleFired) return fail({ code: 'timeout' });
      if (isAbort(error, outer)) return 'aborted';
      return fail({ code: isOnline() ? 'cut_off' : 'offline' });
    } finally {
      reader.cancel().catch(() => undefined);
    }

    if (outcome) return outcome;
    if (idleFired) return fail({ code: 'timeout' });
    if (outer?.aborted) return 'aborted';
    // The stream closed without "done" or "error".
    return fail({ code: 'cut_off' });
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    outer?.removeEventListener('abort', onOuterAbort);
  }
}

/** Starts a new conversation (the proxy clears the httpOnly cookie). Never throws. */
export async function resetConversation(options: { fetchImpl?: typeof fetch; endpoint?: string } = {}): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  try {
    const response = await fetchImpl(options.endpoint ?? ENDPOINT, {
      method: 'DELETE',
      credentials: 'same-origin',
      cache: 'no-store',
      keepalive: true,
    });
    return response.ok;
  } catch {
    return false;
  }
}

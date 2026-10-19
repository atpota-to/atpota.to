import type { ErrorCode } from './messages.js';

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store, no-transform',
  'x-accel-buffering': 'no',
  'x-content-type-options': 'nosniff',
};

export const ALLOW = 'POST, DELETE';

/** Pre-stream failure: `{ "error": { "code", "message" } }` with the given status. */
export function jsonError(
  status: number,
  code: ErrorCode,
  message: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

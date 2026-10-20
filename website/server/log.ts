/**
 * Structured, content-free logging for the proxy. Only codes, statuses, counts and
 * timings are accepted: the field types make it awkward to pass visitor text, the
 * secret or an upstream body by accident, and nothing in server/ ever does.
 */

export interface LogFields {
  /** What happened, e.g. "turn", "rejected", "firewall_error". */
  event: string;
  /** A fixed code from this codebase (error code, reason), never free text. */
  code?: string;
  status?: number;
  ms?: number;
  outcome?: 'done' | 'error' | 'aborted';
  mock?: boolean;
  conversation?: 'new' | 'continued';
  /** Error class name only (e.g. "TypeError"), never the message. */
  error?: string;
  deltas?: number;
  tools?: number;
  /** A sign-in token's outcome: "verified" or a fixed reason code, never the DID. */
  identity?: string;
}

export type Logger = (fields: LogFields) => void;

export const consoleLogger: Logger = (fields) => {
  const line = JSON.stringify({ src: 'poe-proxy', ...fields });
  if (fields.event.endsWith('_error') || fields.outcome === 'error') console.warn(line);
  else console.info(line);
};

/** Class name of a thrown value, safe to log (no message, no stack). */
export function errorName(err: unknown): string {
  if (err && typeof err === 'object') {
    const name = (err as { name?: unknown }).name;
    const cause = (err as { cause?: { code?: unknown } }).cause;
    const causeCode = cause && typeof cause.code === 'string' && /^[A-Z_]{2,40}$/.test(cause.code) ? `:${cause.code}` : '';
    if (typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name)) return name + causeCode;
  }
  return 'unknown';
}

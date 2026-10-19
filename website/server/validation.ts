/**
 * Request validation for POST /api/poe (SPEC 4.1). The limits match the bot's strict
 * WebsiteChat schema (bot/agent/lib/website.ts), so anything that passes here is a body
 * the bot accepts. Lengths are JS string lengths (UTF-16 code units), as zod counts them.
 */

export const MAX_BODY_BYTES = 8 * 1024;
export const MAX_MESSAGE = 1000;
export const MAX_SELECTION = 2000;
export const PATH_RE = /^\/[A-Za-z0-9/_.-]{0,200}$/;

export interface ChatInput {
  message: string;
  path: string;
  selection?: string;
}

export type InvalidReason =
  | 'not_object'
  | 'message_missing'
  | 'message_empty'
  | 'message_too_long'
  | 'selection_type'
  | 'selection_too_long';

export type ValidationResult = { ok: true; value: ChatInput } | { ok: false; reason: InvalidReason };

/** location.pathname when it matches the allowed shape, else "/". */
export function sanitizePath(value: unknown): string {
  return typeof value === 'string' && PATH_RE.test(value) ? value : '/';
}

/** Trim and collapse every whitespace run (newlines included) to one space. */
export function normalizeSelection(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateChat(raw: unknown): ValidationResult {
  if (!isPlainObject(raw)) return { ok: false, reason: 'not_object' };
  if (typeof raw.message !== 'string') return { ok: false, reason: 'message_missing' };
  const message = raw.message.trim();
  if (message.length === 0) return { ok: false, reason: 'message_empty' };
  if (message.length > MAX_MESSAGE) return { ok: false, reason: 'message_too_long' };

  const value: ChatInput = { message, path: sanitizePath(raw.path) };

  if (raw.selection !== undefined && raw.selection !== null) {
    if (typeof raw.selection !== 'string') return { ok: false, reason: 'selection_type' };
    const selection = normalizeSelection(raw.selection);
    if (selection.length > MAX_SELECTION) return { ok: false, reason: 'selection_too_long' };
    if (selection) value.selection = selection;
  }
  // Every other field is ignored: the upstream body is rebuilt from these three.
  return { ok: true, value };
}

export type BodyResult = { ok: true; text: string } | { ok: false; reason: 'too_large' | 'unreadable' };

/**
 * Reads the request body as UTF-8, refusing anything over `max` bytes before parsing:
 * first by content-length, then by counting bytes as they arrive (chunked bodies).
 */
export async function readBodyCapped(request: Request, max = MAX_BODY_BYTES): Promise<BodyResult> {
  const declared = request.headers.get('content-length');
  if (declared !== null && declared.trim() !== '') {
    const n = Number(declared);
    if (!Number.isFinite(n) || n < 0) return { ok: false, reason: 'unreadable' };
    if (n > max) return { ok: false, reason: 'too_large' };
  }
  if (!request.body) return { ok: true, text: '' };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

export function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

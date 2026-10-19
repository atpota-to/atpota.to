import { randomBytes } from 'node:crypto';

/**
 * The conversation id lives only in an httpOnly cookie scoped to /api/poe (SPEC 4.1):
 * 32 random bytes, base64url (43 characters). The browser never reads it; the proxy
 * mints it when missing and uses it as the bot's conversationId.
 */

export const COOKIE_NAME = 'poe_conversation';
export const COOKIE_PATH = '/api/poe';
export const COOKIE_MAX_AGE = 7200;
export const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{43}$/;

export function newConversationId(): string {
  return randomBytes(32).toString('base64url');
}

/** The first well-formed poe_conversation value in the Cookie header, else null. */
export function readConversationId(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    if (CONVERSATION_ID_RE.test(value)) return value;
  }
  return null;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Plain-http localhost (vite dev): browsers would drop a Secure cookie there, so omit the flag. */
export function isInsecureLocalhost(requestUrl: string): boolean {
  try {
    const url = new URL(requestUrl);
    return url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  } catch {
    return false;
  }
}

function attributes(requestUrl: string, maxAge: number): string {
  const parts = [`Path=${COOKIE_PATH}`, 'HttpOnly'];
  if (!isInsecureLocalhost(requestUrl)) parts.push('Secure');
  parts.push('SameSite=Lax', `Max-Age=${maxAge}`);
  if (maxAge === 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  return parts.join('; ');
}

export function conversationCookie(id: string, requestUrl: string): string {
  return `${COOKIE_NAME}=${id}; ${attributes(requestUrl, COOKIE_MAX_AGE)}`;
}

export function clearedCookie(requestUrl: string): string {
  return `${COOKIE_NAME}=; ${attributes(requestUrl, 0)}`;
}

/**
 * Escaping and URL checks for the blog renderer. Everything that reaches the page from a
 * record (Poe writes these, and Poe is a language model reading the open network) goes
 * through escapeHtml / escapeAttr, and every href or src through one of the checks below.
 */

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Text with line breaks kept as <br>. */
export function textWithBreaks(value: string): string {
  return escapeHtml(value).replace(/\r\n?|\n/g, '<br>');
}

const AT_URI_RE = /^at:\/\/([a-zA-Z0-9._:%-]+)(?:\/([a-zA-Z0-9.-]+)(?:\/([A-Za-z0-9._:~-]+))?)?$/;

export interface AtUri {
  repo: string;
  collection?: string;
  rkey?: string;
}

export function parseAtUri(value: string): AtUri | null {
  const m = AT_URI_RE.exec(value);
  if (!m) return null;
  const out: AtUri = { repo: m[1]! };
  if (m[2]) out.collection = m[2];
  if (m[3]) out.rkey = m[3];
  return out;
}

/** Aturi opens any at:// record or account in whichever app the reader uses. */
export function aturiUrl(uri: AtUri | string): string | null {
  const parsed = typeof uri === 'string' ? (uri.startsWith('at://') ? parseAtUri(uri) : parseAtUri(`at://${uri}`)) : uri;
  if (!parsed) return null;
  // AT_URI_RE only admits URL-safe characters, and Aturi expects the colons in a DID as-is.
  const parts = [parsed.repo, parsed.collection, parsed.rkey].filter(Boolean);
  return `https://aturi.to/profile/${parts.join('/')}`;
}

/** An absolute http(s) URL with no credentials, or null. */
export function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  return url.href;
}

/**
 * A link target for rich text: http(s), mailto, an in-page #fragment, or an at:// URI
 * (opened through Aturi). Anything else (javascript:, data:, relative paths) is refused.
 */
export function safeHref(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (/^#[A-Za-z0-9_-]{1,128}$/.test(v)) return v;
  if (v.startsWith('at://')) return aturiUrl(v);
  if (/^mailto:[^\s<>"]+$/i.test(v)) return v;
  return httpUrl(v);
}

/** "https://www.example.com/a" -> "example.com" for link cards. */
export function displayHost(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** JSON for a <script type="application/ld+json"> block (no "</script>" breakout). */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

/** Colours from records (drawings, highlights): #rgb/#rrggbb(aa) or rgb()/rgba() only. */
export function safeColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) return v;
  if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/.test(v)) return v;
  return null;
}

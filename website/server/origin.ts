/**
 * Origin check (SPEC 4.3). A request with no Origin header passes (same-origin GETs,
 * curl, server-to-server); browsers always send Origin on cross-origin POST/DELETE.
 * A present Origin must be the request's own origin or one of the site's hosts.
 */

const SITE_HOSTS = new Set(['atpota.to', 'www.atpota.to', 'atpotato.com', 'www.atpotato.com']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/**
 * This project's preview deployments, e.g. atpota-to-git-<branch>-atpotato.vercel.app and
 * atpota-to-<hash>-atpotato.vercel.app. Narrower than "*.vercel.app": anyone can host a page
 * on vercel.app, and a preview calling its own /api/poe is already same-origin.
 */
const PREVIEW_HOST_RE = /^atpota-to(?:-[a-z0-9-]+)?\.vercel\.app$/;

export function isAllowedOrigin(origin: string | null, requestUrl: string): boolean {
  if (origin === null) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false; // includes the literal "null" origin (sandboxed frames, file://)
  }
  try {
    if (parsed.origin === new URL(requestUrl).origin) return true;
  } catch {
    // fall through to the host list
  }
  const host = parsed.hostname.toLowerCase();
  if (LOOPBACK.has(host)) return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  if (parsed.protocol !== 'https:') return false;
  if (parsed.port !== '') return false;
  return SITE_HOSTS.has(host) || PREVIEW_HOST_RE.test(host);
}

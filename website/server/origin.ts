/**
 * Origin check (SPEC 4.3). A request with no Origin header passes (same-origin GETs,
 * curl, server-to-server); browsers always send Origin on cross-origin POST/DELETE.
 * A present Origin must be the request's own origin or host, or one of the site's hosts.
 *
 * There is deliberately no "*.vercel.app" pattern: anyone can create a Vercel project whose
 * hostnames look like ours (atpota-to-evil.vercel.app, atpota-to-git-x-<their team>.vercel.app).
 * A preview calling its own /api/poe is covered by the same-host rule instead.
 */

const SITE_HOSTS = new Set(['atpota.to', 'www.atpota.to', 'atpotato.com', 'www.atpotato.com']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isAllowedOrigin(origin: string | null, requestUrl: string): boolean {
  if (origin === null) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false; // includes the literal "null" origin (sandboxed frames, file://)
  }
  let request: URL | null = null;
  try {
    request = new URL(requestUrl);
  } catch {
    // fall through to the host list
  }
  if (request) {
    if (parsed.origin === request.origin) return true;
    // Same host over https, whatever scheme the runtime wrote into request.url (Vercel's Node
    // adapter builds it as http:// behind TLS). The Host comes from Vercel's edge; a cross-site
    // page cannot change it.
    if (parsed.protocol === 'https:' && parsed.host === request.host) return true;
  }
  const host = parsed.hostname.toLowerCase();
  if (LOOPBACK.has(host)) {
    // Local dev only: a loopback page may call a loopback server on another port.
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && request !== null && LOOPBACK.has(request.hostname);
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.port !== '') return false;
  return SITE_HOSTS.has(host);
}

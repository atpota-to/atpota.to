// server.js
// GET /healthz  for the deploy's health check and uptime checks: 200 when healthy, 503
//               otherwise, with the same fields either way
//
// Listens on localhost only, and nginx has no route to it: the website reads the index
// from Supabase, never from here.
//
// Healthy means both:
//  - the Jetstream socket is open (or the process is under a minute old, still connecting)
//  - the last garden_status write succeeded within the last 2 minutes (or, in the first 2
//    minutes, none has been tried yet). The heartbeat writes it every 30 s, but only while
//    connected with nothing waiting to be applied, so this also goes red when Supabase is
//    refusing writes.

import http from 'node:http';

export const STARTUP_GRACE_MS = 60_000;
export const STATUS_FRESH_MS = 120_000;

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/**
 * `s`: { startedAt, connected, host, pending, lastFlushAt, lastStatusAt, lastStatusAttemptAt,
 * backfilledAt } (times in ms, except the ISO strings lastFlushAt and backfilledAt).
 */
export function health(s, nowMs) {
  const uptime = nowMs - s.startedAt;
  const streamOk = s.connected || uptime < STARTUP_GRACE_MS;
  const statusOk = (s.lastStatusAt !== null && nowMs - s.lastStatusAt < STATUS_FRESH_MS) || (s.lastStatusAttemptAt === null && uptime < STATUS_FRESH_MS);
  return {
    ok: Boolean(streamOk && statusOk),
    connected: Boolean(s.connected),
    host: s.host ?? null,
    pending: s.pending ?? 0,
    lastFlushAt: s.lastFlushAt ?? null,
    lastStatusAt: iso(s.lastStatusAt),
    backfilledAt: s.backfilledAt ?? null,
    uptimeSeconds: Math.round(uptime / 1000),
  };
}

export function createServer({ snapshot, now = () => Date.now() }) {
  return http.createServer((req, res) => {
    const head = req.method === 'HEAD';
    const send = (status, body, extra = {}) => {
      const text = JSON.stringify(body);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...extra,
      });
      res.end(head ? undefined : text);
    };
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== '/healthz') return send(404, { error: 'not found' });
    if (req.method !== 'GET' && !head) return send(405, { error: 'method not allowed' }, { allow: 'GET, HEAD' });
    const h = health(snapshot(), now());
    return send(h.ok ? 200 : 503, h);
  });
}

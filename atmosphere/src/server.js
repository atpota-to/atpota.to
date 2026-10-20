// server.js
// GET /v1/now   the last 60 seconds (needs x-atpotato-weather-secret)
// GET /healthz  open, for uptime checks: 200 when connected and current, 503 otherwise
//
// Listens on localhost; nginx terminates TLS in front of it. Vercel caches /v1/now for a
// few seconds, so it sees roughly a dozen requests a minute whoever is watching.

import crypto from 'node:crypto';
import http from 'node:http';
import { MIN_COVERED } from './station.js';

export const SECRET_HEADER = 'x-atpotato-weather-secret';
/** /healthz says unhealthy past this much lag behind the stream. */
export const HEALTHY_LAG_S = 10;

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();

export function authorized(given, secret) {
  if (typeof given !== 'string' || !given) return false;
  return crypto.timingSafeEqual(digest(given), digest(secret));
}

export function health(station, nowMs) {
  const lagSeconds = station.lastUs === null ? null : Math.round((nowMs / 1000 - station.lastUs / 1e6) * 10) / 10;
  const covered60 = station.window(nowMs).seconds;
  const connected = station.connected;
  const ok = connected && lagSeconds !== null && lagSeconds < HEALTHY_LAG_S && covered60 >= MIN_COVERED;
  return { ok, connected, lagSeconds, covered60 };
}

export function createServer({ station, secret, now = () => Date.now() }) {
  if (!secret) throw new Error('createServer needs a secret');
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
    if (path !== '/v1/now' && path !== '/healthz') return send(404, { error: 'not found' });
    if (req.method !== 'GET' && !head) return send(405, { error: 'method not allowed' }, { allow: 'GET, HEAD' });
    if (path === '/healthz') {
      const h = health(station, now());
      return send(h.ok ? 200 : 503, h);
    }
    if (!authorized(req.headers[SECRET_HEADER], secret)) return send(401, { error: 'unauthorized' });
    const reading = station.reading(now());
    if (!reading) return send(503, { error: 'unavailable' });
    return send(200, reading);
  });
}

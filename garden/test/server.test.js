// /healthz over real HTTP, and when it says healthy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, health, STARTUP_GRACE_MS, STATUS_FRESH_MS } from '../src/server.js';

const T0 = 1_792_512_000_000;
const base = {
  startedAt: T0,
  connected: true,
  host: 'wss://jetstream2.us-east.bsky.network',
  pending: 0,
  lastFlushAt: null,
  lastStatusAt: null,
  lastStatusAttemptAt: null,
  backfilledAt: null,
};

async function serve(state, nowMs) {
  const server = createServer({ snapshot: () => state, now: () => nowMs });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, close: () => new Promise((r) => server.close(r)) };
}

test('healthy: connected, and the heartbeat written lately', () => {
  const now = T0 + 10 * 60_000;
  const h = health({ ...base, lastStatusAt: now - 30_000, lastStatusAttemptAt: now - 30_000, backfilledAt: '2026-10-20T00:00:00.000Z' }, now);
  assert.deepEqual(h, {
    ok: true,
    connected: true,
    host: base.host,
    pending: 0,
    lastFlushAt: null,
    lastStatusAt: new Date(now - 30_000).toISOString(),
    backfilledAt: '2026-10-20T00:00:00.000Z',
    uptimeSeconds: 600,
  });
});

test('a fresh process gets a minute to connect and two to write a heartbeat', () => {
  assert.equal(health({ ...base, connected: false }, T0 + STARTUP_GRACE_MS - 1).ok, true);
  assert.equal(health({ ...base, connected: false }, T0 + STARTUP_GRACE_MS).ok, false);
  assert.equal(health(base, T0 + STATUS_FRESH_MS - 1).ok, true);
  assert.equal(health(base, T0 + STATUS_FRESH_MS).ok, false, 'no heartbeat in two minutes');
  assert.equal(health({ ...base, lastStatusAttemptAt: T0 + 1000 }, T0 + 2000).ok, false, 'a heartbeat tried and failed is not a grace period');
});

test('unhealthy: disconnected, or the heartbeat is stale', () => {
  const now = T0 + 3600_000;
  assert.equal(health({ ...base, connected: false, lastStatusAt: now - 1000, lastStatusAttemptAt: now - 1000 }, now).ok, false);
  assert.equal(health({ ...base, lastStatusAt: now - STATUS_FRESH_MS, lastStatusAttemptAt: now - 1000 }, now).ok, false);
});

test('/healthz: 200 or 503 with the same fields, never cached', async () => {
  const now = T0 + 3600_000;
  const state = { ...base, lastStatusAt: now - 1000, lastStatusAttemptAt: now - 1000 };
  const s = await serve(state, now);
  try {
    const ok = await fetch(`${s.url}/healthz`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    const body = await ok.json();
    assert.equal(body.ok, true);
    state.connected = false;
    const down = await fetch(`${s.url}/healthz`);
    assert.equal(down.status, 503);
    assert.deepEqual(Object.keys(await down.json()), Object.keys(body));
  } finally {
    await s.close();
  }
});

test('only GET and HEAD, only /healthz', async () => {
  const now = T0 + 1000;
  const s = await serve(base, now);
  try {
    const post = await fetch(`${s.url}/healthz`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
    assert.equal((await fetch(`${s.url}/`)).status, 404);
    assert.equal((await fetch(`${s.url}/v1/now`)).status, 404);
    assert.equal((await fetch(`${s.url}/healthz/../x`)).status, 404);
    const head = await fetch(`${s.url}/healthz`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally {
    await s.close();
  }
});

// /v1/now and /healthz over real HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, SECRET_HEADER } from '../src/server.js';
import { Station } from '../src/station.js';

const T0 = 1_792_512_000;
const SECRET = 'x'.repeat(40);

async function serve(station, nowSec, repair = null) {
  const server = createServer({ station, secret: SECRET, repair, now: () => nowSec * 1000 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

function live(from, to, nowSec) {
  const station = new Station({ now: () => nowSec * 1000 });
  station.beginSession();
  for (let t = from; t <= to; t += 0.1) station.ingest(Math.round(t * 1e6), { kind: 'create', collection: 'app.bsky.feed.post' });
  return station;
}

test('needs the secret: none or a wrong one is 401', async () => {
  const s = await serve(live(T0 - 100, T0 + 1.9, T0 + 2), T0 + 2);
  try {
    assert.equal((await fetch(`${s.base}/v1/now`)).status, 401);
    assert.equal((await fetch(`${s.base}/v1/now`, { headers: { [SECRET_HEADER]: 'nope' } })).status, 401);
    assert.equal((await fetch(`${s.base}/v1/now`, { headers: { [SECRET_HEADER]: SECRET + 'x' } })).status, 401);
    const ok = await fetch(`${s.base}/v1/now`, { headers: { [SECRET_HEADER]: SECRET } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    const body = await ok.json();
    assert.equal(body.seconds, 60);
    assert.equal(body.perSecond.posts, 10);
    assert.equal(body.condition, 'calm');
    assert.equal(body.series.length, 60);
    assert.deepEqual(body.window, { from: '2026-10-20T15:59:00.000Z', to: '2026-10-20T16:00:00.000Z' });
  } finally {
    await s.close();
  }
});

test('under 30 covered seconds is 503 unavailable', async () => {
  const s = await serve(live(T0 - 20, T0 + 1.9, T0 + 2), T0 + 2);
  try {
    const res = await fetch(`${s.base}/v1/now`, { headers: { [SECRET_HEADER]: SECRET } });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'unavailable' });
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    await s.close();
  }
});

test('/healthz is open, and says when the stream is down', async () => {
  const station = live(T0 - 100, T0 + 1.9, T0 + 2);
  const s = await serve(station, T0 + 2);
  try {
    const res = await fetch(`${s.base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, connected: true, lagSeconds: 0.1, covered60: 60 });
    station.endSession();
    const down = await fetch(`${s.base}/healthz`);
    assert.equal(down.status, 503);
    assert.equal((await down.json()).connected, false);
  } finally {
    await s.close();
  }
});

test('only GET and HEAD, only its two paths', async () => {
  const s = await serve(live(T0 - 100, T0 + 1.9, T0 + 2), T0 + 2);
  try {
    const post = await fetch(`${s.base}/v1/now`, { method: 'POST', headers: { [SECRET_HEADER]: SECRET } });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
    assert.equal((await fetch(`${s.base}/`)).status, 404);
    assert.equal((await fetch(`${s.base}/v1/now/../../etc`)).status, 404);
    const head = await fetch(`${s.base}/v1/now`, { method: 'HEAD', headers: { [SECRET_HEADER]: SECRET } });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally {
    await s.close();
  }
});

test('/v1/now carries the last census of hosts, when there is one', async () => {
  const nowSec = T0 + 2;
  const hosts = { summary: (ms) => ({ measuredAt: new Date(ms).toISOString(), active: 3 }) };
  const server = createServer({ station: live(T0 - 100, T0 + 1.9, nowSec), secret: SECRET, hosts, now: () => nowSec * 1000 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/v1/now`, { headers: { [SECRET_HEADER]: SECRET } })).json();
    assert.equal(body.hosts.active, 3);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('the reading says how the station is doing, and /healthz how the repair is going', async () => {
  const repair = { missing: 212, lost: 3, repairing: { from: '2026-10-20T13:00:00.000Z', to: '2026-10-20T15:00:00.000Z' } };
  const s = await serve(live(T0 - 100, T0 + 1.9, T0 + 2), T0 + 2, repair);
  try {
    const body = await (await fetch(`${s.base}/v1/now`, { headers: { [SECRET_HEADER]: SECRET } })).json();
    assert.deepEqual(body.health, { ok: true, lagSeconds: 0.1, covered60: 60, ...repair });
    const h = await (await fetch(`${s.base}/healthz`)).json();
    assert.deepEqual(h.repair, repair);
  } finally {
    await s.close();
  }
});

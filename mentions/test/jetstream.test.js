// Reconnect behaviour, driven through a fake WebSocket. No network.
//
// This file exists because this is the highest-risk code in the service and it
// shipped two bugs that both presented as "looks healthy, is wrong":
//   1. a failed HTTP upgrade fires `error` and not `close`, so assuming close
//      always follows left a dead socket that never retried;
//   2. the settle guard was shared across attempts, so a late close from a
//      superseded socket started a SECOND reconnect chain -- doubling live
//      connections, and with them every counter.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.ATPOTATO_DID = 'did:plc:qntsxa2i4sb24noi45fx4np2';
process.env.ATPOTATO_HANDLE = 'atpota.to';
process.env.DB_FILE = ':memory:';
process.env.STAGE = '1';
process.env.GATES_FILE = '/nonexistent-gates.json';
process.env.KILL_SWITCH_FILE = '/nonexistent-kill';
process.env.LOG_LEVEL = 'error';
process.env.JETSTREAM_URL = 'wss://fake.test';
process.env.RECONNECT_BASE_MS = '5';
process.env.RECONNECT_MAX_MS = '20';

class FakeWS {
  static instances = [];
  static reset() { FakeWS.instances = []; }
  constructor(url) {
    this.url = url;
    this.closed = false;
    FakeWS.instances.push(this);
  }
  close() { this.closed = true; }
  open() { this.onopen?.({}); }
  error() { this.onerror?.({}); }
  fireClose(code = 1006) { this.onclose?.({ code }); }
  message(payload) { this.onmessage?.({ data: JSON.stringify({ $type: 'message', payload }) }); }
}

const realWS = globalThis.WebSocket;
let connectJetstream, stream;
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const newStats = () => ({ received: 0, unparseable: 0, handlerErrors: 0 });

before(async () => {
  globalThis.WebSocket = FakeWS;
  ({ connectJetstream } = await import('../src/jetstream.js'));
});
beforeEach(() => FakeWS.reset());
after(() => { stream?.close(); globalThis.WebSocket = realWS; });

test('it connects to the configured host with the v2 endpoint and parameters', async () => {
  const events = [];
  stream = connectJetstream({ onEvent: (p) => events.push(p), stats: newStats() });
  assert.equal(FakeWS.instances.length, 1);
  const url = new URL(FakeWS.instances[0].url);
  assert.equal(url.pathname, '/xrpc/network.bsky.jetstream.subscribeEvents');
  assert.equal(url.searchParams.get('collections'), 'app.bsky.feed.post');
  assert.equal(url.searchParams.get('kinds'), 'commit');
  assert.equal(url.searchParams.get('cursor'), null, 'no stored cursor means the live tail');
  stream.close();
});

test('a failed upgrade that fires only `error` still reconnects', async () => {
  stream = connectJetstream({ onEvent: () => {}, stats: newStats() });
  assert.equal(FakeWS.instances.length, 1);

  // No open, no close -- exactly what a 503 upgrade produced in this runtime.
  FakeWS.instances[0].error();
  await tick(40);

  assert.ok(FakeWS.instances.length >= 2, 'an error alone must schedule a reconnect');
  stream.close();
});

test('a superseded socket firing a late close does NOT start a second chain', async () => {
  stream = connectJetstream({ onEvent: () => {}, stats: newStats() });
  const first = FakeWS.instances[0];

  first.error();              // settles attempt 1, schedules the reconnect
  await tick(40);
  assert.equal(FakeWS.instances.length, 2, 'exactly one reconnect');
  const second = FakeWS.instances[1];

  // The old socket now delivers its close, late. Before the fix this started a
  // whole second reconnect chain.
  first.fireClose(1006);
  await tick(40);

  assert.equal(FakeWS.instances.length, 2, 'a superseded socket must settle nothing');

  // And the current socket is still the one that works.
  second.open();
  await tick(10);
  second.error();
  await tick(40);
  assert.equal(FakeWS.instances.length, 3, 'the live socket still reconnects normally');
  stream.close();
});

test('a superseded socket still delivering messages is ignored', async () => {
  const stats = newStats();
  const seen = [];
  stream = connectJetstream({ onEvent: (p) => seen.push(p.rkey), stats });
  const first = FakeWS.instances[0];
  first.open();
  first.message({ collection: 'app.bsky.feed.post', operation: 'create', did: 'd', rkey: 'live', cid: 'c', seq: 1, record: { text: 'x' } });
  assert.deepEqual(seen, ['live']);

  first.error();
  await tick(40);
  const second = FakeWS.instances[1];
  second.open();

  first.message({ collection: 'app.bsky.feed.post', operation: 'create', did: 'd', rkey: 'ghost', cid: 'c', seq: 2, record: { text: 'x' } });
  second.message({ collection: 'app.bsky.feed.post', operation: 'create', did: 'd', rkey: 'current', cid: 'c', seq: 3, record: { text: 'x' } });

  assert.deepEqual(seen, ['live', 'current'], 'the replaced socket must not be double-counted');
  stream.close();
});

test('backoff grows and is capped', async () => {
  stream = connectJetstream({ onEvent: () => {}, stats: newStats() });
  for (let i = 0; i < 5; i++) {
    FakeWS.instances.at(-1).error();
    await tick(40);
  }
  // 5ms base doubling to a 20ms cap: the point is it reconnects every time and
  // never hot-loops, not the exact schedule.
  assert.ok(FakeWS.instances.length >= 5, 'keeps retrying');
  assert.ok(FakeWS.instances.length <= 8, 'one reconnect per failure, not a storm');
  stream.close();
});

test('close() stops reconnecting', async () => {
  stream = connectJetstream({ onEvent: () => {}, stats: newStats() });
  const first = FakeWS.instances[0];
  stream.close();
  first.error();
  first.fireClose(1006);
  await tick(40);
  assert.equal(FakeWS.instances.length, 1, 'a deliberate close must not reconnect');
});

test('malformed frames are counted, not thrown', async () => {
  const stats = newStats();
  stream = connectJetstream({ onEvent: () => {}, stats });
  const ws = FakeWS.instances[0];
  ws.open();
  assert.doesNotThrow(() => ws.onmessage({ data: 'not json' }));
  assert.equal(stats.unparseable, 1);
  assert.doesNotThrow(() => ws.onmessage({ data: '{"no":"payload"}' }));
  stream.close();
});

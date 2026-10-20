// The v2 client against scripted sockets: URLs, cursors, failover, stale cursors, recycling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKOFF_MS, CONNECT_TIMEOUT_MS, createJetstream, FAILURES_BEFORE_DROPPING_CURSOR, streamUrl } from '../src/jetstream.js';

const quiet = { info() {}, warn() {}, error() {} };
const A = 'wss://jetstream2.us-east.bsky.network';
const B = 'wss://jetstream1.us-east.bsky.network';
const RECYCLE_MS = 15 * 60_000;

const message = (seq, extra = {}) =>
  JSON.stringify({
    $type: 'message',
    payload: {
      $type: 'network.bsky.jetstream.subscribeEvents#commit',
      cid: 'bafyreiabcdefghijkl',
      collection: 'to.atpota.garden.tend',
      did: 'did:plc:abc',
      operation: 'create',
      record: {},
      rev: '3m4abcdefgh22',
      rkey: '3m4abcdefgh22',
      seq,
      time: '2026-10-20T22:48:21.567320Z',
      ...extra,
    },
  });

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.closed = false;
  }
  close() {
    this.closed = true;
  }
}

function harness({ cursors = {}, hosts = [A, B], beforeRecycle } = {}) {
  const clock = { ms: 1_792_512_000_000 };
  const saved = { ...cursors };
  const sockets = [];
  const timers = [];
  const events = [];
  const reconciles = [];
  const dropped = [];
  const jet = createJetstream({
    hosts,
    log: quiet,
    cursorFor: (h) => saved[h] ?? null,
    dropCursor: (h) => {
      dropped.push(h);
      delete saved[h];
    },
    onEvent: (payload, meta) => events.push({ payload, meta }),
    reconcile: (why) => reconciles.push(why),
    beforeRecycle,
    recycleMs: RECYCLE_MS,
    now: () => clock.ms,
    open: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      const i = timers.indexOf(t);
      if (i >= 0) timers.splice(i, 1);
    },
    setRepeat: () => 1,
    clearRepeat: () => {},
  });
  const fire = () => {
    const t = timers.shift();
    clock.ms += t.ms;
    t.fn();
  };
  const last = () => sockets.at(-1);
  return { jet, saved, sockets, timers, events, reconciles, dropped, fire, last, clock };
}

const parts = (s) => {
  const u = new URL(s.url);
  return { host: `${u.protocol}//${u.host}`, path: u.pathname, collections: u.searchParams.get('collections'), kinds: u.searchParams.get('kinds'), cursor: u.searchParams.get('cursor') };
};

test('the v2 URL: the garden wildcard, commits only, and the cursor when there is one', () => {
  assert.equal(streamUrl(A, null), `${A}/xrpc/network.bsky.jetstream.subscribeEvents?collections=to.atpota.garden.*&kinds=commit`);
  assert.equal(streamUrl(A, 26252275534), `${A}/xrpc/network.bsky.jetstream.subscribeEvents?collections=to.atpota.garden.*&kinds=commit&cursor=26252275534`);
  const h = harness({ cursors: { [A]: 41 } });
  h.jet.start();
  assert.deepEqual(parts(h.sockets[0]), { host: A, path: '/xrpc/network.bsky.jetstream.subscribeEvents', collections: 'to.atpota.garden.*', kinds: 'commit', cursor: '41' });
  const fresh = harness();
  fresh.jet.start();
  assert.equal(parts(fresh.sockets[0]).cursor, null);
});

test('starts on the host it holds a cursor for', () => {
  const h = harness({ cursors: { [B]: 7 } });
  h.jet.start();
  assert.deepEqual([parts(h.sockets[0]).host, parts(h.sockets[0]).cursor], [B, '7']);
  h.last().onopen();
  assert.deepEqual(h.reconciles, [], 'a cursor covers the gap; no reconcile');
});

test('hands each payload on with its host, seq and time; ignores what is not a message', () => {
  const h = harness();
  h.jet.start();
  h.last().onopen();
  h.last().onmessage({ data: message(100) });
  h.last().onmessage({ data: Buffer.from(message(101)) });
  h.last().onmessage({ data: '{nope' });
  h.last().onmessage({ data: JSON.stringify({ $type: 'info', payload: {} }) });
  assert.deepEqual(
    h.events.map((e) => e.meta),
    [
      { host: A, seq: 100, time: '2026-10-20T22:48:21.567320Z' },
      { host: A, seq: 101, time: '2026-10-20T22:48:21.567320Z' },
    ],
  );
  assert.equal(h.events[0].payload.collection, 'to.atpota.garden.tend');
  assert.equal(h.jet.counts.unparseable, 1);
  assert.equal(h.jet.counts.otherTypes, 1);
  assert.equal(h.jet.state.connected, true);
  assert.equal(h.jet.state.host, A);
  assert.ok(h.jet.state.lastMessageAt);
});

test('connecting from the live tail asks for a reconcile, once it is open', () => {
  const h = harness();
  h.jet.start();
  assert.deepEqual(h.reconciles, [], 'not before it opens: the pass must start after the stream does');
  h.last().onopen();
  assert.equal(h.reconciles.length, 1);
});

test('a host that fails to open, with no cursor, moves on to the next, which asks for a reconcile', () => {
  const h = harness();
  h.jet.start();
  h.sockets[0].onerror({});
  h.sockets[0].onclose({ code: 1006 });
  assert.equal(h.timers.length, 1, 'error and close settle once');
  assert.equal(h.timers[0].ms, BACKOFF_MS[0]);
  h.fire();
  assert.equal(parts(h.sockets[1]).host, B);
  h.sockets[1].onopen();
  assert.equal(h.reconciles.length, 1);
  assert.match(h.reconciles[0], /jetstream1/);
});

test('a connection that opened and dropped retries the same host, from its saved cursor', () => {
  const h = harness({ cursors: { [A]: 10 } });
  h.jet.start();
  h.last().onopen();
  h.last().onmessage({ data: message(11) });
  h.saved[A] = 11; // the indexer saved it
  h.last().onclose({ code: 1006 });
  h.fire();
  assert.deepEqual([parts(h.last()).host, parts(h.last()).cursor], [A, '11']);
});

test(`a stale cursor is dropped after ${FAILURES_BEFORE_DROPPING_CURSOR} failed opens, then the live tail and a reconcile`, () => {
  const h = harness({ cursors: { [A]: 5 } });
  h.jet.start();
  for (let i = 0; i < FAILURES_BEFORE_DROPPING_CURSOR - 1; i++) {
    h.last().onerror({});
    assert.deepEqual(h.dropped, []);
    h.fire();
    assert.deepEqual([parts(h.last()).host, parts(h.last()).cursor], [A, '5'], 'stays with the host its cursor belongs to');
  }
  h.last().onerror({});
  assert.deepEqual(h.dropped, [A]);
  assert.equal(h.timers[0].ms, BACKOFF_MS[0], 'backoff starts again');
  h.fire();
  assert.deepEqual([parts(h.last()).host, parts(h.last()).cursor], [A, null]);
  assert.deepEqual(h.reconciles, []);
  h.last().onopen();
  assert.equal(h.reconciles.length, 1, 'there may be a gap');
});

test('a host that is down even from the live tail is left for the next', () => {
  const h = harness({ cursors: { [A]: 5 } });
  h.jet.start();
  for (let i = 0; i < FAILURES_BEFORE_DROPPING_CURSOR; i++) {
    h.last().onerror({});
    h.fire();
  }
  assert.equal(parts(h.last()).cursor, null);
  h.last().onerror({});
  h.fire();
  assert.equal(parts(h.last()).host, B);
});

test('a socket that never opens times out', () => {
  const h = harness();
  h.jet.start();
  h.clock.ms += CONNECT_TIMEOUT_MS + 1;
  h.jet.check();
  assert.equal(h.sockets[0].closed, true);
  h.fire();
  assert.equal(parts(h.last()).host, B);
});

test('a late message or close from a replaced socket is ignored', () => {
  const h = harness();
  h.jet.start();
  const [a] = h.sockets;
  a.onopen();
  a.onmessage({ data: message(1) });
  a.onerror({});
  h.fire();
  const b = h.last();
  b.onopen();
  a.onmessage({ data: message(2) });
  a.onclose({});
  a.onerror({});
  assert.deepEqual(h.events.map((e) => e.meta.seq), [1]);
  assert.equal(h.timers.length, 0, 'no second reconnect chain');
  assert.equal(h.jet.state.connected, true);
});

test('recycles every RECYCLE_MINUTES: flush, close, reconnect from the saved cursor', async () => {
  let flushes = 0;
  const h = harness({
    cursors: { [A]: 20 },
    beforeRecycle: async () => {
      flushes++;
      h.saved[A] = 25; // what the flush saved
    },
  });
  h.jet.start();
  const first = h.last();
  first.onopen();
  first.onmessage({ data: message(25) });
  h.clock.ms += RECYCLE_MS - 1000;
  assert.equal(h.jet.check(), null);
  h.clock.ms += 1000;
  const recycling = h.jet.check();
  assert.ok(recycling);
  assert.equal(h.jet.check(), null, 'one recycle at a time');
  await recycling;
  assert.equal(flushes, 1);
  assert.equal(first.closed, true);
  assert.equal(h.sockets.length, 2);
  assert.deepEqual([parts(h.last()).host, parts(h.last()).cursor], [A, '25']);
  first.onclose({ code: 1000 });
  assert.equal(h.timers.length, 0, 'closing it ourselves starts no reconnect chain');
  h.last().onopen();
  assert.deepEqual(h.reconciles, []);
  assert.equal(h.jet.counts.recycles, 1);
});

test('a socket that dropped while flushing for a recycle is left to the reconnect chain', async () => {
  let release;
  const h = harness({ cursors: { [A]: 1 }, beforeRecycle: () => new Promise((r) => (release = r)) });
  h.jet.start();
  h.last().onopen();
  h.clock.ms += RECYCLE_MS;
  const recycling = h.jet.check();
  h.last().onclose({ code: 1006 });
  release();
  await recycling;
  assert.equal(h.sockets.length, 1, 'no extra socket');
  assert.equal(h.timers.length, 1, 'just the one reconnect');
});

test('stop closes the socket and schedules nothing', () => {
  const h = harness();
  h.jet.start();
  h.last().onopen();
  h.jet.stop();
  assert.equal(h.sockets[0].closed, true);
  h.sockets[0].onclose({});
  assert.equal(h.timers.length, 0);
  assert.equal(h.jet.state.connected, false);
});

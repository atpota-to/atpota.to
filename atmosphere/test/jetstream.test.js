// The consumer against scripted sockets: cursors, replays, fallback, stalls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJetstream, DEFAULT_URLS, REWIND_US, STALL_MS, withCursor } from '../src/jetstream.js';
import { Station } from '../src/station.js';

const T0 = 1_792_512_000;
const quiet = { info() {}, warn() {}, error() {} };
const msg = (timeUs, collection = 'app.bsky.feed.post') => JSON.stringify({ did: 'did:plc:x', time_us: timeUs, kind: 'commit', commit: { operation: 'create', collection, record: {} } });

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.closed = false;
  }
  close() {
    this.closed = true;
  }
}

function harness({ startCursorUs = null, maxReplaySeconds = 1800 } = {}) {
  const clock = { ms: (T0 + 100) * 1000 };
  const station = new Station({ now: () => clock.ms });
  const sockets = [];
  const timers = [];
  const jet = createJetstream({
    station,
    log: quiet,
    now: () => clock.ms,
    open: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    maxReplaySeconds,
    startCursorUs,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => timers.splice(timers.indexOf(t), 1),
    setRepeat: () => 1,
    clearRepeat: () => {},
  });
  const fire = () => timers.shift()?.fn();
  return { jet, station, sockets, timers, fire, clock };
}

const cursorOf = (s) => {
  const c = new URL(s.url).searchParams.get('cursor');
  return c === null ? null : Number(c);
};

test('asks Jetstream for everything, from the live tail, the first time', () => {
  const h = harness();
  h.jet.start();
  assert.equal(h.sockets.length, 1);
  const url = new URL(h.sockets[0].url);
  assert.equal(url.origin + url.pathname, 'wss://jetstream2.us-east.bsky.network/subscribe');
  assert.deepEqual([...url.searchParams.keys()], []);
  assert.equal(withCursor(DEFAULT_URLS[0], 5), 'wss://jetstream2.us-east.bsky.network/subscribe?cursor=5');
});

test('resumes 2 s before the last event after a drop, and replayed events are not counted twice', () => {
  const h = harness();
  h.jet.start();
  const [a] = h.sockets;
  a.onopen();
  const times = [];
  for (let t = T0; t < T0 + 20; t += 0.1) times.push(Math.round(t * 1e6));
  const cut = times.findIndex((t) => t > (T0 + 12.35) * 1e6);
  times.slice(0, cut).forEach((t) => a.onmessage({ data: msg(t) }));
  const lastUs = h.station.lastUs;
  a.onclose({ code: 1006 });
  assert.equal(h.station.connected, false);
  assert.equal(h.timers[0].ms, 1000);
  h.fire();
  const b = h.sockets[1];
  assert.equal(new URL(b.url).host, 'jetstream2.us-east.bsky.network', 'a connection that worked retries the same host');
  assert.equal(cursorOf(b), lastUs - REWIND_US);
  b.onopen();
  times.filter((t) => t >= cursorOf(b)).forEach((t) => b.onmessage({ data: msg(t) }));
  for (let s = T0 + 1; s <= T0 + 18; s++) {
    assert.equal(h.station.buckets.get(s).covered, true);
    assert.equal(h.station.buckets.get(s).tally.creates.get('app.bsky.feed.post'), 10, `second ${s}`);
  }
});

test('a late message from a replaced socket is ignored', () => {
  const h = harness();
  h.jet.start();
  const [a] = h.sockets;
  a.onopen();
  a.onmessage({ data: msg((T0 + 1) * 1e6) });
  a.onerror({});
  h.fire();
  const b = h.sockets[1];
  b.onopen();
  a.onmessage({ data: msg((T0 + 2) * 1e6) });
  a.onclose({});
  assert.equal(h.station.buckets.has(T0 + 2), false);
  assert.equal(h.timers.length, 0, 'no second reconnect chain');
  assert.equal(h.station.connected, true);
});

test('falls back to the second Jetstream when the first fails, backing off', () => {
  const h = harness();
  h.jet.start();
  h.sockets[0].onerror({});
  assert.equal(h.timers[0].ms, 1000);
  h.fire();
  assert.equal(new URL(h.sockets[1].url).host, 'jetstream1.us-east.bsky.network');
  h.sockets[1].onerror({});
  assert.equal(h.timers[0].ms, 2000);
  h.fire();
  assert.equal(new URL(h.sockets[2].url).host, 'jetstream2.us-east.bsky.network');
  h.sockets[2].onerror({});
  assert.equal(h.timers[0].ms, 4000);
  for (let i = 0; i < 6; i++) {
    h.fire();
    h.sockets.at(-1).onerror({});
  }
  assert.equal(h.timers[0].ms, 30000, 'backoff tops out at 30 s');
  // and resets once a connection delivers
  h.fire();
  h.sockets.at(-1).onopen();
  h.sockets.at(-1).onmessage({ data: msg((T0 + 1) * 1e6) });
  h.sockets.at(-1).onclose({});
  assert.equal(h.timers[0].ms, 1000);
});

test('a silent connection is dropped and replaced', () => {
  const h = harness();
  h.jet.start();
  h.sockets[0].onopen();
  h.sockets[0].onmessage({ data: msg((T0 + 99) * 1e6) });
  h.clock.ms += STALL_MS - 1000;
  h.jet.check();
  assert.equal(h.sockets[0].closed, false);
  h.clock.ms += 2000;
  h.jet.check();
  assert.equal(h.sockets[0].closed, true);
  assert.equal(h.station.connected, false);
  assert.equal(h.timers.length, 1);
});

test('a socket that never opens times out', () => {
  const h = harness();
  h.jet.start();
  h.clock.ms += 11_000;
  h.jet.check();
  assert.equal(h.sockets[0].closed, true);
  h.fire();
  assert.equal(new URL(h.sockets[1].url).host, 'jetstream1.us-east.bsky.network');
});

test('starts from a saved cursor, but never further back than allowed', () => {
  const h = harness({ startCursorUs: (T0 + 40) * 1e6 });
  h.jet.start();
  assert.equal(cursorOf(h.sockets[0]), (T0 + 40) * 1e6);
  const old = harness({ startCursorUs: (T0 - 5000) * 1e6, maxReplaySeconds: 600 });
  old.jet.start();
  assert.equal(cursorOf(old.sockets[0]), (T0 + 100 - 600) * 1e6);
});

test('stop closes the socket and schedules nothing', () => {
  const h = harness();
  h.jet.start();
  h.sockets[0].onopen();
  h.jet.stop();
  assert.equal(h.sockets[0].closed, true);
  h.sockets[0].onclose({});
  assert.equal(h.timers.length, 0);
  assert.equal(h.station.connected, false);
});

// The consumer against scripted sockets: cursors, replays, fallback, stalls, falling behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BEHIND_MS, CATCHUP_SAMPLE_MS, createJetstream, DEFAULT_URLS, REWIND_US, STALL_MS, WATCHDOG_MS, withCursor } from '../src/jetstream.js';
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

function harness({ startCursorUs = null, maxReplaySeconds = 1800, log = quiet } = {}) {
  const clock = { ms: (T0 + 100) * 1000 };
  const station = new Station({ now: () => clock.ms });
  const sockets = [];
  const timers = [];
  const jet = createJetstream({
    station,
    log,
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

/**
 * Plays a replay for `seconds` of wall time, a watchdog check every WATCHDOG_MS, the stream
 * moving `speed` times as fast as the clock (in tenths of a second), until the socket closes.
 */
function replay(h, sock, speed, seconds) {
  let streamUs = cursorOf(sock);
  for (let t = 0; t < seconds * 1000 && !sock.closed; t += WATCHDOG_MS) {
    const target = streamUs + WATCHDOG_MS * 1000 * speed;
    while (streamUs + 100_000 <= target && streamUs + 100_000 <= h.clock.ms * 1000) sock.onmessage({ data: msg((streamUs += 100_000)) });
    h.clock.ms += WATCHDOG_MS;
    h.jet.check();
  }
  return streamUs;
}

test('a replay that falls further behind is given up for the live tail, and the gap is logged', () => {
  const warnings = [];
  const h = harness({ startCursorUs: (T0 + 100 - 1500) * 1e6, log: { ...quiet, warn: (m, f) => warnings.push([m, f]) } });
  h.jet.start();
  const [a] = h.sockets;
  a.onopen();
  // a fifth of real time, as on 2026-10-21
  replay(h, a, 0.2, 120);
  assert.equal(a.closed, true, 'given up');
  assert.equal(h.station.connected, false);
  const [, why] = warnings.find(([m]) => m === 'jetstream too far behind, skipping to the live tail');
  assert.ok(why.behindSeconds > 1500);
  assert.equal(why.catchingUp, 0.2);
  assert.equal(why.gapFrom, new Date(h.station.lastUs / 1000).toISOString());
  const skippedAt = h.clock.ms;
  assert.ok(skippedAt - (T0 + 100) * 1000 <= BEHIND_MS + CATCHUP_SAMPLE_MS + 2 * WATCHDOG_MS, 'within about half a minute of watching');

  h.fire();
  const b = h.sockets[1];
  assert.equal(cursorOf(b), null, 'reconnects at the live tail');
  assert.equal(new URL(b.url).host, new URL(a.url).host, 'on the same host');
  b.onopen();
  const live = Math.floor(h.clock.ms / 1000) - 3;
  for (let us = live * 1e6; us <= (live + 2) * 1e6; us += 100_000) b.onmessage({ data: msg(us) });
  assert.equal(h.station.buckets.get(live + 1).covered, true, 'live seconds are counted');
  assert.equal(h.station.buckets.get(live + 1).tally.creates.get('app.bsky.feed.post'), 10);
  assert.equal(h.station.buckets.get(live - 60)?.covered ?? false, false, 'the gap is missing, not quiet');

  // once it's live, a drop resumes from a cursor again
  b.onclose({});
  h.fire();
  assert.equal(cursorOf(h.sockets[2]), h.station.lastUs - REWIND_US);
});

test('a replay that is catching up, but too slowly, is given up too', () => {
  const h = harness({ startCursorUs: (T0 + 100 - 1500) * 1e6 });
  h.jet.start();
  h.sockets[0].onopen();
  // 1.5 times real time would take 48 minutes to win back 24
  replay(h, h.sockets[0], 1.5, 120);
  assert.equal(h.sockets[0].closed, true);
  h.fire();
  assert.equal(cursorOf(h.sockets[1]), null);
});

test('a replay that is catching up quickly is left to finish', () => {
  const h = harness({ startCursorUs: (T0 + 100 - 1500) * 1e6 });
  h.jet.start();
  const [a] = h.sockets;
  a.onopen();
  // after a restart: 25 minutes back at 10 times real time is under 3 minutes
  const streamUs = replay(h, a, 10, 240);
  assert.equal(a.closed, false);
  assert.ok(h.clock.ms * 1000 - streamUs < 5e6, 'caught up, within a few seconds of live');
});

test('a short lag after a reconnect never trips it', () => {
  const h = harness();
  h.jet.start();
  const [a] = h.sockets;
  a.onopen();
  a.onmessage({ data: msg((h.clock.ms - BEHIND_MS + 5000) * 1000) });
  // the stream crawls, but is never a minute behind
  for (let i = 0; i < 40; i++) {
    a.onmessage({ data: msg((h.clock.ms - BEHIND_MS + 5000) * 1000) });
    h.clock.ms += WATCHDOG_MS;
    h.jet.check();
  }
  assert.equal(a.closed, false);
});

test('a live-tail connection that fails before it delivers still goes to the live tail next', () => {
  const h = harness({ startCursorUs: (T0 + 100 - 1500) * 1e6 });
  h.jet.start();
  h.sockets[0].onopen();
  replay(h, h.sockets[0], 0.2, 120);
  h.fire();
  h.sockets[1].onerror({});
  h.fire();
  assert.equal(cursorOf(h.sockets[2]), null);
});

// The batcher: last event wins, chunks, cursors saved only after success, retries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHUNK, createIndexer, FLUSH_AT, FLUSH_MS, MAX_REJECTED_TRIES, RETRY_MS } from '../src/indexer.js';
import { createStore } from '../src/state.js';

const quiet = { info() {}, warn() {}, error() {} };
const H = 'wss://jetstream2.us-east.bsky.network';
const uri = (n) => `at://did:plc:aaaa/to.atpota.garden.tend/${String(n).padStart(13, 'a')}`;
const down = () => Object.assign(new Error('rpc/garden_apply: HTTP 503'), { status: 503 });
const up = (n, extra = {}) => ({ op: 'upsert', row: { uri: uri(n), n, ...extra } });
const del = (n) => ({ op: 'delete', uri: uri(n) });

function harness({ fail = () => null } = {}) {
  const clock = { ms: 1_792_512_000_000 };
  const timers = [];
  const calls = [];
  const store = createStore(null, quiet);
  const rpc = async (name, args) => {
    calls.push({ name, args: structuredClone(args) });
    const err = fail(calls.length, args);
    if (err) throw err;
    return 1;
  };
  const indexer = createIndexer({
    rpc,
    store,
    log: quiet,
    now: () => clock.ms,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      const i = timers.indexOf(t);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const fire = async () => {
    const t = timers.shift();
    clock.ms += t.ms;
    t.fn();
    await new Promise((r) => setImmediate(r));
  };
  return { indexer, store, calls, timers, fire, clock };
}

test('a URI\'s last event wins, so a batch never both upserts and deletes it', async () => {
  const h = harness();
  h.indexer.add(up(1), { host: H, seq: 10, time: '2026-10-20T22:48:21.567320Z' });
  h.indexer.add(up(2), { host: H, seq: 11 });
  h.indexer.add(del(1), { host: H, seq: 12 });
  h.indexer.add(up(2, { edited: true }), { host: H, seq: 13 });
  h.indexer.add(del(3), { host: H, seq: 14, time: '2026-10-20T22:48:25.000000Z' });
  assert.equal(h.indexer.pending, 3);
  assert.equal(h.calls.length, 0, 'waits for the timer');
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, FLUSH_MS);
  await h.fire();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].name, 'garden_apply');
  assert.deepEqual(h.calls[0].args, { p_upserts: [{ uri: uri(2), n: 2, edited: true }], p_deletes: [uri(1), uri(3)] });
  assert.equal(h.indexer.pending, 0);
  assert.deepEqual(h.store.snapshot.cursors, { [H]: 14 });
  assert.equal(h.indexer.streamAt, '2026-10-20T22:48:25.000Z');
  assert.equal(h.timers.length, 0, 'nothing left to flush');
});

test('sends at once at 200 pending, 500 URIs a call', async () => {
  const h = harness();
  for (let i = 0; i < FLUSH_AT - 1; i++) h.indexer.add(up(i), { host: H, seq: i + 1 });
  assert.equal(h.calls.length, 0);
  h.indexer.add(up(FLUSH_AT), { host: H, seq: FLUSH_AT });
  await h.indexer.flush();
  assert.equal(h.calls.length, 1, 'flushed without waiting for the timer');
  assert.equal(h.calls[0].args.p_upserts.length, FLUSH_AT);

  // More than a chunk waiting: the flush at 200 fails, so the rest pile up behind it
  // (backoff), and the next flush sends them all.
  const big = harness({ fail: (n) => (n === 1 ? down() : null) });
  for (let i = 0; i < CHUNK * 2 + 7; i++) big.indexer.add(i % 3 ? up(i) : del(i), { host: H, seq: i + 1 });
  await big.indexer.flush();
  const sent = big.calls.slice(1);
  const sizes = sent.map((c) => c.args.p_upserts.length + c.args.p_deletes.length);
  assert.deepEqual(sizes, [CHUNK, CHUNK, 7]);
  const all = sent.flatMap((c) => [...c.args.p_upserts.map((r) => r.uri), ...c.args.p_deletes]);
  assert.equal(new Set(all).size, all.length, 'each URI in one chunk');
  assert.equal(big.indexer.pending, 0);
  assert.deepEqual(big.store.snapshot.cursors, { [H]: CHUNK * 2 + 7 });
});

test('the cursor is saved only once every chunk has gone, and a failure keeps everything pending', async () => {
  // call 1: the flush at 200 (down); call 2: the first chunk (fine); call 3: the second (down)
  const h = harness({ fail: (n) => (n === 1 || n === 3 ? down() : null) });
  for (let i = 0; i < CHUNK + 10; i++) h.indexer.add(up(i), { host: H, seq: 100 + i });
  assert.equal(h.calls.length, 1);
  assert.equal(await h.indexer.flush(), false);
  assert.equal(h.calls.length, 3, 'the first chunk went, the second failed');
  assert.equal(h.indexer.pending, CHUNK + 10, 'nothing dropped');
  assert.deepEqual(h.store.snapshot.cursors, {}, 'no cursor saved');
  assert.equal(h.indexer.lastFlushAt, null);
  // retried with backoff
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, RETRY_MS[1]);
  await h.fire();
  assert.equal(h.calls.length, 5, 'both chunks again');
  assert.equal(h.indexer.pending, 0);
  assert.deepEqual(h.store.snapshot.cursors, { [H]: 100 + CHUNK + 9 });
  assert.ok(h.indexer.lastFlushAt);
});

test('backoff doubles to 30 s, and resets after a success', async () => {
  let down = true;
  const h = harness({ fail: () => (down ? Object.assign(new Error('down'), { status: 0 }) : null) });
  h.indexer.add(up(1), { host: H, seq: 1 });
  const waits = [];
  for (let i = 0; i < 8; i++) {
    await h.fire();
    waits.push(h.timers[0].ms);
  }
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  down = false;
  await h.fire();
  assert.equal(h.indexer.pending, 0);
  h.indexer.add(up(2), { host: H, seq: 2 });
  assert.equal(h.timers[0].ms, FLUSH_MS);
});

test('events that arrive during a flush wait for the next one, and win', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const store = createStore(null, quiet);
  const calls = [];
  const indexer = createIndexer({
    rpc: async (name, args) => {
      calls.push(structuredClone(args));
      if (calls.length === 1) await gate;
    },
    store,
    log: quiet,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  indexer.add(up(1), { host: H, seq: 5 });
  const first = indexer.flush();
  indexer.add(del(1), { host: H, seq: 6 });
  release();
  await first;
  assert.deepEqual(store.snapshot.cursors, { [H]: 5 }, 'the first flush saves only what it sent');
  assert.equal(indexer.pending, 1, 'the delete is still pending');
  await indexer.flush();
  assert.deepEqual(calls[1], { p_upserts: [], p_deletes: [uri(1)] });
  assert.deepEqual(store.snapshot.cursors, { [H]: 6 });
});

test('a seq with no garden event still moves the cursor, without calling Supabase', async () => {
  const h = harness();
  h.indexer.add(null, { host: H, seq: 77 });
  await h.fire();
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.store.snapshot.cursors, { [H]: 77 });
});

test('a forgotten host\'s unsaved seq is never saved', async () => {
  const h = harness();
  h.indexer.add(up(1), { host: H, seq: 9 });
  h.indexer.add(up(2), { host: 'wss://other', seq: 3 });
  h.indexer.forget(H);
  await h.indexer.flush();
  assert.deepEqual(h.store.snapshot.cursors, { 'wss://other': 3 });
});

test('rows Supabase keeps refusing are applied one at a time, and only the bad one is dropped', async () => {
  const bad = uri(2);
  const h = harness({
    fail: (_n, args) => (args.p_upserts.some((r) => r.uri === bad) ? Object.assign(new Error('rpc/garden_apply: HTTP 400 22P02'), { status: 400 }) : null),
  });
  h.indexer.add(up(1), { host: H, seq: 1 });
  h.indexer.add(up(2), { host: H, seq: 2 });
  h.indexer.add(del(3), { host: H, seq: 3 });
  for (let i = 1; i < MAX_REJECTED_TRIES; i++) {
    assert.equal(await h.indexer.flush(), false);
    assert.equal(h.indexer.pending, 3);
  }
  assert.equal(await h.indexer.flush(), true);
  assert.equal(h.indexer.pending, 0);
  assert.equal(h.indexer.counts.dropped, 1);
  assert.deepEqual(h.store.snapshot.cursors, { [H]: 3 });
  const singles = h.calls.slice(MAX_REJECTED_TRIES);
  assert.deepEqual(
    singles.map((c) => [...c.args.p_upserts.map((r) => r.uri), ...c.args.p_deletes]),
    [[uri(1)], [uri(2)], [uri(3)]],
  );
});

test('a wrong key (401) is never mistaken for a bad row', async () => {
  const h = harness({ fail: () => Object.assign(new Error('HTTP 401'), { status: 401 }) });
  h.indexer.add(up(1), { host: H, seq: 1 });
  for (let i = 0; i < MAX_REJECTED_TRIES + 2; i++) await h.indexer.flush();
  assert.equal(h.indexer.pending, 1);
  assert.equal(h.indexer.counts.dropped, 0);
});

test('remembers what the stream touched, for a reconcile to leave alone', () => {
  const h = harness();
  const t0 = h.clock.ms;
  h.indexer.add(up(1), { host: H, seq: 1 });
  assert.equal(h.indexer.touchedSince(uri(1), t0), true);
  assert.equal(h.indexer.touchedSince(uri(1), t0 + 1), false);
  assert.equal(h.indexer.touchedSince(uri(2), 0), false);
});

// The minute writer: when a minute is sealed, what's written, retries and idempotence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Station } from '../src/station.js';
import { createWriter, minuteRows, MAX_REJECTED_TRIES, supabaseUpsert } from '../src/writer.js';
import { emptyTally, addEvent } from '../src/atmosphere.js';

const T0 = 1_792_512_000;
const quiet = { info() {}, warn() {}, error() {} };

function setup({ upsert, from = T0 - 0.5, to = T0 + 75, nowSec = T0 + 76 } = {}) {
  const clock = { ms: nowSec * 1000 };
  const station = new Station({ now: () => clock.ms });
  station.beginSession();
  const kinds = ['app.bsky.feed.post', 'app.bsky.feed.like', 'sh.tangled.repo', 'sh.tangled.feed.star', 'sh.tangled.feed.star', 'com.whtwnd.blog.entry'];
  // ten events a second, on whole tenths (no float drift across second boundaries)
  for (let k = Math.round(from * 10), i = 0; k <= Math.round(to * 10); k++, i++) station.ingest(k * 100_000, { kind: 'create', collection: kinds[i % kinds.length] });
  const written = [];
  const writer = createWriter({ station, log: quiet, startMinute: T0, now: () => clock.ms, upsert: upsert ?? (async (rows) => written.push(rows)), onWritten: (m) => written.push(m) });
  return { station, writer, written, clock };
}

test('one minute\'s rows: raw counts, the split, and its apps busiest first', () => {
  const tally = emptyTally();
  const add = (collection, n) => {
    for (let k = 0; k < n; k++) addEvent(tally, { kind: 'create', collection });
  };
  add('app.bsky.feed.post', 30);
  add('app.bsky.feed.like', 100);
  add('chat.bsky.convo.message', 2);
  add('sh.tangled.repo', 1);
  add('sh.tangled.feed.star', 4);
  add('com.whtwnd.blog.entry', 2);
  addEvent(tally, { kind: 'delete' });
  addEvent(tally, { kind: 'account' });
  tally.unnamed = 3;
  const rows = minuteRows(T0, tally, 58);
  assert.deepEqual(rows.minute, {
    minute: '2026-10-20T16:00:00.000Z',
    seconds_covered: 58,
    creates: 142,
    bluesky: 132,
    elsewhere: 10,
    posts: 30,
    likes: 100,
    reposts: 0,
    follows: 0,
    updates: 0,
    deletes: 1,
    identity: 0,
    account: 1,
    collections: 6,
    apps: 2,
  });
  assert.equal(rows.minute.bluesky + rows.minute.elsewhere, rows.minute.creates);
  assert.deepEqual(rows.apps, [
    { minute: '2026-10-20T16:00:00.000Z', domain: 'tangled.sh', creates: 5, collections: ['sh.tangled.feed.star', 'sh.tangled.repo'] },
    { minute: '2026-10-20T16:00:00.000Z', domain: 'whtwnd.com', creates: 2, collections: ['com.whtwnd.blog.entry'] },
  ]);
});

test('writes a minute once the stream is a minute past it, in case a backlog still adds to it', async () => {
  const h = setup({ nowSec: T0 + 76, to: T0 + 75 });
  await h.writer.tick();
  assert.equal(h.written.length, 0, 'records after a pause can still land in it');
  h.clock.ms = (T0 + 121) * 1000;
  for (let k = (T0 + 75) * 10 + 1; k <= (T0 + 120) * 10; k++) h.station.ingest(k * 100_000, null);
  await h.writer.tick();
  assert.equal(h.written.length, 2);
  assert.equal(h.written[0].minute.minute, '2026-10-20T16:00:00.000Z');
  assert.equal(h.written[0].minute.seconds_covered, 60);
  assert.equal(h.written[0].minute.creates, 600);
  assert.equal(h.written[1], T0, 'reports the minute written');
  await h.writer.tick();
  assert.equal(h.written.length, 2, 'once');
});

test('waits for a reconnect to replay a minute it missed, then writes it whole', async () => {
  const h = setup({ to: T0 + 40, nowSec: T0 + 90 });
  h.station.endSession();
  await h.writer.tick();
  assert.equal(h.written.length, 0, 'the stream has not got past the minute');
  h.station.beginSession({ dropThroughUs: h.station.lastUs });
  h.clock.ms = (T0 + 126) * 1000;
  for (let k = (T0 + 38) * 10; k <= (T0 + 125) * 10; k++) h.station.ingest(k * 100_000, { kind: 'create', collection: 'app.bsky.feed.post' });
  await h.writer.tick();
  assert.equal(h.written[0].minute.seconds_covered, 60);
});

test('writes a partly covered minute with its real coverage, and skips an uncovered one', async () => {
  const h = setup({ from: T0 + 29.5, to: T0 + 260, nowSec: T0 + 260 });
  await h.writer.tick();
  const minutes = h.written.filter((w) => typeof w === 'object').map((w) => [w.minute.minute, w.minute.seconds_covered]);
  assert.deepEqual(minutes, [
    ['2026-10-20T16:00:00.000Z', 30],
    ['2026-10-20T16:01:00.000Z', 60],
    ['2026-10-20T16:02:00.000Z', 60],
  ]);

  const gap = setup({ from: T0 + 70.5, to: T0 + 260, nowSec: T0 + 260 });
  await gap.writer.tick();
  const written = gap.written.filter((w) => typeof w === 'object').map((w) => w.minute.minute);
  assert.deepEqual(written, ['2026-10-20T16:01:00.000Z', '2026-10-20T16:02:00.000Z'], 'the minute with no coverage is not written');
});

test('a failed write is retried with backoff, oldest minute first', async () => {
  let fail = 2;
  const attempts = [];
  const h = setup({
    to: T0 + 260,
    nowSec: T0 + 260,
    upsert: async (rows) => {
      attempts.push(rows.minute.minute);
      if (fail-- > 0) throw new Error('HTTP 503');
    },
  });
  await h.writer.tick();
  assert.equal(h.writer.pending, 3);
  await h.writer.tick();
  assert.equal(attempts.length, 1, 'waits out the backoff');
  h.clock.ms += 1000;
  await h.writer.tick();
  assert.equal(attempts.length, 2);
  h.clock.ms += 2000;
  await h.writer.tick();
  assert.deepEqual(attempts, ['2026-10-20T16:00:00.000Z', '2026-10-20T16:00:00.000Z', '2026-10-20T16:00:00.000Z', '2026-10-20T16:01:00.000Z', '2026-10-20T16:02:00.000Z']);
  assert.equal(h.writer.pending, 0);
  assert.deepEqual(h.written, [T0, T0 + 60, T0 + 120]);
});

test('a minute Supabase keeps rejecting as bad data is dropped, not left blocking the queue', async () => {
  const attempts = [];
  const h = setup({
    to: T0 + 200,
    nowSec: T0 + 200,
    upsert: async (rows) => {
      attempts.push(rows.minute.minute);
      if (rows.minute.minute.endsWith('16:00:00.000Z')) throw Object.assign(new Error('HTTP 400'), { status: 400 });
    },
  });
  for (let k = 0; k < MAX_REJECTED_TRIES; k++) {
    await h.writer.tick();
    h.clock.ms += 60_000;
  }
  assert.ok(h.written.includes(T0 + 60));
  assert.equal(h.written.includes(T0), false);
});

test('upserts on the primary keys, minute first, so a rewrite is idempotent', async () => {
  const calls = [];
  const db = new Map();
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const table = new URL(url).pathname.split('/').pop();
    const conflict = new URL(url).searchParams.get('on_conflict').split(',');
    for (const row of JSON.parse(init.body)) db.set(`${table}:${conflict.map((k) => row[k]).join('|')}`, row);
    return new Response(null, { status: 201 });
  };
  const upsert = supabaseUpsert({ url: 'https://example.supabase.co/', key: 'service-key', fetch });
  const h = setup({ to: T0 + 75, nowSec: T0 + 76 });
  const { tally, seconds } = h.station.minute(T0);
  const rows = minuteRows(T0, tally, seconds);
  await upsert(rows);
  await upsert(rows);
  assert.equal(db.size, 1 + rows.apps.length, 'the same rows, not twice as many');
  assert.equal(calls[0].url, 'https://example.supabase.co/rest/v1/atmosphere_minute?on_conflict=minute');
  assert.equal(calls[1].url, 'https://example.supabase.co/rest/v1/atmosphere_minute_app?on_conflict=minute%2Cdomain'.replace('%2C', ','));
  assert.equal(calls[0].init.headers.prefer, 'resolution=merge-duplicates,return=minimal');
  assert.equal(calls[0].init.headers.apikey, 'service-key');
  assert.equal(calls[0].init.headers.authorization, 'Bearer service-key');

  const failing = supabaseUpsert({ url: 'https://example.supabase.co', key: 'k', fetch: async () => new Response('{"code":"23514"}', { status: 400 }) });
  await assert.rejects(failing(rows), (err) => err.status === 400 && /atmosphere_minute: HTTP 400/.test(err.message));
});

test('a pause and a backlog after it: the minute is written as it happened, not as it arrived', async () => {
  // The 17:37 case: the stream goes quiet for 25 s, then lets out the backlog, stamped
  // late, each record carrying when it was really made (atUs, from its rev).
  const clock = { ms: (T0 + 186) * 1000 };
  const station = new Station({ now: () => clock.ms });
  station.beginSession();
  const post = { kind: 'create', collection: 'app.bsky.feed.post' };
  for (let k = (T0 - 1) * 10; k <= (T0 + 35) * 10; k++) station.ingest(k * 100_000, post);
  for (let k = (T0 + 35) * 10 + 1; k < (T0 + 60) * 10; k++) station.ingest((T0 + 60) * 1e6 + (k % 100) * 1000, post, k * 100_000);
  for (let k = (T0 + 60) * 10; k <= (T0 + 185) * 10; k++) station.ingest(k * 100_000, post);
  const written = [];
  const writer = createWriter({ station, log: quiet, startMinute: T0, now: () => clock.ms, upsert: async (rows) => written.push(rows) });
  await writer.tick();
  assert.equal(written[0].minute.creates, 600, 'ten a second, all minute long');
  assert.equal(written[1].minute.creates, 600, 'and the backlog not piled into the next minute');
});

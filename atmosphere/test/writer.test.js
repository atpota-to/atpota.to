// The minute writer: when a minute is sealed, what's written, retries and idempotence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Station } from '../src/station.js';
import { createWriter, MAX_ACCOUNT_TRIES, minuteRows, MAX_REJECTED_TRIES, supabaseUpsert } from '../src/writer.js';
import { emptyTally, addEvent } from '../src/atmosphere.js';
import { registerOf, Sketch } from '../src/hll.js';

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

test('writes a minute about 15 s after it ends, once the stream is past it', async () => {
  const h = setup({ nowSec: T0 + 74, to: T0 + 73 });
  await h.writer.tick();
  assert.equal(h.written.length, 0, 'not before 15 s');
  h.clock.ms = (T0 + 75) * 1000;
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
  for (let k = (T0 + 38) * 10; k <= (T0 + 90) * 10; k++) h.station.ingest(k * 100_000, { kind: 'create', collection: 'app.bsky.feed.post' });
  await h.writer.tick();
  assert.equal(h.written[0].minute.seconds_covered, 60);
});

test('writes a partly covered minute with its real coverage, and skips an uncovered one', async () => {
  const h = setup({ from: T0 + 29.5, to: T0 + 200, nowSec: T0 + 200 });
  await h.writer.tick();
  const minutes = h.written.filter((w) => typeof w === 'object').map((w) => [w.minute.minute, w.minute.seconds_covered]);
  assert.deepEqual(minutes, [
    ['2026-10-20T16:00:00.000Z', 30],
    ['2026-10-20T16:01:00.000Z', 60],
    ['2026-10-20T16:02:00.000Z', 60],
  ]);

  const gap = setup({ from: T0 + 70.5, to: T0 + 200, nowSec: T0 + 200 });
  await gap.writer.tick();
  const written = gap.written.filter((w) => typeof w === 'object').map((w) => w.minute.minute);
  assert.deepEqual(written, ['2026-10-20T16:01:00.000Z', '2026-10-20T16:02:00.000Z'], 'the minute with no coverage is not written');
});

test('a failed write is retried with backoff, oldest minute first', async () => {
  let fail = 2;
  const attempts = [];
  const h = setup({
    to: T0 + 200,
    nowSec: T0 + 200,
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

/** A fake PostgREST: upserts by primary key, GETs answered from the same tables (eq/gte/lt filters only). */
function fakeSupabase() {
  const tables = new Map();
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const table = u.pathname.split('/').pop();
    calls.push({ method: init.method ?? 'GET', table, url, init });
    const rows = tables.get(table) ?? new Map();
    tables.set(table, rows);
    if (init.method === 'POST') {
      const conflict = u.searchParams.get('on_conflict').split(',');
      for (const row of JSON.parse(init.body)) rows.set(conflict.map((k) => row[k]).join('|'), row);
      return new Response(null, { status: 201 });
    }
    let out = [...rows.values()];
    for (const [k, v] of u.searchParams) {
      const [op, ...rest] = v.split('.');
      const arg = rest.join('.');
      const iso = (x) => (Number.isFinite(Date.parse(x)) ? Date.parse(x) : x);
      if (op === 'eq') out = out.filter((r) => String(iso(r[k])) === String(iso(arg)));
      if (op === 'gte') out = out.filter((r) => iso(r[k]) >= iso(arg));
      if (op === 'lt') out = out.filter((r) => iso(r[k]) < iso(arg));
    }
    const offset = Number(u.searchParams.get('offset') ?? 0);
    return Response.json(out.slice(offset, offset + Number(u.searchParams.get('limit') ?? 1000)));
  };
  return { fetch, calls, tables, rows: (table) => [...(tables.get(table)?.values() ?? [])] };
}

/** A station that heard `perSecond` events a second from `from` to `to`, by `who(i)` (account) and `what(i)` (collection). */
function heard({ from, to, who, what = () => 'app.bsky.feed.like', nowSec = to + 1 }) {
  const clock = { ms: nowSec * 1000 };
  const station = new Station({ now: () => clock.ms });
  station.beginSession();
  for (let k = Math.round(from * 10), i = 0; k <= Math.round(to * 10); k++, i++) {
    const collection = what(i);
    const app = collection.startsWith('app.bsky.') ? null : collection === 'sh.tangled.repo' ? 'tangled.sh' : 'whtwnd.com';
    station.ingest(k * 100_000, { kind: 'create', collection }, { register: registerOf(who(i)), app });
  }
  return { station, clock };
}

test('with accounts: their counts on the rows, the minute\'s sketches, and its hour, day and month', async () => {
  const kinds = ['app.bsky.feed.post', 'app.bsky.feed.like', 'sh.tangled.repo', 'com.whtwnd.blog.entry'];
  const { station } = heard({
    from: T0 - 0.5,
    to: T0 + 75,
    what: (i) => kinds[i % kinds.length],
    who: (i) => `did:plc:${['b', 'b', 't', 'w'][i % 4]}${i % 12}`,
  });
  const { tally, seconds, accounts } = station.minute(T0);
  const rows = minuteRows(T0, tally, seconds, accounts);
  assert.deepEqual([rows.minute.dids, rows.minute.dids_bluesky, rows.minute.dids_elsewhere], [12, 6, 6]);
  assert.deepEqual(
    rows.apps.map((a) => [a.domain, a.dids]),
    [
      ['tangled.sh', 3],
      ['whtwnd.com', 3],
    ],
  );
  assert.equal(rows.accounts.minute, T0);
  assert.equal(Sketch.decode(rows.accounts.bluesky).estimate(), 6);

  const db = fakeSupabase();
  const upsert = supabaseUpsert({ url: 'https://example.supabase.co', key: 'service-key', fetch: db.fetch });
  await upsert(rows);
  const sketches = db.rows('atmosphere_account_sketch');
  assert.deepEqual(sketches.map((r) => r.period), ['minute']); // 16:00 isn't a fifth minute: the hour, day and month wait
  assert.deepEqual(
    { ...sketches[0], bluesky: undefined, elsewhere: undefined },
    { period: 'minute', t: '2026-10-20T16:00:00.000Z', through: '2026-10-20T16:00:00.000Z', seconds: 60, dids: 12, dids_bluesky: 6, dids_elsewhere: 6, bluesky: undefined, elsewhere: undefined },
  );
  assert.match(sketches[0].bluesky, /^\\x020c/);
  assert.deepEqual(db.rows('atmosphere_account_app_sketch').map((r) => [r.period, r.domain, r.dids]).sort(), [
    ['minute', 'tangled.sh', 3],
    ['minute', 'whtwnd.com', 3],
  ]);
  for (const c of db.calls.filter((c) => c.method === 'POST')) assert.equal(c.init.headers.prefer, 'resolution=merge-duplicates,return=minimal');
  assert.equal(db.calls.find((c) => c.method === 'GET').init.headers.authorization, 'Bearer service-key');
});

test('hours, days and months: every fifth minute, merged once, and picked up again after a restart', async () => {
  const db = fakeSupabase();
  const write = (upsert, station, minute) => {
    const { tally, seconds, accounts } = station.minute(minute);
    return upsert(minuteRows(minute, tally, seconds, accounts));
  };
  // 16:00 to 16:09, ten events a second and a new account every three seconds
  const { station } = heard({ from: T0 - 0.5, to: T0 + 10 * 60 + 1, who: (i) => `did:plc:m${Math.floor(i / 30)}` });
  const upsert = supabaseUpsert({ url: 'https://example.supabase.co', key: 'k', fetch: db.fetch });
  for (let m = 0; m < 5; m++) await write(upsert, station, T0 + m * 60);
  const after5 = db.rows('atmosphere_account_sketch').filter((r) => r.period !== 'minute');
  assert.deepEqual(after5.map((r) => r.period).sort(), ['day', 'hour', 'month']);
  const hour = after5.find((r) => r.period === 'hour');
  assert.equal(hour.t, '2026-10-20T16:00:00.000Z');
  assert.equal(hour.through, '2026-10-20T16:04:00.000Z');
  assert.equal(hour.seconds, 300);
  const accountsUpTo = (n) => new Sketch().addAll(Array.from({ length: n + 1 }, (_, i) => registerOf(`did:plc:m${i}`))).estimate();
  assert.equal(hour.dids, accountsUpTo(100)); // 16:00:00 to 16:04:59.9: accounts m0 … m100, merged as one sketch would have them
  assert.equal(after5.find((r) => r.period === 'month').t, '2026-10-01T00:00:00.000Z');

  // the same minute again (a retry) changes nothing
  await write(upsert, station, T0 + 4 * 60);
  assert.equal(db.rows('atmosphere_account_sketch').find((r) => r.period === 'hour').seconds, 300);

  // 16:05 is written as a minute only; then the station restarts
  await write(upsert, station, T0 + 5 * 60);
  const restarted = supabaseUpsert({ url: 'https://example.supabase.co', key: 'k', fetch: db.fetch });
  await write(restarted, station, T0 + 6 * 60);
  for (let m = 7; m < 10; m++) await write(restarted, station, T0 + m * 60); // up to 16:09, the next fifth minute
  const later = db.rows('atmosphere_account_sketch').find((r) => r.period === 'hour');
  assert.equal(later.through, '2026-10-20T16:09:00.000Z');
  assert.equal(later.seconds, 600, 'ten whole minutes: nothing twice, and 16:05 not lost');
  assert.equal(later.dids, accountsUpTo(200));
  assert.deepEqual(db.rows('atmosphere_account_sketch').filter((r) => r.period !== 'minute').map((r) => r.seconds), [600, 600, 600]);
});

test('without accounts there are no account fields and no sketches', () => {
  const tally = emptyTally();
  addEvent(tally, { kind: 'create', collection: 'sh.tangled.repo' });
  const rows = minuteRows(T0, tally, 60);
  assert.equal(rows.sketches, undefined);
  assert.equal('dids' in rows.minute, false);
  assert.equal('dids' in rows.apps[0], false);
});

test('accounts that will not go never hold up records', async () => {
  const db = fakeSupabase();
  const broken = async (url, init) => (new URL(url).pathname.includes('atmosphere_account_') ? new Response('{"message":"permission denied"}', { status: 401 }) : db.fetch(url, init));
  const upsert = supabaseUpsert({ url: 'https://example.supabase.co', key: 'k', fetch: broken });
  const { station, clock } = heard({ from: T0 - 0.5, to: T0 + 75, who: (i) => `did:plc:q${i % 7}` });
  const errors = [];
  const writer = createWriter({ station, log: { info() {}, warn() {}, error: (msg) => errors.push(msg) }, startMinute: T0, now: () => clock.ms, upsert });
  for (let k = 0; k < MAX_ACCOUNT_TRIES; k++) {
    await writer.tick();
    clock.ms += 60_000;
  }
  assert.equal(writer.pending, 0);
  assert.deepEqual(errors, ['minute accounts dropped: could not be written']);
  assert.equal(db.rows('atmosphere_minute').length, 1, 'the minute itself is written');
  assert.equal(db.rows('atmosphere_minute')[0].dids, 7);
});

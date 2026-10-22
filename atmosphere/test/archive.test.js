// Backfilling from Jetstream v2's archive: times, the segment plan, counting, writing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eventOfMessage } from '../src/atmosphere.js';
import { accountOf } from '../src/accounts.js';
import { archiveWindow, backfill, listSegments, loadSdk, messageOf, parseArgs, planRange, sketchStore, timeUsOf } from '../src/archive.js';

const DAY = 1_791_331_200; // 2026-10-07T00:00:00Z
const ALPHABET = '234567abcdefghijklmnopqrstuvwxyz';
function tid(us) {
  let v = BigInt(us) << 10n;
  let s = '';
  for (let i = 0; i < 13; i++) {
    s = ALPHABET[Number(v & 31n)] + s;
    v >>= 5n;
  }
  return s;
}
/** The SDK's time format: UTC, exactly six fractional digits. */
function timeOf(us) {
  const sec = Math.floor(us / 1e6);
  return `${new Date(sec * 1000).toISOString().slice(0, 19)}.${String(us - sec * 1e6).padStart(6, '0')}Z`;
}
let seq = 1000;
/** An archive event the way the SDK's raw snapshot hands it over. */
function event(us, { collection = 'app.bsky.feed.like', operation = 'create', revUs = us, kind = 'commit' } = {}) {
  const base = { did: 'did:plc:abc', seq: seq++, time: timeOf(us), kind };
  if (kind !== 'commit') return { ...base, [kind]: { did: 'did:plc:abc', time: timeOf(us).slice(0, 23) + 'Z' } };
  return { ...base, commit: { operation, collection, rkey: tid(us), rev: tid(revUs), cid: 'bafy', record: new Uint8Array(4) } };
}
/** `perSecond` likes a second over [fromSec, toSec), evenly spread. */
function steady(fromSec, toSec, perSecond, opts) {
  const out = [];
  for (let s = fromSec; s < toSec; s++) for (let k = 0; k < perSecond; k++) out.push(event(s * 1e6 + Math.floor((k * 1e6) / perSecond), opts));
  return out;
}
async function* from(list, seen = { n: 0, closed: false }) {
  try {
    for (const e of list) {
      seen.n++;
      yield e;
    }
  } finally {
    seen.closed = true;
  }
}

test('reads the archive time to the microsecond', () => {
  assert.equal(timeUsOf('2026-10-20T21:14:03.067559Z'), 1_792_530_843_067_559);
  assert.equal(timeUsOf('2026-10-20T21:14:03Z'), 1_792_530_843_000_000);
  assert.equal(timeUsOf('2026-10-20T21:14:03.5Z'), 1_792_530_843_500_000);
  assert.ok(Number.isNaN(timeUsOf('yesterday')));
  assert.ok(Number.isNaN(timeUsOf(undefined)));
});

test('an archive event counts as the same thing a live one does', () => {
  const like = messageOf(event(DAY * 1e6 + 5));
  assert.equal(like.time_us, DAY * 1e6 + 5);
  assert.deepEqual(eventOfMessage(like), { kind: 'create', collection: 'app.bsky.feed.like' });
  assert.deepEqual(eventOfMessage(messageOf(event(DAY * 1e6, { operation: 'delete' }))), { kind: 'delete' });
  assert.deepEqual(eventOfMessage(messageOf(event(DAY * 1e6, { kind: 'identity' }))), { kind: 'identity' });
  assert.deepEqual(eventOfMessage(messageOf(event(DAY * 1e6, { kind: 'account' }))), { kind: 'account' });
  assert.equal(eventOfMessage(messageOf(event(DAY * 1e6, { kind: 'sync' }))), null, 'sync is not counted, as the live station never hears it');
  assert.equal(accountOf(messageOf(event(DAY * 1e6, { collection: 'fm.teal.feed.play' }))).app, 'teal.fm', 'and whose it is, the same way');
});

// The archive as listSegments shows it: a crawl at a furious rate, then the live stream.
function segment(index, fromSec, toSec, eventCount, minSeq) {
  return { name: `seg_${index}.jss`, index, sizeBytes: 250e6, checksum: 'x', eventCount, minSeq, maxSeq: minSeq + eventCount - 1, minWitnessedAt: fromSec * 1e6, maxWitnessedAt: toSec * 1e6 };
}
const CRAWL_END = DAY - 86400;
const ARCHIVE = [
  segment(0, CRAWL_END - 200, CRAWL_END - 100, 3_000_000, 1),
  segment(1, CRAWL_END - 100, CRAWL_END, 3_000_000, 3_000_001),
  ...Array.from({ length: 30 }, (_, i) => segment(2 + i, CRAWL_END + i * 6000, CRAWL_END + (i + 1) * 6000, 3_000_000, 6_000_001 + i * 3_000_000)),
];

test('plans just the live segments a range needs', () => {
  const plan = planRange(ARCHIVE, CRAWL_END + 6000, CRAWL_END + 12_000);
  // segment 2 holds the lead-in, 3 the hour and a half, 4 the minute or so after it
  assert.deepEqual(plan, { afterSeq: 6_000_000, beforeSeq: 6_000_001 + 3 * 3_000_000 - 1, segments: 3, bytes: 750e6, skip: [] });
  assert.equal(planRange(ARCHIVE, CRAWL_END + 6060, CRAWL_END + 11_880).segments, 1);
});

test('refuses the crawl, and anything past the last sealed segment', () => {
  assert.throws(() => planRange(ARCHIVE, CRAWL_END - 150, CRAWL_END + 3600), /--from must be after .*a crawl of records that already existed/);
  assert.throws(() => planRange(ARCHIVE, CRAWL_END - 3600, CRAWL_END + 3600), /the archive is empty before/);
  assert.throws(() => planRange(ARCHIVE, CRAWL_END + 3600, CRAWL_END + 30 * 6000), /--to must be before/);
  assert.throws(() => planRange([], DAY, DAY + 60), /no segments/);
  assert.equal(planRange(ARCHIVE.slice(2), CRAWL_END + 60, CRAWL_END + 120).segments, 1, 'no crawl: the archive starts where the live stream does');
  // a dense segment later in the archive (a new crawl, a rewrite) doesn't refuse a range clear of it
  const later = [...ARCHIVE, segment(99, CRAWL_END + 30 * 6000, CRAWL_END + 30 * 6000 + 10, 3_000_000, 900_000_000), segment(100, CRAWL_END + 30 * 6000 + 10, CRAWL_END + 31 * 6000, 3_000_000, 903_000_000)];
  assert.equal(planRange(later, CRAWL_END + 6000, CRAWL_END + 12_000).segments, 3);
  assert.throws(() => planRange(later, CRAWL_END + 6000, CRAWL_END + 30 * 6000 + 5), /reaches into a crawl.*#99/);
  // a short dense stretch can be left out instead (the host activity backfill does), a long one still refuses
  assert.deepEqual(planRange(later, CRAWL_END + 6000, CRAWL_END + 30 * 6000 + 5, { skipShort: true }).skip, [[(CRAWL_END + 30 * 6000) * 1e6, (CRAWL_END + 30 * 6000 + 10) * 1e6, 99]]);
  // a crawl of many short segments back to back is long all the same
  const longCrawl = [...Array.from({ length: 40 }, (_, i) => segment(i, CRAWL_END - 40 * 100 + i * 100, CRAWL_END - 40 * 100 + (i + 1) * 100, 3_000_000, 1 + i * 3_000_000)), ...ARCHIVE.slice(2).map((x, i) => ({ ...x, index: 40 + i }))];
  assert.throws(() => planRange(longCrawl, CRAWL_END - 150, CRAWL_END + 3600, { skipShort: true }), /reaches into a crawl/);
});

test('lists every page of segments, with the key', async () => {
  const asked = [];
  const fetch = async (url, init) => {
    asked.push([url.searchParams.get('cursor'), init.headers.authorization]);
    const page = url.searchParams.get('cursor') ? { segments: ARCHIVE.slice(20) } : { segments: ARCHIVE.slice(0, 20), cursor: 'p2' };
    return new Response(JSON.stringify(page), { status: 200 });
  };
  const segs = await listSegments({ host: 'https://js.example', key: 'k', fetch });
  assert.equal(segs.length, ARCHIVE.length);
  assert.deepEqual(asked, [
    [null, 'Bearer k'],
    ['p2', 'Bearer k'],
  ]);
  const denied = async () => new Response('{"error":"invalid bearer credential"}', { status: 401 });
  await assert.rejects(listSegments({ host: 'https://js.example', key: 'k', fetch: denied }), /HTTP 401 .*invalid bearer credential/);
});

test('counts whole minutes, an hour at a time, and stops reading once they are out', async () => {
  const batches = [];
  const seen = { n: 0, closed: false };
  const list = steady(DAY - 3600 - 100, DAY + 3600 + 600, 2);
  const read = await archiveWindow({
    events: from(list, seen),
    fromSec: DAY - 3600,
    toSec: DAY + 3600,
    onMinutes: async (ms) => batches.push(ms.map((m) => [m.minuteSec - DAY, m.seconds, m.tally.creates.get('app.bsky.feed.like')])),
  });
  assert.equal(read.done, true);
  assert.deepEqual(
    batches.map((b) => [b.length, b[0][0], b.at(-1)[0]]),
    [
      [60, -3600, -60],
      [60, 0, 3540],
    ],
    'one batch per hour',
  );
  assert.ok(batches.flat().every(([, seconds, likes]) => seconds === 60 && likes === 120));
  assert.ok(read.firstUs >= (DAY - 3605) * 1e6, 'the lead-in before --from is skipped');
  assert.ok(seen.closed, 'the download is closed');
  assert.ok(seen.n < list.length - 2 * 400, 'and not read much past the last minute');
});

test('a backlog in the archive goes where its revs say, as on the live stream', async () => {
  // 25 s of nothing, then the backlog all stamped at once, carrying when it was made
  const list = [...steady(DAY - 10, DAY + 35, 10)];
  for (let k = (DAY + 35) * 10; k < (DAY + 60) * 10; k++) list.push(event((DAY + 60) * 1e6 + (k % 100), { revUs: k * 100_000 }));
  list.push(...steady(DAY + 60, DAY + 300, 10));
  const minutes = [];
  await archiveWindow({ events: from(list), fromSec: DAY, toSec: DAY + 120, onMinutes: async (ms) => minutes.push(...ms.map((m) => [m.minuteSec - DAY, m.seconds, m.tally.creates.get('app.bsky.feed.like')])) });
  assert.deepEqual(minutes, [
    [0, 60, 600],
    [60, 60, 600],
  ]);
});

test('a hole in the archive is missing, not quiet: the minutes around it are left alone', async () => {
  const list = [...steady(DAY - 10, DAY + 70, 2), ...steady(DAY + 160, DAY + 400, 2)];
  const minutes = [];
  const read = await archiveWindow({ events: from(list), fromSec: DAY, toSec: DAY + 240, onMinutes: async (ms) => minutes.push(...ms.map((m) => [m.minuteSec - DAY, m.seconds])) });
  assert.deepEqual(minutes, [
    [0, 60],
    [60, 9],
    [120, 20],
    [180, 60],
  ]);
  assert.deepEqual(read.holes.map(([a, b]) => [Math.round(a / 1e6) - DAY, Math.round(b / 1e6) - DAY]), [[70, 160]]);
});

test('a pause shorter than that is put back by rev, as on the live stream', async () => {
  const list = [...steady(DAY - 10, DAY + 30, 2)];
  // 50 s of nothing, then what was made in it, stamped late
  for (let s = DAY + 30; s < DAY + 80; s++) for (let k = 0; k < 2; k++) list.push(event((DAY + 80) * 1e6 + k, { revUs: s * 1e6 + k * 500_000 }));
  list.push(...steady(DAY + 80, DAY + 300, 2));
  const minutes = [];
  const read = await archiveWindow({ events: from(list), fromSec: DAY, toSec: DAY + 120, onMinutes: async (ms) => minutes.push(...ms.map((m) => [m.minuteSec - DAY, m.seconds, m.tally.creates.get('app.bsky.feed.like')])) });
  assert.deepEqual(minutes, [
    [0, 60, 120],
    [60, 60, 120],
  ]);
  assert.deepEqual(read.holes, []);
});

test('says so when the archive runs out first', async () => {
  const read = await archiveWindow({ events: from(steady(DAY - 10, DAY + 90, 2)), fromSec: DAY, toSec: DAY + 120, onMinutes: async () => {} });
  assert.equal(read.done, false);
});

test('a run writes new minutes only, and re-sums each day once it is written', async () => {
  const list = steady(DAY - 3600 - 100, DAY + 3600 + 300, 2);
  // the segment list for exactly these events, after a crawl
  const segs = [segment(0, DAY - 90_000, DAY - 89_900, 3_000_000, 1)];
  for (let i = 0; i * 1000 < list.length; i++) {
    const chunk = list.slice(i * 1000, (i + 1) * 1000);
    segs.push({ ...segment(i + 1, 0, 0, chunk.length, chunk[0].seq), minWitnessedAt: timeUsOf(chunk[0].time), maxWitnessedAt: timeUsOf(chunk.at(-1).time) });
  }
  const fetch = async () => new Response(JSON.stringify({ segments: segs }), { status: 200 });
  class FakeJetstream {
    constructor(opts) {
      FakeJetstream.opts = opts;
    }
    async *snapshot(o) {
      FakeJetstream.asked = o;
      for (const e of list) if (e.seq > o.afterSeq && e.seq <= o.beforeSeq) yield e;
    }
  }
  const stationMinute = new Date((DAY + 1800) * 1000).toISOString();
  const calls = [];
  const db = {
    async existing(fromIso, toIso) {
      calls.push(['existing', fromIso, toIso]);
      return new Set(stationMinute >= fromIso && stationMinute < toIso ? [stationMinute] : []);
    },
    async minutes(rows) {
      calls.push(['minutes', rows.length, rows[0]?.minute.minute]);
      assert.ok(rows.every((r) => r.minute.seconds_covered === 60 && r.minute.creates === 120 && r.minute.minute !== stationMinute));
      assert.ok(rows.every((r) => r.minute.dids === 1 && r.minute.dids_bluesky === 1 && r.minute.dids_elsewhere === 0), 'with their active accounts');
    },
    async rollUp(since) {
      calls.push(['rollUp', since]);
    },
    async sketchExists(period, t) {
      calls.push(['sketchExists', period, t]);
      return t === '2026-10-07T00:00:00.000Z';
    },
    async insertSketches({ main, apps }) {
      calls.push(['insertSketches', main.period, main.t, main.seconds, main.dids, apps.length]);
    },
  };
  const lines = [];
  const args = parseArgs(['--from', new Date((DAY - 3600) * 1000).toISOString(), '--to', new Date((DAY + 3600) * 1000).toISOString()], (DAY + 86400) * 1000);
  const out = await backfill({ args, host: 'https://js.example', apiKey: 'k', db, Jetstream: FakeJetstream, fetch, log: (l) => lines.push(l), warn: () => {} });

  assert.equal(FakeJetstream.opts.apiKey, 'k');
  // a 429's Retry-After is waited out in full, not cut to the SDK's 30 s default
  assert.ok(FakeJetstream.opts.retry.maxDelayMs >= 10 * 60_000);
  assert.equal(FakeJetstream.asked.raw, true);
  assert.deepEqual(calls, [
    ['existing', '2026-10-06T23:00:00.000Z', '2026-10-07T00:00:00.000Z'],
    ['minutes', 60, '2026-10-06T23:00:00.000Z'],
    ['rollUp', '2026-10-06T00:00:00.000Z'],
    ['existing', '2026-10-07T00:00:00.000Z', '2026-10-07T01:00:00.000Z'],
    ['minutes', 59, '2026-10-07T00:00:00.000Z'],
    // the hour before is over: its sketch, the station's minute's accounts in it too
    ['sketchExists', 'hour', '2026-10-06T23:00:00.000Z'],
    ['insertSketches', 'hour', '2026-10-06T23:00:00.000Z', 3600, 1, 0],
    ['rollUp', '2026-10-07T00:00:00.000Z'],
    // already has one: left alone. Neither day is wholly inside the run, so neither is written.
    ['sketchExists', 'hour', '2026-10-07T00:00:00.000Z'],
  ]);
  assert.deepEqual([out.written, out.kept, out.partial.length, out.sketches], [119, 1, 0, { hour: 1, day: 0, there: 1 }]);
  assert.match(lines.find((l) => l.startsWith('2026-10-07T00:00Z')), /60\/60 min +2\.0 records\/s .* 59 written +100\.0%/);
});

test('sketch rows go in apps first, and never over a row that is there', async () => {
  const asked = [];
  const fetch = async (url, init) => {
    asked.push([init.method ?? 'GET', url.replace('https://db.example/rest/v1/', ''), init.headers.prefer ?? null, init.body ? JSON.parse(init.body).length : null]);
    return new Response(init.method === 'POST' ? null : '[{"t":"2026-10-07T00:00:00+00:00"}]', { status: init.method === 'POST' ? 201 : 200 });
  };
  const store = sketchStore({ url: 'https://db.example', key: 'k', fetch });
  assert.equal(await store.sketchExists('day', '2026-10-07T00:00:00.000Z'), true);
  await store.insertSketches({ main: { period: 'day' }, apps: Array.from({ length: 450 }, (_, i) => ({ domain: `app${i}.example` })) });
  assert.deepEqual(asked, [
    ['GET', 'atmosphere_account_sketch?select=t&period=eq.day&t=eq.2026-10-07T00%3A00%3A00.000Z&limit=1', null, null],
    ['POST', 'atmosphere_account_app_sketch?on_conflict=period,t,domain', 'resolution=ignore-duplicates,return=minimal', 200],
    ['POST', 'atmosphere_account_app_sketch?on_conflict=period,t,domain', 'resolution=ignore-duplicates,return=minimal', 200],
    ['POST', 'atmosphere_account_app_sketch?on_conflict=period,t,domain', 'resolution=ignore-duplicates,return=minimal', 50],
    ['POST', 'atmosphere_account_sketch?on_conflict=period,t', 'resolution=ignore-duplicates,return=minimal', 1],
  ]);
});

test('a dry run writes nothing', async () => {
  const list = steady(DAY - 100, DAY + 300, 1);
  const segs = [{ ...segment(0, 0, 0, list.length, list[0].seq), minWitnessedAt: timeUsOf(list[0].time), maxWitnessedAt: timeUsOf(list.at(-1).time) }];
  class FakeJetstream {
    async *snapshot() {
      yield* list;
    }
  }
  const args = parseArgs(['--from', new Date(DAY * 1000).toISOString(), '--to', new Date((DAY + 120) * 1000).toISOString(), '--dry-run'], (DAY + 86400) * 1000);
  const lines = [];
  const out = await backfill({ args, host: 'https://js.example', apiKey: 'k', db: null, Jetstream: FakeJetstream, fetch: async () => new Response(JSON.stringify({ segments: segs })), log: (l) => lines.push(l) });
  assert.equal(out.written, 0);
  assert.match(lines[0], /dry run: nothing is written/);
});

test('takes up to a month, and --overwrite', () => {
  const now = (DAY + 30 * 86400) * 1000;
  const a = parseArgs(['--from', '2026-10-06T14:00Z', '--to', '2026-10-20T16:50Z', '--overwrite'], now);
  assert.deepEqual([a.toSec - a.fromSec, a.overwrite, a.dryRun], [14 * 86400 + 170 * 60, true, false]);
  assert.equal(parseArgs(['--from', '2026-10-06T14:00Z', '--to', '2026-10-07T14:00Z'], now).overwrite, false);
  assert.throws(() => parseArgs(['--from', '2026-09-01T00:00Z', '--to', '2026-10-06T00:00Z'], now), /at most 744 hours/);
});

test('finds the SDK where it was installed, or says how to install it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-'));
  try {
    await assert.rejects(loadSdk(dir), /isn't installed in .*npm ci --ignore-scripts/s);
    const pkg = path.join(dir, 'node_modules', '@bsky', 'jetstream');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@bsky/jetstream', type: 'module', exports: { '.': { default: './index.js' } } }));
    fs.writeFileSync(path.join(pkg, 'index.js'), 'export class Jetstream {}\n');
    const sdk = await loadSdk(dir);
    assert.equal(typeof sdk.Jetstream, 'function');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

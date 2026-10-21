// Rebuilding older weather from the archive's crawl: times, counting, saving, writing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tidUs } from '../src/clock.js';
import { History, linearCount, madeUs, parseArgs, planCrawl, readCrawl, rebuild, emptyStats, tidMicros, writeHistory, EARLIEST_S } from '../src/crawl.js';
import { registerOf, Sketch } from '../src/hll.js';
import { fromBytea } from '../src/rollup.js';

const DAY = 86400;
const D0 = Date.UTC(2024, 0, 1) / 1000; // 2024-01-01, a Monday
const ALPHABET = '234567abcdefghijklmnopqrstuvwxyz';
function tid(us, clock = 0) {
  let v = (BigInt(us) << 10n) | BigInt(clock);
  let s = '';
  for (let i = 0; i < 13; i++) {
    s = ALPHABET[Number(v & 31n)] + s;
    v >>= 5n;
  }
  return s;
}
const timeOf = (us) => new Date(Math.floor(us / 1000)).toISOString().replace('Z', '000Z');
const record = (obj) => new TextEncoder().encode(JSON.stringify(obj));
const parseRawRecord = (bytes) => JSON.parse(new TextDecoder().decode(bytes));

let seq = 100;
/** A crawled record, as the SDK's raw snapshot hands it over: archived now, made at `us`. */
function crawled(us, { collection = 'app.bsky.feed.like', did = 'did:plc:alice', rkey = tid(us), createdAt, operation = 'create' } = {}) {
  return { did, seq: seq++, time: timeOf(Date.UTC(2026, 9, 3) * 1000), kind: 'commit', commit: { operation, collection, rkey, rev: tid(Date.UTC(2026, 9, 3) * 1000), cid: 'bafy', record: record({ $type: collection, createdAt }) } };
}
async function* from(list) {
  for (const e of list) yield e;
}

test('reads a TID as clock.js does, without BigInts', () => {
  for (const us of [0, 1, 1_700_000_000_123_456, Date.UTC(2026, 9, 21) * 1000 + 789, 2 ** 53 - 1]) {
    for (const clock of [0, 5, 1023]) assert.equal(tidMicros(tid(us, clock)), tidUs(tid(us, clock)));
  }
  assert.equal(tidMicros('self'), null);
  assert.equal(tidMicros('3l2s7fyh5ve2z'.toUpperCase()), null);
  assert.equal(tidMicros('zzzzzzzzzzzzz'), null); // top bit set
  assert.equal(tidMicros('3l2s7fyh5ve2é'), null);
  assert.equal(tidMicros(undefined), null);
});

test('a record is made when its rkey says, else when its createdAt says', () => {
  const us = D0 * 1e6 + 1234;
  assert.equal(madeUs({ rkey: tid(us), record: record({ createdAt: '2020-01-01T00:00:00Z' }) }, parseRawRecord), us);
  assert.equal(madeUs({ rkey: 'self', record: record({ createdAt: '2024-01-01T00:00:01.500Z' }) }, parseRawRecord), D0 * 1e6 + 1_500_000);
  assert.equal(madeUs({ rkey: 'self', record: record({}) }, parseRawRecord), null);
  assert.equal(madeUs({ rkey: 'self', record: new Uint8Array([1, 2]) }, parseRawRecord), null);
});

test('linear counting reads small sets about right', () => {
  assert.equal(linearCount(0, 128), 0);
  assert.equal(linearCount(1, 128), 1);
  assert.equal(linearCount(10, 128), 10);
  assert.ok(Math.abs(linearCount(28, 128) - 31) <= 1); // ~31 names fill ~28 bits
  assert.ok(linearCount(128, 128) > 500); // saturated: a lot
});

test('counts records into their minutes, hours and days, by when they were made', () => {
  const h = new History({ fromSec: D0, toSec: D0 + 2 * DAY });
  const alice = registerOf('did:plc:alice');
  const bob = registerOf('did:plc:bob');
  const at = (s) => (D0 + s) * 1e6;
  assert.ok(h.add('app.bsky.feed.like', at(30), alice));
  assert.ok(h.add('app.bsky.feed.post', at(45), alice));
  assert.ok(h.add('fyi.unravel.frontpage.post', at(50), bob));
  assert.ok(h.add('fyi.unravel.frontpage.vote', at(61), bob));
  assert.ok(h.add('fyi.unravel.frontpage.vote', at(3600 + 1801), alice));
  assert.ok(h.add('sh.tangled.repo', at(DAY + 5), bob));
  assert.equal(h.add('app.bsky.feed.like', at(-1), alice), false);
  assert.equal(h.add('app.bsky.feed.like', at(2 * DAY), alice), false);
  assert.equal(h.add('not an nsid', at(5), alice), false);

  const rows = h.minuteRows(0, 2);
  assert.deepEqual(rows[0], {
    minute: '2024-01-01T00:00:00.000Z',
    seconds_covered: 60,
    creates: 3,
    bluesky: 2,
    elsewhere: 1,
    posts: 1,
    likes: 1,
    reposts: 0,
    follows: 0,
    updates: 0,
    deletes: 0,
    identity: 0,
    account: 0,
    collections: 3,
    apps: 1,
  });
  assert.equal(rows[1].creates, 1);
  assert.equal(rows[1].bluesky, 0);
  assert.equal(h.minuteRows().length, 2 * 1440);
  assert.equal(h.minuteRows().reduce((a, r) => a + r.creates, 0), 6);

  const { hours, days } = h.appRows();
  assert.deepEqual(hours, [
    { hour: '2024-01-01T00:00:00.000Z', domain: 'unravel.fyi', creates: 2, minutes: 2, collections: ['fyi.unravel.frontpage.post', 'fyi.unravel.frontpage.vote'] },
    { hour: '2024-01-01T01:00:00.000Z', domain: 'unravel.fyi', creates: 1, minutes: 1, collections: ['fyi.unravel.frontpage.vote'] },
    { hour: '2024-01-02T00:00:00.000Z', domain: 'tangled.sh', creates: 1, minutes: 1, collections: ['sh.tangled.repo'] },
  ]);
  assert.deepEqual(days, [
    { day: '2024-01-01T00:00:00.000Z', domain: 'unravel.fyi', creates: 3, minutes: 3, collections: ['fyi.unravel.frontpage.post', 'fyi.unravel.frontpage.vote'] },
    { day: '2024-01-02T00:00:00.000Z', domain: 'tangled.sh', creates: 1, minutes: 1, collections: ['sh.tangled.repo'] },
  ]);

  const periods = [...h.sketchPeriods()];
  assert.equal(periods.filter((p) => p.period === 'hour').length, 48);
  assert.equal(periods.filter((p) => p.period === 'month').length, 0); // January isn't wholly inside
  const [hour0] = periods;
  assert.equal(hour0.bluesky.estimate(), 1);
  assert.equal(hour0.elsewhere.estimate(), 1);
  const day0 = periods.find((p) => p.period === 'day' && p.t === D0);
  assert.equal(day0.bluesky.estimate(), 1);
  assert.equal(day0.elsewhere.estimate(), 2);
  assert.deepEqual([...day0.apps.keys()], ['unravel.fyi']);
  assert.equal(day0.apps.get('unravel.fyi').estimate(), 2);
  assert.equal(day0.through, D0 + DAY - 60);
});

test('a whole month inside the range gets its own sketches', () => {
  const feb = Date.UTC(2024, 1, 1) / 1000;
  const mar = Date.UTC(2024, 2, 1) / 1000;
  const h = new History({ fromSec: feb - DAY, toSec: mar + DAY });
  for (let d = 0; d < 29; d++) h.add('blue.flushes.status', (feb + d * DAY + 100) * 1e6, registerOf(`did:plc:${d}`));
  const months = [...h.sketchPeriods()].filter((p) => p.period === 'month');
  assert.equal(months.length, 1);
  assert.equal(months[0].t, feb);
  assert.equal(months[0].seconds, 29 * DAY);
  assert.equal(months[0].through, mar - 60);
  assert.ok(Math.abs(months[0].elsewhere.estimate() - 29) <= 1);
  assert.ok(Math.abs(months[0].apps.get('flushes.blue').estimate() - 29) <= 1);
});

test('an app with many accounts in a day goes dense and still counts right', () => {
  const h = new History({ fromSec: D0, toSec: D0 + DAY });
  for (let i = 0; i < 5000; i++) h.add('fm.teal.alpha.feed.play', (D0 + i) * 1e6, registerOf(`did:plc:${i}`));
  const day = [...h.sketchPeriods()].find((p) => p.period === 'day');
  const n = day.apps.get('teal.fm').estimate();
  assert.ok(Math.abs(n - 5000) < 5000 * 0.05, `${n}`);
});

test('saves and loads exactly what it counted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-'));
  const file = path.join(dir, 'state.bin');
  const h = new History({ fromSec: D0, toSec: D0 + 3 * DAY });
  for (let i = 0; i < 3000; i++) h.add(i % 3 ? 'app.bsky.feed.like' : `com.example${i % 7}.thing`, (D0 + i * 61) * 1e6, registerOf(`did:plc:${i % 50}`));
  h.add('not an nsid', D0 * 1e6, 1);
  h.save(file, { host: 'https://example', throughSeq: 42, complete: false });
  const { history, meta } = History.load(file);
  assert.deepEqual(meta, { host: 'https://example', throughSeq: 42, complete: false });
  assert.deepEqual(history.minuteRows(), h.minuteRows());
  assert.deepEqual(history.appRows(), h.appRows());
  const a = [...h.sketchPeriods()].map((p) => [p.period, p.t, p.bluesky.estimate(), p.elsewhere.estimate(), [...p.apps].map(([d, s]) => [d, s.estimate()])]);
  const b = [...history.sketchPeriods()].map((p) => [p.period, p.t, p.bluesky.estimate(), p.elsewhere.estimate(), [...p.apps].map(([d, s]) => [d, s.estimate()])]);
  assert.deepEqual(b, a);
  assert.equal(history.nsidId('not an nsid'), -1);
  // and goes on counting where it left off
  history.add('com.example0.thing', (D0 + 5) * 1e6, 1);
  assert.equal(history.minuteRows(0, 1)[0].creates, h.minuteRows(0, 1)[0].creates + 1);
  assert.equal(History.load(path.join(dir, 'none.bin')), null);
});

test('the crawl is the fast segments at the start of the archive', () => {
  const seg = (index, minSeq, maxSeq, fromUs, toUs, eventCount) => ({ index, minSeq, maxSeq, minWitnessedAt: fromUs, maxWitnessedAt: toUs, eventCount, sizeBytes: 256e6 });
  const t = Date.UTC(2026, 9, 2) * 1000;
  const plan = planCrawl([
    seg(0, 1, 1000, t, t + 1e6, 1000),
    seg(1, 1001, 3_000_000, t + 1e6, t + 100e6, 2_999_000),
    seg(2, 3_000_001, 3_000_400, t + 100e6, t + 200e6, 400),
    seg(3, 3_000_401, 9_000_000, t + 200e6, t + 300e6, 5_999_600),
    seg(4, 9_000_001, 9_040_000, t + 300e6, t + 400e6, 40_000), // live pace: after the crawl
  ]);
  assert.equal(plan.afterSeq, 0);
  assert.equal(plan.beforeSeq, 9_000_000);
  assert.equal(plan.segments, 4);
  assert.equal(plan.startUs, t + 1e6);
  assert.equal(plan.endUs, t + 300e6);
  assert.throws(() => planCrawl([seg(0, 1, 100, t, t + 100e6, 100)]), /no crawl/);
});

test('arguments: whole UTC days, from November 2022 on', () => {
  assert.equal(parseArgs([]).fromSec, EARLIEST_S);
  assert.equal(parseArgs([]).toSec, null);
  assert.equal(parseArgs(['--from', '2024-01-01', '--to', '2024-02-01']).toSec, Date.UTC(2024, 1, 1) / 1000);
  assert.throws(() => parseArgs(['--from', '2024-01-01T05:00Z']), /midnight/);
  assert.throws(() => parseArgs(['--from', '2021-01-01']), /before 2022-11-01/);
  assert.throws(() => parseArgs(['--nope']), /unknown/);
  assert.equal(parseArgs(['--probe']).probe, true);
});

test('reading the crawl skips repeats, and sorts out what it leaves out', async () => {
  const h = new History({ fromSec: D0, toSec: D0 + DAY });
  const e1 = crawled((D0 + 10) * 1e6);
  const list = [
    e1,
    { ...e1 }, // the same seq again, after a re-planned download
    crawled((D0 - 10) * 1e6),
    crawled((D0 + DAY + 10) * 1e6),
    crawled(0, { rkey: 'self', createdAt: '2024-01-01T00:01:00Z', collection: 'app.bsky.actor.profile' }),
    crawled(0, { rkey: 'self' }),
    crawled((D0 + 20) * 1e6, { operation: 'update' }),
    { did: 'did:plc:alice', seq: seq++, time: timeOf(0), kind: 'identity', identity: {} },
  ];
  const stats = emptyStats();
  const { throughSeq, done } = await readCrawl({ events: from(list), history: h, parseRawRecord, throughSeq: 0, stats });
  assert.equal(done, true);
  assert.equal(throughSeq, list.at(-1).seq);
  assert.deepEqual(stats, { events: 7, counted: 2, undated: 1, before: 1, after: 1, invalid: 0, kinds: { update: 1, identity: 1 } });
  assert.equal(h.minuteRows(0, 1)[0].likes, 1);
  assert.equal(h.minuteRows(1, 2)[0].creates, 1);
});

/** A stand-in for the SDK: snapshot() hands over `events` in (afterSeq, beforeSeq]. */
function fakeSdk(events, opened = []) {
  return {
    parseRawRecord,
    Jetstream: class {
      constructor(opts) {
        this.opts = opts;
      }
      async *snapshot({ afterSeq, beforeSeq }) {
        opened.push({ afterSeq, beforeSeq });
        for (const e of events) if (e.seq > afterSeq && e.seq <= beforeSeq) yield e;
      }
    },
  };
}
function segmentsFetch(segments) {
  return async (url) => {
    assert.match(String(url), /listSegments/);
    return new Response(JSON.stringify({ segments }), { status: 200 });
  };
}

test('a run reads the crawl, saves, writes, and a second run only writes again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-'));
  const state = path.join(dir, 'state.bin');
  const crawlUs = Date.UTC(2024, 0, 3) * 1000; // the crawl "began" on 2024-01-03
  seq = 1;
  const events = [];
  for (let i = 0; i < 300; i++) events.push(crawled((D0 + i * 400) * 1e6, { did: `did:plc:${i % 10}`, collection: i % 5 ? 'app.bsky.feed.like' : 'sh.tangled.feed.star' }));
  const segments = [{ index: 0, minSeq: 1, maxSeq: 300, minWitnessedAt: crawlUs, maxWitnessedAt: crawlUs + 1000, eventCount: 1_000_000, sizeBytes: 1000 }];
  const inserted = [];
  const db = { insert: async (table, conflict, rows) => inserted.push({ table, conflict, rows }) };
  const opened = [];
  const args = { ...parseArgs(['--from', '2024-01-01']), state };
  const logs = [];
  const run = () => rebuild({ args, host: 'https://js.example', apiKey: 'k', sdk: fakeSdk(events, opened), db, fetch: segmentsFetch(segments), log: (l) => logs.push(l), warn: (l) => logs.push(l), onSignal: () => {} });
  const { history, meta } = await run();
  assert.equal(meta.complete, true);
  assert.equal(meta.counts.counted, 300);
  assert.equal(history.toSec, Date.UTC(2024, 0, 3) / 1000);
  assert.deepEqual(opened, [{ afterSeq: 0, beforeSeq: 300 }]);

  const minutes = inserted.filter((x) => x.table === 'atmosphere_minute').flatMap((x) => x.rows);
  assert.equal(minutes.length, 2 * 1440);
  assert.equal(minutes.reduce((a, r) => a + r.creates, 0), 300);
  assert.equal(minutes.reduce((a, r) => a + r.elsewhere, 0), 60);
  assert.ok(inserted.every((x) => x.rows.length <= 1000));
  const hourApps = inserted.filter((x) => x.table === 'atmosphere_hour_app').flatMap((x) => x.rows);
  assert.equal(hourApps.reduce((a, r) => a + r.creates, 0), 60);
  const dayApps = inserted.filter((x) => x.table === 'atmosphere_day_app').flatMap((x) => x.rows);
  assert.deepEqual(dayApps.map((r) => [r.day.slice(0, 10), r.creates]), [['2024-01-01', 44], ['2024-01-02', 16]]);
  const sketches = inserted.filter((x) => x.table === 'atmosphere_account_sketch').flatMap((x) => x.rows);
  assert.equal(sketches.filter((r) => r.period === 'hour').length, 48);
  assert.equal(sketches.filter((r) => r.period === 'day').length, 2);
  const day1 = sketches.find((r) => r.period === 'day' && r.t === '2024-01-01T00:00:00.000Z');
  assert.equal(day1.dids, 10);
  assert.equal(fromBytea(day1.elsewhere).estimate(), 2); // dids 0 and 5 starred repos
  const appSketches = inserted.filter((x) => x.table === 'atmosphere_account_app_sketch').flatMap((x) => x.rows);
  assert.deepEqual(appSketches.map((r) => [r.period, r.t.slice(0, 10), r.domain, r.dids]), [['day', '2024-01-01', 'tangled.sh', 2], ['day', '2024-01-02', 'tangled.sh', 2]]);
  // an app's sketch goes in before its period's main row
  const order = inserted.map((x) => x.table);
  assert.ok(order.indexOf('atmosphere_account_app_sketch') < order.lastIndexOf('atmosphere_account_sketch'));

  // again: the state is complete, so nothing is downloaded, and the same rows go again (inserts leave them alone)
  const before = inserted.length;
  await run();
  assert.equal(opened.length, 1);
  assert.equal(inserted.length, before * 2);
  assert.ok(logs.some((l) => /picking up/.test(l)));
});

test('Ctrl-C saves where it got to, and the next run carries on from there', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-'));
  const state = path.join(dir, 'state.bin');
  const crawlUs = Date.UTC(2024, 0, 2) * 1000;
  seq = 1;
  const events = [];
  for (let i = 0; i < 250_000; i++) events.push(crawled((D0 + (i % 86_000)) * 1e6, { did: `did:plc:${i % 1000}` }));
  const segments = [{ index: 0, minSeq: 1, maxSeq: 250_000, minWitnessedAt: crawlUs, maxWitnessedAt: crawlUs + 1000, eventCount: 250_000, sizeBytes: 1000 }];
  const opened = [];
  let stop = null;
  const args = { ...parseArgs(['--from', '2024-01-01']), state };
  const quiet = () => {};
  // Ctrl-C at once: the first tick (100k events) saves and stops.
  const first = await rebuild({ args, host: 'https://h.example', apiKey: 'k', sdk: fakeSdk(events, opened), db: null, fetch: segmentsFetch(segments), log: quiet, warn: quiet, onSignal: (fn) => { stop = fn; fn(); } });
  assert.equal(first.stopped, true);
  assert.equal(first.meta.throughSeq, 100_000);
  assert.equal(History.load(state).meta.throughSeq, 100_000);
  assert.ok(stop);
  const second = await rebuild({ args, host: 'https://h.example', apiKey: 'k', sdk: fakeSdk(events, opened), db: null, fetch: segmentsFetch(segments), log: quiet, warn: quiet, onSignal: quiet });
  assert.deepEqual(opened, [{ afterSeq: 0, beforeSeq: 250_000 }, { afterSeq: 100_000, beforeSeq: 250_000 }]);
  assert.equal(second.meta.complete, true);
  assert.equal(second.meta.counts.counted, 250_000);
  assert.equal(second.history.minuteRows().reduce((a, r) => a + r.creates, 0), 250_000);
  // a different range can't pick up this state
  await assert.rejects(rebuild({ args: { ...args, ...parseArgs(['--from', '2023-12-31']), state }, host: 'https://h.example', apiKey: 'k', sdk: fakeSdk(events), db: null, fetch: segmentsFetch(segments), log: quiet, warn: quiet, onSignal: quiet }), /move it away/);
});

test('--to past the end of the crawl is refused', async () => {
  const crawlUs = Date.UTC(2024, 0, 2) * 1000;
  const segments = [{ index: 0, minSeq: 1, maxSeq: 10_000_000, minWitnessedAt: crawlUs, maxWitnessedAt: crawlUs + 1000e6, eventCount: 10_000_000, sizeBytes: 1000 }];
  const args = { ...parseArgs(['--from', '2024-01-01', '--to', '2024-01-05']), state: '/nonexistent/state.bin' };
  await assert.rejects(rebuild({ args, host: 'https://h.example', apiKey: 'k', sdk: fakeSdk([]), db: null, fetch: segmentsFetch(segments), log: () => {}, warn: () => {}, onSignal: () => {} }), /can't be after 2024-01-02/);
});

test('writeHistory writes sketches as bytea the website can read', async () => {
  const h = new History({ fromSec: D0, toSec: D0 + DAY });
  h.add('app.bsky.feed.like', (D0 + 1) * 1e6, registerOf('did:plc:x'));
  const inserted = [];
  await writeHistory({ history: h, db: { insert: async (table, conflict, rows) => inserted.push({ table, conflict, rows }) }, log: () => {} });
  const main = inserted.find((x) => x.table === 'atmosphere_account_sketch').rows[0];
  assert.equal(main.period, 'hour');
  assert.equal(main.seconds, 3600);
  assert.equal(main.through, '2024-01-01T00:59:00.000Z');
  assert.ok(fromBytea(main.bluesky) instanceof Sketch);
  assert.equal(main.dids, 1);
  // no records outside Bluesky, so no app rows
  assert.deepEqual([...new Set(inserted.map((x) => x.conflict))].sort(), ['minute', 'period,t']);
});

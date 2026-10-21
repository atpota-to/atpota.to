// Bucketing by event time, coverage, replays and the rolling window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEvent, emptyTally, summarize } from '../src/atmosphere.js';
import { registerOf } from '../src/hll.js';
import { MIN_COVERED, RETAIN_SECONDS, Station } from '../src/station.js';

const T0 = 1_792_512_000; // 2026-10-20T16:00:00Z, a minute boundary
const us = (second, frac = 0) => Math.round((second + frac) * 1e6);
const create = (collection) => ({ kind: 'create', collection });
const POST = create('app.bsky.feed.post');
const LIKE = create('app.bsky.feed.like');
const TANGLED = create('sh.tangled.repo');

function clock(second) {
  const c = { ms: second * 1000 };
  c.now = () => c.ms;
  return c;
}

/** A connected station with one event every `step` seconds from `from` to `to`. */
function streamed(from, to, { step = 0.25, event = () => POST, nowSec = to + 2.5 } = {}) {
  const c = clock(nowSec);
  const s = new Station({ now: c.now });
  s.beginSession();
  for (let t = from; t <= to; t += step) s.ingest(us(t), event(t));
  return { s, c };
}

test('buckets by each event\'s own time, out of order included', () => {
  const c = clock(T0 + 10);
  const s = new Station({ now: c.now });
  s.beginSession();
  s.ingest(us(T0 + 3, 0.5), POST);
  s.ingest(us(T0 + 1, 0.2), LIKE); // late, earlier second
  s.ingest(us(T0 + 3, 0.9), POST);
  assert.equal(s.buckets.get(T0 + 3).tally.creates.get('app.bsky.feed.post'), 2);
  assert.equal(s.buckets.get(T0 + 1).tally.creates.get('app.bsky.feed.like'), 1);
});

test('ignores events more than an hour old or more than 5 s in the future', () => {
  const c = clock(T0 + 7200);
  const s = new Station({ now: c.now });
  s.beginSession();
  s.ingest(us(T0), POST); // two hours ago
  s.ingest(us(T0 + 7200 + 60), POST); // a minute ahead
  s.ingest(us(T0 + 7200 + 4), POST); // 4 s ahead: fine
  s.ingest(undefined, POST);
  assert.equal(s.buckets.has(T0), false);
  assert.equal(s.buckets.has(T0 + 7260), false);
  assert.equal(s.buckets.get(T0 + 7204).tally.creates.get('app.bsky.feed.post'), 1);
  assert.deepEqual({ tooOld: s.counts.tooOld, future: s.counts.future, badTime: s.counts.badTime }, { tooOld: 1, future: 1, badTime: 1 });
});

test('counts nothing while disconnected', () => {
  const s = new Station({ now: clock(T0 + 10).now });
  s.ingest(us(T0 + 1), POST);
  assert.equal(s.buckets.size, 0);
});

test('a second is covered only when the connection saw all of it', () => {
  const { s } = streamed(T0 + 0.4, T0 + 5.6);
  // T0 began before the first event; T0+5 hasn't been seen past its end
  assert.equal(s.buckets.get(T0).covered, false);
  for (let t = T0 + 1; t <= T0 + 4; t++) assert.equal(s.buckets.get(t).covered, true, `second ${t}`);
  assert.equal(s.buckets.get(T0 + 5).covered, false);
  assert.equal(s.coveredThrough, T0 + 4);
});

test('a reconnect that replays from a cursor counts nothing twice and leaves no gap', () => {
  const c = clock(T0 + 30);
  const s = new Station({ now: c.now });
  const events = [];
  for (let t = T0; t < T0 + 20; t += 0.1) events.push(us(t));
  // first connection: up to T0+12.35, then drops mid-second
  s.beginSession();
  for (const t of events) if (t <= us(T0 + 12.35)) s.ingest(t, POST);
  s.endSession();
  const lastUs = s.lastUs;
  // second connection replays from lastUs - 2 s, dropping what was already counted
  s.beginSession({ dropThroughUs: lastUs });
  for (const t of events) if (t >= lastUs - 2e6) s.ingest(t, POST);
  // every second from T0+1 to T0+18 is covered, with exactly its 10 events
  for (let t = T0 + 1; t <= T0 + 18; t++) {
    const b = s.buckets.get(t);
    assert.equal(b.covered, true, `second ${t} covered`);
    assert.equal(b.tally.creates.get('app.bsky.feed.post'), 10, `second ${t} counted once`);
  }
  assert.ok(s.counts.replayed >= 20);
});

test('a reconnect that could not replay leaves the gap missing, not quiet', () => {
  const c = clock(T0 + 30);
  const s = new Station({ now: c.now });
  s.beginSession();
  for (let t = T0; t <= T0 + 10.05; t += 0.1) s.ingest(us(t), POST);
  s.endSession();
  s.beginSession({ dropThroughUs: s.lastUs });
  for (let t = T0 + 15.5; t <= T0 + 20; t += 0.1) s.ingest(us(t), POST);
  for (let t = T0 + 10; t <= T0 + 15; t++) assert.notEqual(s.buckets.get(t)?.covered, true, `second ${t} missing`);
  assert.equal(s.buckets.get(T0 + 16).covered, true);
});

test('the rolling window sums the last 60 complete seconds, ending 2 s ago', () => {
  // 4 posts a second and one tangled record every other second, T0-100 .. now
  const { s } = streamed(T0 - 100, T0 + 0.9, { nowSec: T0 + 2.5, event: (t) => (Math.round(t * 4) % 8 === 0 ? TANGLED : POST) });
  const w = s.window();
  assert.equal(w.to, T0); // floor(T0 + 2.5) - 2
  assert.equal(w.from, T0 - 60);
  assert.equal(w.seconds, 60);
  assert.equal(w.series.length, 60);
  assert.equal(w.series[0].t, T0 - 60);
  const total = w.series.reduce((n, p) => n + p.creates, 0);
  assert.equal(total, 240);
  assert.equal(w.series.reduce((n, p) => n + p.elsewhere, 0), 30);
  assert.deepEqual(w.series[1], { t: T0 - 59, creates: 4, bluesky: w.series[1].bluesky, elsewhere: 4 - w.series[1].bluesky, posts: w.series[1].bluesky });
});

test('missing seconds lower `seconds` and show as null in the series', () => {
  const c = clock(T0 + 2.5);
  const s = new Station({ now: c.now });
  s.beginSession();
  for (let t = T0 - 100; t <= T0 - 40.05; t += 0.1) s.ingest(us(t), POST);
  s.endSession();
  s.beginSession({ dropThroughUs: s.lastUs });
  for (let t = T0 - 19.5; t <= T0 + 0.95; t += 0.1) s.ingest(us(t), POST);
  const w = s.window();
  // covered: T0-60..T0-42 (19 s, through the second before T0-40.05's) and T0-19..T0-1 (19 s)
  assert.equal(w.seconds, 38);
  assert.equal(w.series.filter((p) => p === null).length, 22);
  assert.equal(w.series[0].t, T0 - 60);
  assert.equal(w.series[20], null);
  const r = s.reading();
  assert.equal(r.seconds, 38);
  assert.equal(r.perSecond.posts, 10);
});

test('under 30 covered seconds is no reading', () => {
  const { s } = streamed(T0 - (MIN_COVERED - 1) - 0.5, T0 + 0.9, { nowSec: T0 + 2.5 });
  assert.equal(s.window().seconds, MIN_COVERED - 1);
  assert.equal(s.reading(), null);
  const { s: s2 } = streamed(T0 - MIN_COVERED - 0.5, T0 + 0.9, { nowSec: T0 + 2.5 });
  assert.equal(s2.window().seconds, MIN_COVERED);
  assert.notEqual(s2.reading(), null);
});

test('the reading is summarize() of the same events, plus window and series', () => {
  const kinds = [POST, LIKE, LIKE, TANGLED, create('fyi.unravel.frontpage.post'), { kind: 'delete' }, { kind: 'update' }, { kind: 'identity' }, create('chat.bsky.actor.declaration')];
  let i = 0;
  const { s } = streamed(T0 - 70.05, T0 + 0.95, { step: 0.05, nowSec: T0 + 2.2, event: () => kinds[i++ % kinds.length] });
  // the same events, counted the reference way, over exactly the window's seconds
  const reference = emptyTally();
  i = 0;
  for (let t = T0 - 70.05; t <= T0 + 0.95; t += 0.05) {
    const e = kinds[i++ % kinds.length];
    const second = Math.floor(us(t) / 1e6);
    if (second >= T0 - 60 && second < T0) addEvent(reference, e);
  }
  const r = s.reading();
  const { window, series, accounts, ...rest } = r;
  assert.deepEqual(rest, summarize(reference, 60, '2026-10-20T16:00:00.000Z'));
  assert.deepEqual(accounts, { active: 0, bluesky: 0, elsewhere: 0, index: 0, apps: [] }, 'these events have no DIDs');
  assert.deepEqual(window, { from: '2026-10-20T15:59:00.000Z', to: '2026-10-20T16:00:00.000Z' });
  assert.equal(series.length, 60);
  // snapshot of the shape the website reads
  assert.deepEqual(Object.keys(r), ['measuredAt', 'seconds', 'perSecond', 'condition', 'records', 'diversity', 'apps', 'bluesky', 'events', 'accounts', 'window', 'series']);
  assert.deepEqual(r.apps.map((a) => a.domain).sort(), ['tangled.sh', 'unravel.fyi']);
  assert.equal(r.perSecond.likes, round1(r.bluesky.find((b) => b.nsid === 'app.bsky.feed.like').count / 60));
});

const round1 = (n) => Math.round(n * 10) / 10;

test('keeps an hour and forgets the rest', () => {
  const c = clock(T0);
  const s = new Station({ now: c.now });
  s.beginSession();
  s.ingest(us(T0 - 10), POST);
  c.ms = (T0 + RETAIN_SECONDS - 11) * 1000;
  s.prune();
  assert.equal(s.buckets.has(T0 - 10), true);
  c.ms = (T0 + RETAIN_SECONDS) * 1000;
  s.prune();
  assert.equal(s.buckets.has(T0 - 10), false);
});

test('a minute sums its covered seconds', () => {
  const { s } = streamed(T0 - 0.5, T0 + 61, { nowSec: T0 + 80 });
  const full = s.minute(T0);
  assert.equal(full.seconds, 60);
  assert.equal(full.tally.creates.get('app.bsky.feed.post'), 240);
  const { s: half } = streamed(T0 + 29.5, T0 + 61, { nowSec: T0 + 80 });
  assert.equal(half.minute(T0).seconds, 30);
  assert.equal(new Station().minute(T0).seconds, 0);
});

test('counts a record in the second it was made, up to a minute before Jetstream stamped it', () => {
  const c = clock(T0 + 100);
  const s = new Station({ now: c.now });
  s.beginSession();
  s.ingest(us(T0 + 90), POST, us(T0 + 62)); // let out late after a pause
  s.ingest(us(T0 + 90), LIKE, us(T0 + 95)); // claims to be from after Jetstream saw it
  s.ingest(us(T0 + 90), POST, NaN);
  assert.equal(s.buckets.get(T0 + 62).tally.creates.get('app.bsky.feed.post'), 1);
  assert.equal(s.buckets.get(T0 + 90).tally.creates.get('app.bsky.feed.like'), 1, 'never later than its stamp');
  assert.equal(s.buckets.get(T0 + 90).tally.creates.get('app.bsky.feed.post'), 1);
  assert.equal(s.counts.movedBack, 1);
  assert.equal(s.counts.maxMovedMs, 28_000);
  // coverage still follows the stream: nothing past T0 + 89 is covered yet
  assert.equal(s.coveredThrough, T0 + 89);
});

test('accounts: who committed in the window, by the same coverage and replay rules', () => {
  const c = clock(T0 + 2.5);
  const s = new Station({ now: c.now });
  // (names picked so no two of the forty share a register: 4096 registers, 40 accounts)
  const who = (i) => ({ register: registerOf(`did:plc:u${i % 40}`), app: i % 10 === 0 ? 'tangled.sh' : null });
  s.beginSession();
  let i = 0;
  for (let t = T0 - 80; t <= T0 - 30.05; t += 0.05) s.ingest(us(t), POST, undefined, who(i++));
  s.endSession();
  // the replay overlaps; nobody new in it, and nothing is counted twice anyway
  const lastUs = s.lastUs;
  s.beginSession({ dropThroughUs: lastUs });
  for (let t = T0 - 32; t <= T0 + 0.95; t += 0.05) s.ingest(us(t), POST, undefined, who(i++));
  const r = s.reading();
  assert.equal(r.accounts.active, 40);
  assert.equal(r.accounts.bluesky, 36);
  assert.equal(r.accounts.elsewhere, 4);
  assert.equal(r.accounts.index, 10);
  assert.deepEqual(r.accounts.apps, [{ domain: 'tangled.sh', accounts: 4, collections: [] }]);
  // the diversity index is theirs: a tenth of them elsewhere, all in one app
  assert.deepEqual([r.diversity.index, r.diversity.share, r.diversity.spread], [10, 10, 1]);
  // a minute's accounts come with its tally
  const m = s.minute(T0 - 60);
  assert.equal(m.accounts.all.estimate(), 40);
  assert.equal(m.seconds, 60);
});

test('accounts in seconds that were not covered do not count', () => {
  const c = clock(T0 + 2.5);
  const s = new Station({ now: c.now });
  s.beginSession();
  for (let t = T0 - 60.5; t <= T0 + 0.95; t += 0.1) s.ingest(us(t), POST, undefined, { register: registerOf('did:plc:steady'), app: null });
  // the second at T0 is not covered yet: someone new in it is not in the window
  s.ingest(us(T0 + 0.99), POST, { register: registerOf('did:plc:late'), app: null });
  assert.equal(s.reading().accounts.active, 1);
});

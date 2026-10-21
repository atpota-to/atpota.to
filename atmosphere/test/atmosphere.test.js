// The counting rules, with the reference's own cases (website/tests/api-atmosphere.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addEvent,
  appDomain,
  conditionFor,
  diversityIndex,
  diversityLevel,
  diversityOf,
  emptyTally,
  eventOf,
  isBluesky,
  isNsid,
  MAX_COLLECTIONS,
  mergeTally,
  NOBODY,
  spreadOf,
  summarize,
} from '../src/atmosphere.js';

const commit = (collection, operation = 'create') => JSON.stringify({ did: 'did:plc:x', kind: 'commit', commit: { operation, collection } });

test('sorts every message into new records (by collection), edits, deletions, identity and account events', () => {
  assert.deepEqual(eventOf(commit('sh.tangled.repo')), { kind: 'create', collection: 'sh.tangled.repo' });
  assert.deepEqual(eventOf(commit('app.bsky.feed.post', 'update')), { kind: 'update' });
  assert.deepEqual(eventOf(commit('app.bsky.feed.post', 'delete')), { kind: 'delete' });
  assert.deepEqual(eventOf(JSON.stringify({ kind: 'identity' })), { kind: 'identity' });
  assert.deepEqual(eventOf(JSON.stringify({ kind: 'account' })), { kind: 'account' });
  // a collection name that isn't an NSID is not counted
  assert.equal(eventOf(commit('<img src=x onerror=alert(1)>')), null);
  assert.equal(eventOf(commit('nodots')), null);
  assert.equal(eventOf('nope'), null);
  assert.equal(eventOf('null'), null);
  assert.equal(eventOf(42), null);
  assert.equal(eventOf(JSON.stringify({ kind: 'commit', commit: { operation: 'create' } })), null);
  assert.equal(eventOf(JSON.stringify({ kind: 'info' })), null);
});

test('tells bluesky from everyone else, and names apps by domain', () => {
  assert.equal(isBluesky('app.bsky.feed.like'), true);
  assert.equal(isBluesky('chat.bsky.actor.declaration'), true);
  assert.equal(isBluesky('app.bskyish.thing'), false);
  assert.equal(appDomain('sh.tangled.repo.pull'), 'tangled.sh');
  assert.equal(appDomain('fyi.unravel.frontpage.post'), 'unravel.fyi');
  assert.equal(isNsid('com.whtwnd.blog.entry'), true);
  assert.equal(isNsid('a.b'), false);
});

test('reads the diversity index like the UV index', () => {
  assert.equal(diversityLevel(0), 'low');
  assert.equal(diversityLevel(2.99), 'low');
  assert.equal(diversityLevel(3), 'moderate');
  assert.equal(diversityLevel(6), 'high');
  assert.equal(diversityLevel(8), 'very high');
  assert.equal(diversityLevel(11), 'extreme');
});

test('names the weather from new records a second (every app)', () => {
  assert.equal(conditionFor(120), 'calm');
  assert.equal(conditionFor(300), 'light');
  assert.equal(conditionFor(458), 'breezy');
  assert.equal(conditionFor(500), 'gusty');
  assert.equal(conditionFor(800), 'stormy');
});

test('sums a sample up: the split, the index, the busiest apps and collections', () => {
  const tally = emptyTally();
  const add = (collection, n) => {
    for (let i = 0; i < n; i++) addEvent(tally, { kind: 'create', collection });
  };
  add('app.bsky.feed.like', 150);
  add('app.bsky.feed.post', 40);
  add('sh.tangled.repo', 4);
  add('sh.tangled.feed.star', 6);
  add('com.whtwnd.blog.entry', 2);
  addEvent(tally, { kind: 'delete' });
  addEvent(tally, { kind: 'identity' });
  const r = summarize(tally, 2, '2026-10-20T00:00:00.000Z', { active: 40, elsewhere: 3, apps: [2, 1] });
  assert.deepEqual(r.records, { perSecond: 101, bluesky: 95, elsewhere: 6 });
  assert.deepEqual(r.diversity, { index: 10.31, level: 'very high', share: 7.5, spread: 1.89, apps: 2, collections: 5 });
  assert.deepEqual(r.apps, [
    { domain: 'tangled.sh', count: 10, perSecond: 5, collections: ['sh.tangled.feed.star', 'sh.tangled.repo'] },
    { domain: 'whtwnd.com', count: 2, perSecond: 1, collections: ['com.whtwnd.blog.entry'] },
  ]);
  assert.deepEqual(r.bluesky.map((b) => b.nsid), ['app.bsky.feed.like', 'app.bsky.feed.post']);
  assert.deepEqual(r.perSecond, { posts: 20, likes: 75, reposts: 0, follows: 0 });
  assert.deepEqual(r.events, { creates: 101, updates: 0, deletes: 0.5, identity: 0.5, account: 0 });
});

test('keeps counting, without names, past MAX_COLLECTIONS collections', () => {
  const tally = emptyTally();
  for (let i = 0; i <= MAX_COLLECTIONS; i++) addEvent(tally, { kind: 'create', collection: `com.spam${i}.thing` });
  assert.equal(tally.creates.size, MAX_COLLECTIONS);
  assert.equal(tally.unnamed, 1);
  assert.equal(summarize(tally, 1, '').records.elsewhere, MAX_COLLECTIONS + 1);
});

test('an empty sample has an index of 0', () => {
  assert.deepEqual(summarize(emptyTally(), 1, '').diversity, { index: 0, level: 'low', share: 0, spread: 0, apps: 0, collections: 0 });
});

test('spread: how many apps a crowd is spread across, as an effective number', () => {
  assert.equal(spreadOf([10, 10, 10, 10]), 4);
  assert.equal(spreadOf([7]), 1);
  assert.equal(spreadOf([]), 0);
  assert.equal(spreadOf([0, 0]), 0);
  // one app with nearly everyone is nearly one app, however many others have an account
  const crowded = spreadOf([990, ...Array(10).fill(1)]);
  assert.ok(crowded > 1 && crowded < 1.1, `got ${crowded}`);
});

test('the diversity index goes by accounts and their spread, not by records', () => {
  assert.deepEqual(diversityOf(NOBODY), { index: 0, share: 0, spread: 0 });
  // half a percent of 10,000 accounts, evenly across ten apps, or all in one
  const even = { active: 10_000, elsewhere: 50, apps: Array(10).fill(5) };
  assert.deepEqual(diversityOf(even), { index: 1.58, share: 0.5, spread: 10 });
  assert.deepEqual(diversityOf({ active: 10_000, elsewhere: 50, apps: [50] }), { index: 0.5, share: 0.5, spread: 1 });
  // one more account, in an app of its own, however many records it writes
  assert.deepEqual(diversityOf({ active: 10_001, elsewhere: 51, apps: [...even.apps, 1] }), { index: 1.65, share: 0.51, spread: 10.53 });
  // sketches can count a few more elsewhere than active
  assert.equal(diversityOf({ active: 3, elsewhere: 4, apps: [4] }).share, 100);
  assert.equal(diversityIndex(0.5, 10), 1.58);
});

test('merging tallies is the same as adding their events one by one, cap included', () => {
  const events = [];
  for (let i = 0; i < MAX_COLLECTIONS + 50; i++) events.push({ kind: 'create', collection: `com.spam${i % (MAX_COLLECTIONS + 25)}.thing` });
  events.push({ kind: 'update' }, { kind: 'delete' }, { kind: 'identity' }, { kind: 'account' });
  const whole = emptyTally();
  events.forEach((e) => addEvent(whole, e));
  const halves = [emptyTally(), emptyTally()];
  events.forEach((e, i) => addEvent(halves[i < events.length / 2 ? 0 : 1], e));
  const merged = mergeTally(mergeTally(emptyTally(), halves[0]), halves[1]);
  assert.deepEqual(summarize(merged, 1, ''), summarize(whole, 1, ''));
  assert.equal(merged.creates.size, MAX_COLLECTIONS);
});

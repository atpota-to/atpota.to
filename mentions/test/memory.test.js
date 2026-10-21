import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db.js';
import {
  notesFrom, publishable, storeMemory, publishMemory, forgetMemory,
  publishLesson, retireLesson, reconcilePublished, MEMORY_COLLECTION, LESSON_COLLECTION,
} from '../src/memory.js';

// Documents in the exact format eve's fileMemory writes (checked against its
// source, eve 0.58.1): a versioned header, then "index: text" lines.
const doc = (...notes) => `<!-- eve-memory-file-v1 lastAllocatedIndex=${notes.length - 1} -->\n`
  + notes.map((n, i) => `${i}: ${n}\n`).join('');
const EMPTY = '<!-- eve-memory-file-v1 lastAllocatedIndex=3 -->\n';

/** A stand-in for the repo writes, recording every call. */
function fakeApi({ failPut = false } = {}) {
  const calls = [];
  return {
    calls,
    async putRecord(collection, rkey, record) {
      calls.push(['put', collection, rkey, record]);
      if (failPut) throw new Error('com.atproto.repo.putRecord failed: 502');
      return { uri: `at://poe/${collection}/${rkey}` };
    },
    async createRecord(collection, record) {
      calls.push(['create', collection, record]);
      return { uri: `at://poe/${collection}/3mtid${calls.length}` };
    },
    async deleteRecord(collection, rkey) {
      calls.push(['delete', collection, rkey]);
      return {};
    },
  };
}
const resolves = async () => true;
let n = 0;
const freshDid = () => `did:plc:memtest${String(++n).padStart(16, '0')}`;

test('notesFrom reads eve\'s document format and nothing else', () => {
  assert.deepEqual(notesFrom(doc('builds a labeler', 'likes short answers')), ['builds a labeler', 'likes short answers']);
  assert.deepEqual(notesFrom(EMPTY), []);
  assert.equal(notesFrom('just some text'), null);
  assert.equal(notesFrom(`${EMPTY}not a numbered line\n`), null);
});

test('a note is published only if it would pass as a reply', () => {
  assert.equal(publishable('runs a PDS at home and likes the technical version'), true);
  assert.equal(publishable('their site is https://example.com'), false, 'no links');
  assert.equal(publishable('x'.repeat(301)), false, 'no longer than a post');
});

test('a saved version is kept, then published as one record per person, keyed by DID', async () => {
  const did = freshDid();
  const api = fakeApi();
  assert.deepEqual(storeMemory(did, doc('builds a labeler')), { ok: true, needsPublish: true });
  assert.equal(await publishMemory(did, { api, didResolves: resolves }), true);
  const [kind, collection, rkey, record] = api.calls[0];
  assert.deepEqual([kind, collection, rkey], ['put', MEMORY_COLLECTION, did]);
  assert.equal(record.$type, MEMORY_COLLECTION);
  assert.equal(record.subject, did);
  assert.deepEqual(record.notes, ['builds a labeler']);
  assert.ok(db.getMemoryDoc(did).published_at);
});

test('each published note carries the date it was first saved, which a later save keeps', async (t) => {
  const did = freshDid();
  const api = fakeApi();
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T10:00:00Z') });
  storeMemory(did, doc('builds a labeler'));
  await publishMemory(did, { api, didResolves: resolves });
  t.mock.timers.setTime(Date.parse('2026-10-21T09:00:00Z'));
  storeMemory(did, doc('builds a labeler', 'their blog is https://example.com/me', 'likes short answers'));
  await publishMemory(did, { api, didResolves: resolves });
  const record = api.calls.at(-1)[3];
  assert.deepEqual(record.notes, ['builds a labeler', 'likes short answers']);
  assert.deepEqual(record.notedAt, ['2026-10-01T10:00:00.000Z', '2026-10-21T09:00:00.000Z']);
  assert.equal(record.updatedAt, '2026-10-21T09:00:00.000Z');
});

test('a note kept from before dates were recorded is dated by its stored version', async (t) => {
  const did = freshDid();
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-24T16:54:46Z') });
  storeMemory(did, doc('builds a labeler'));
  db.db.prepare('UPDATE memory_docs SET noted_at = NULL WHERE did = ?').run(did);
  t.mock.timers.setTime(Date.parse('2026-10-21T09:00:00Z'));
  storeMemory(did, doc('builds a labeler', 'likes short answers'));
  assert.deepEqual(JSON.parse(db.getMemoryDoc(did).noted_at), {
    'builds a labeler': '2026-09-24T16:54:46.000Z',
    'likes short answers': '2026-10-21T09:00:00.000Z',
  });
});

test('the same version again is not republished', async () => {
  const did = freshDid();
  const api = fakeApi();
  storeMemory(did, doc('a'));
  await publishMemory(did, { api, didResolves: resolves });
  assert.deepEqual(storeMemory(did, doc('a')), { ok: true, needsPublish: false });
});

test('notes that fail the publish rules stay private, and are counted', async () => {
  const did = freshDid();
  const api = fakeApi();
  storeMemory(did, doc('builds a labeler', 'their blog is https://example.com/me'));
  await publishMemory(did, { api, didResolves: resolves });
  assert.deepEqual(api.calls[0][3].notes, ['builds a labeler']);
  assert.equal(db.getMemoryDoc(did).held_back, 1);
});

test('probe and test DIDs never reach the repo', async () => {
  const did = freshDid();
  const api = fakeApi();
  storeMemory(did, doc('a probe note'));
  assert.equal(await publishMemory(did, { api, didResolves: async () => false }), false);
  assert.equal(api.calls.length, 0);
  assert.match(db.getMemoryDoc(did).publish_note, /does not resolve/);
  assert.ok(db.getMemoryDoc(did).published_at, 'settled, so the sweep does not retry it forever');
});

test('removing the last note deletes the record', async () => {
  const did = freshDid();
  const api = fakeApi();
  storeMemory(did, doc('a'));
  await publishMemory(did, { api, didResolves: resolves });
  storeMemory(did, EMPTY);
  await publishMemory(did, { api, didResolves: resolves });
  assert.deepEqual(api.calls.at(-1), ['delete', MEMORY_COLLECTION, did]);
});

test('a failed publish is retried by the sweep', async () => {
  const did = freshDid();
  storeMemory(did, doc('a'));
  assert.equal(await publishMemory(did, { api: fakeApi({ failPut: true }), didResolves: resolves }), false);
  assert.equal(db.getMemoryDoc(did).published_at, null);
  const api = fakeApi();
  await reconcilePublished({ api, didResolves: resolves });
  assert.ok(api.calls.some(([k, , rkey]) => k === 'put' && rkey === did));
  assert.ok(db.getMemoryDoc(did).published_at);
});

test('someone who opted out keeps nothing and their record comes down', async () => {
  const did = freshDid();
  const api = fakeApi();
  storeMemory(did, doc('a'));
  await publishMemory(did, { api, didResolves: resolves });
  db.deny(did, 'opt_out', 'test');
  storeMemory(did, doc('a', 'saved during the farewell turn'));
  assert.equal(db.getMemoryDoc(did), undefined, 'nothing kept');
  await publishMemory(did, { api, didResolves: resolves });
  assert.deepEqual(api.calls.at(-1), ['delete', MEMORY_COLLECTION, did]);
});

test('forget-me deletes the droplet copy and the public record', async () => {
  const did = freshDid();
  const api = fakeApi();
  storeMemory(did, doc('a'));
  await forgetMemory(did, { api });
  assert.equal(db.getMemoryDoc(did), undefined);
  assert.deepEqual(api.calls.at(-1), ['delete', MEMORY_COLLECTION, did]);
});

test('emptied notes from "forget me" can never be overtaken by a publish already under way', async () => {
  // The settings page on atpota.to wipes someone's notes in the agent, which
  // hands the emptied version here. A publish of the older version may still
  // be waiting on the network; it must not land after the delete.
  const did = freshDid();
  const api = fakeApi();
  let release;
  const slowResolves = () => new Promise((resolve) => { release = () => resolve(true); });
  storeMemory(did, doc('builds a labeler'));
  const older = publishMemory(did, { api, didResolves: slowResolves });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(storeMemory(did, EMPTY), { ok: true, needsPublish: true });
  const forget = publishMemory(did, { api, didResolves: resolves });
  release();
  await Promise.all([older, forget]);

  assert.deepEqual(api.calls.map(([kind]) => kind).at(-1), 'delete', 'the record ends deleted');
  assert.ok(db.getMemoryDoc(did).published_at, 'and settled, for the empty version');
  assert.deepEqual(JSON.parse(db.getMemoryDoc(did).notes), []);

  // Asked again (every later turn re-sends it): nothing to do, no repo call.
  const before = api.calls.length;
  assert.deepEqual(storeMemory(did, EMPTY), { ok: true, needsPublish: false });
  assert.equal(api.calls.length, before);
});

test('forget-me on Bluesky waits for a publish already under way, then deletes', async () => {
  const did = freshDid();
  const api = fakeApi();
  let release;
  const slowResolves = () => new Promise((resolve) => { release = () => resolve(true); });
  storeMemory(did, doc('builds a labeler'));
  const older = publishMemory(did, { api, didResolves: slowResolves });
  await new Promise((resolve) => setImmediate(resolve));
  const forget = forgetMemory(did, { api });
  release();
  await Promise.all([older, forget]);
  assert.deepEqual(api.calls.map(([kind]) => kind), ['put', 'delete']);
  assert.equal(db.getMemoryDoc(did), undefined);
});

test('a lesson is published as its own record, and taken down when retired', async () => {
  const api = fakeApi();
  const id = db.addLesson('say PDS after the first time', 'did:plc:admin', 'at://did:plc:admin/app.bsky.feed.post/3x');
  await publishLesson(id, { api });
  const [kind, collection, record] = api.calls[0];
  assert.deepEqual([kind, collection], ['create', LESSON_COLLECTION]);
  assert.equal(record.text, 'say PDS after the first time');
  assert.equal(record.source, 'at://did:plc:admin/app.bsky.feed.post/3x');
  const rkey = db.getLesson(id).rkey;
  assert.ok(rkey);
  db.removeLesson(id);
  await retireLesson(id, { api });
  assert.deepEqual(api.calls.at(-1), ['delete', LESSON_COLLECTION, rkey]);
  assert.equal(db.getLesson(id).rkey, null);
});

test('the credential can write replies, likes, notes and lessons, and nothing else', async () => {
  const atproto = await import('../src/atproto.js');
  // Refused before any request is made: the tests' PDS is a closed port, so a
  // request would fail differently.
  await assert.rejects(atproto.putRecord('app.bsky.graph.follow', 'x', {}), /refusing to write to app\.bsky\.graph\.follow/);
  await assert.rejects(atproto.createRecord('app.bsky.feed.repost', {}), /refusing to write/);
  await assert.rejects(atproto.createRecord('app.bsky.graph.block', {}), /refusing to write/);
  await assert.rejects(atproto.deleteRecord('app.bsky.feed.post', 'x'), /refusing to delete from app\.bsky\.feed\.post/);
  await assert.rejects(atproto.deleteRecord('app.bsky.feed.like', 'x'), /refusing to delete from app\.bsky\.feed\.like/);
  // A like gets past the collection check and fails only at the network.
  await assert.rejects(atproto.createRecord('app.bsky.feed.like', {}), (err) => !/refusing/.test(err.message));
});

test('POST /memory: secret required, body checked, 202 once kept', async () => {
  const callback = await import('../src/callback.js');
  const stats = { callbackUnauthorized: 0, callbackInvalid: 0 };
  const server = callback.startCallbackServer({ stats });
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  const post = (body, secret = 'test-secret') => fetch(`http://127.0.0.1:${port}/memory`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atpotato-secret': secret },
    body: JSON.stringify(body),
  });
  try {
    const did = freshDid();
    assert.equal((await post({ did, content: doc('a') }, 'wrong')).status, 401);
    assert.equal((await post({ did: 'not-a-did', content: doc('a') })).status, 400);
    assert.equal((await post({ did, content: 'not an eve document' })).status, 400);
    assert.equal((await post({ did, content: doc('kept from the route') })).status, 202);
    assert.deepEqual(JSON.parse(db.getMemoryDoc(did).notes), ['kept from the route']);
  } finally {
    server.close();
  }
});

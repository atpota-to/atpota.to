// Which records the index keeps, as which rows, and what each Jetstream v2 event does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMIT_TYPE, eventOf, MAX_RECORD_CHARS, PATCH, PETS, SPROUT, TEND, toRow } from '../src/records.js';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const CID = 'bafyreiabcdefghijklmnopqrstuvwxyz234567';
const PATCH_URI = 'at://did:plc:qntsxa2i4sb24noi45fx4np2/to.atpota.garden.patch/autumn-2026';
const SPROUT_URI = `at://${DID}/${SPROUT}/3m4abcdefgh22`;

const patch = (extra = {}) => ({ $type: PATCH, name: 'autumn 2026', season: 'autumn', cols: 12, rows: 8, createdAt: '2026-09-01T00:00:00.000Z', ...extra });
const sprout = (extra = {}) => ({ $type: SPROUT, patch: { uri: PATCH_URI, cid: CID }, kind: 'seed', plot: 7, createdAt: '2026-10-20T22:48:20.000Z', ...extra });
const tend = (extra = {}) => ({ $type: TEND, subject: { uri: SPROUT_URI, cid: CID }, action: 'water', createdAt: '2026-10-21T08:00:00Z', ...extra });

const row = (collection, record, extra = {}) => toRow({ did: DID, collection, rkey: '3m4abcdefgh22', cid: CID, record, ...extra });

test('a patch: no ref, its createdAt as an ISO time', () => {
  const r = row(PATCH, patch(), { rkey: 'self' });
  assert.deepEqual(r, {
    uri: `at://${DID}/${PATCH}/self`,
    did: DID,
    collection: PATCH,
    rkey: 'self',
    cid: CID,
    record: patch(),
    ref_uri: null,
    created_at: '2026-09-01T00:00:00.000Z',
    first_seen_at: null,
  });
  assert.equal(row(PATCH, patch({ name: 3 })), null);
  assert.equal(row(PATCH, patch({ cols: 4.5 })), null);
  assert.equal(row(PATCH, patch({ rows: '8' })), null);
  assert.equal(row(PATCH, patch({ createdAt: undefined })), null);
});

test('a sprout points at its patch, and when Jetstream relayed it is kept', () => {
  const r = row(SPROUT, sprout(), { firstSeenAt: '2026-10-20T22:48:21.567320Z' });
  assert.equal(r.ref_uri, PATCH_URI);
  assert.equal(r.created_at, '2026-10-20T22:48:20.000Z');
  assert.equal(r.first_seen_at, '2026-10-20T22:48:21.567Z');
  assert.equal(row(SPROUT, sprout({ kind: 'rose' })).record.kind, 'rose');
  assert.equal(row(SPROUT, sprout({ patch: { uri: 'https://example.com', cid: CID } })), null, 'not an at:// URI');
  assert.equal(row(SPROUT, sprout({ patch: { uri: PATCH_URI } })), null, 'not a strong ref');
  assert.equal(row(SPROUT, sprout({ patch: PATCH_URI })), null);
  assert.equal(row(SPROUT, sprout({ kind: 'x'.repeat(65) })), null, 'kind over 64');
  assert.equal(row(SPROUT, sprout({ kind: '' })), null);
  assert.equal(row(SPROUT, sprout({ plot: '7' })), null);
  assert.equal(row(SPROUT, sprout({ plot: 1.5 })), null);
});

test('a tend points at its flower', () => {
  assert.equal(row(TEND, tend()).ref_uri, SPROUT_URI);
  assert.equal(row(TEND, tend()).created_at, '2026-10-21T08:00:00.000Z');
  assert.equal(row(TEND, tend({ action: 'x'.repeat(65) })), null);
  assert.equal(row(TEND, tend({ subject: null })), null);
  assert.equal(row(TEND, tend({ action: undefined })), null);
});

test("Poe's pet count: at \"self\" only, a whole number, nothing it points at", () => {
  const pets = (extra = {}) => ({ $type: PETS, count: 120, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', ...extra });
  const r = row(PETS, pets(), { rkey: 'self' });
  assert.equal(r.uri, `at://${DID}/${PETS}/self`);
  assert.equal(r.ref_uri, null);
  assert.equal(r.record.count, 120);
  assert.ok(row(PETS, pets({ count: 0 }), { rkey: 'self' }));
  assert.equal(row(PETS, pets(), { rkey: '3m4abcdefgh22' }), null, 'not at self');
  assert.equal(row(PETS, pets({ count: '120' }), { rkey: 'self' }), null);
  assert.equal(row(PETS, pets({ count: 1.5 }), { rkey: 'self' }), null);
  assert.equal(row(PETS, pets({ count: -1 }), { rkey: 'self' }), null);
  assert.equal(row(PETS, pets({ count: 2 ** 60 }), { rkey: 'self' }), null);
  assert.equal(row(PETS, pets({ createdAt: undefined }), { rkey: 'self' }), null);
  // an update to it arrives like any other, and the rest of Poe's records aren't kept
  assert.equal(eventOf({ $type: COMMIT_TYPE, did: DID, collection: PETS, rkey: 'self', operation: 'update', cid: CID, record: pets({ count: 121 }) }).row.record.count, 121);
  assert.equal(eventOf({ $type: COMMIT_TYPE, did: DID, collection: 'to.atpota.poe.memory', rkey: 'self', operation: 'create', cid: CID, record: {} }), null);
});

test('a createdAt that does not parse, or that Postgres would refuse, is stored as null', () => {
  assert.equal(row(SPROUT, sprout({ createdAt: 'yesterday' })).created_at, null);
  assert.equal(row(SPROUT, sprout({ createdAt: '+275760-09-13T00:00:00.000Z' })).created_at, null);
  assert.equal(row(SPROUT, sprout(), { firstSeenAt: 'soon' }).first_seen_at, null);
});

test('the address, cid, $type and size are checked', () => {
  assert.equal(row(SPROUT, sprout(), { did: 'did:PLC:x' }), null);
  assert.equal(row(SPROUT, sprout(), { did: 'not-a-did' }), null);
  assert.equal(row(SPROUT, sprout(), { rkey: 'a/b' }), null);
  assert.equal(row(SPROUT, sprout(), { rkey: '' }), null);
  assert.equal(row(SPROUT, sprout(), { cid: 'short' }), null);
  assert.equal(row(SPROUT, sprout(), { cid: undefined }), null);
  assert.equal(row('app.bsky.feed.post', { ...sprout(), $type: 'app.bsky.feed.post' }), null, 'not a garden collection');
  assert.equal(row(SPROUT, sprout({ $type: TEND })), null, '$type must be the collection');
  assert.equal(row(SPROUT, sprout({ $type: undefined })), null);
  assert.equal(row(SPROUT, [sprout()]), null);
  assert.equal(row(SPROUT, null), null);
  const padding = 'x'.repeat(MAX_RECORD_CHARS);
  assert.equal(row(PATCH, patch({ note: padding })), null, 'over 20,000 characters');
  assert.ok(row(PATCH, patch({ note: 'x'.repeat(MAX_RECORD_CHARS - JSON.stringify(patch({ note: '' })).length) })), 'exactly at the cap is fine');
});

test('strings Postgres can not hold in jsonb make a record junk', () => {
  assert.equal(row(PATCH, patch({ note: 'a\u0000b' })), null);
  assert.equal(row(PATCH, patch({ note: 'lone \ud800 high' })), null);
  assert.equal(row(PATCH, patch({ note: 'lone \udc00 low' })), null);
  assert.ok(row(PATCH, patch({ note: 'a real pair 🌻' })));
});

const commit = (operation, extra = {}) => ({
  $type: COMMIT_TYPE,
  did: DID,
  collection: SPROUT,
  rkey: '3m4abcdefgh22',
  operation,
  rev: '3m4abcdefgh22',
  seq: 26252275534,
  time: '2026-10-20T22:48:21.567320Z',
  witnessedAt: '2026-10-20T22:48:21.400000Z',
  ...(operation === 'delete' ? {} : { cid: CID, record: sprout() }),
  ...extra,
});

test('a create is an upsert that keeps when Jetstream relayed it', () => {
  const e = eventOf(commit('create'));
  assert.equal(e.op, 'upsert');
  assert.equal(e.row.uri, SPROUT_URI);
  assert.equal(e.row.first_seen_at, '2026-10-20T22:48:21.567Z');
  assert.equal(eventOf(commit('create', { time: 'nope' })).row.first_seen_at, null);
});

test('an update is an upsert with no first-seen time (garden_apply keeps the first)', () => {
  const e = eventOf(commit('update', { record: sprout({ plot: 9 }) }));
  assert.equal(e.op, 'upsert');
  assert.equal(e.row.first_seen_at, null);
  assert.equal(e.row.record.plot, 9);
});

test('a delete, and a create or update that fails the checks, is a delete', () => {
  assert.deepEqual(eventOf(commit('delete')), { op: 'delete', uri: SPROUT_URI });
  assert.deepEqual(eventOf(commit('update', { record: sprout({ kind: 42 }) })), { op: 'delete', uri: SPROUT_URI });
  assert.deepEqual(eventOf(commit('create', { record: { ...sprout(), $type: PATCH } })), { op: 'delete', uri: SPROUT_URI }, '$type mismatch');
  assert.deepEqual(eventOf(commit('create', { cid: undefined })), { op: 'delete', uri: SPROUT_URI });
  assert.deepEqual(eventOf(commit('create', { record: patch({ note: 'x'.repeat(MAX_RECORD_CHARS) }), collection: PATCH })), { op: 'delete', uri: `at://${DID}/${PATCH}/3m4abcdefgh22` });
});

test('anything else is not the index\'s business', () => {
  assert.equal(eventOf(commit('create', { collection: 'app.bsky.feed.post' })), null);
  assert.equal(eventOf(commit('create', { $type: 'network.bsky.jetstream.subscribeEvents#identity' })), null);
  assert.equal(eventOf(commit('create', { did: 'nope' })), null);
  assert.equal(eventOf(commit('delete', { rkey: '../x' })), null);
  assert.equal(eventOf(commit('resync')), null);
  assert.equal(eventOf(null), null);
  assert.equal(eventOf('commit'), null);
  // v1's shape (fields under `commit`) matches nothing
  assert.equal(eventOf({ did: DID, time_us: 1, kind: 'commit', commit: { operation: 'create', collection: SPROUT, rkey: 'x', record: sprout() } }), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as storage from '../src/db.js';

// What droplet/deploy.sh waits on before restarting the service.

let key = 0;
const match = () => {
  const rkey = `inflight${++key}`;
  const uri = `at://did:plc:asker/app.bsky.feed.post/${rkey}`;
  return { did: 'did:plc:asker', rkey, uri, cid: 'bafytest', authorDid: 'did:plc:asker',
    authorHandle: 'asker.bsky.social', text: 'hi poe', reason: 'mention', source: 'jetstream',
    threadRoot: uri, rootUri: uri, rootCid: 'bafytest', parentUri: uri, parentCid: 'bafytest' };
};

test('open work is every reply that has not settled yet, and nothing else', () => {
  assert.deepEqual(storage.openWork(), []);
  const matched = storage.enqueue(match());
  const sent = storage.enqueue(match());
  storage.setStatus(sent, 'sent_to_agent', { sent_at: storage.nowIso() });
  const drafting = storage.enqueue(match());
  storage.setStatus(drafting, 'drafted', { drafted_at: storage.nowIso() });
  const posted = storage.enqueue(match());
  storage.setStatus(posted, 'posted', { settled_at: storage.nowIso() });
  const settledDraft = storage.enqueue(match());
  storage.setStatus(settledDraft, 'drafted', { drafted_at: storage.nowIso(), settled_at: storage.nowIso() });
  assert.deepEqual(storage.openWork(), [
    { status: 'drafted', n: 1 },
    { status: 'matched', n: 1 },
    { status: 'sent_to_agent', n: 1 },
  ]);
  for (const id of [matched, sent, drafting]) storage.setStatus(id, 'posted', { settled_at: storage.nowIso() });
  assert.deepEqual(storage.openWork(), []);
});

test('a row stuck for longer than the window is left to the sweep and does not block', () => {
  const stuck = storage.enqueue(match());
  const old = new Date(Date.now() - 45 * 60_000).toISOString();
  storage.setStatus(stuck, 'sent_to_agent', { matched_at: old, sent_at: old });
  assert.deepEqual(storage.openWork(), []);
  assert.deepEqual(storage.openWork(60), [{ status: 'sent_to_agent', n: 1 }]);
  storage.setStatus(stuck, 'posted', { settled_at: storage.nowIso() });
});

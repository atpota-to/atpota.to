import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { db } from '../src/db.js';
import { startCallbackServer } from '../src/callback.js';

const authorDid = 'did:plc:scanbudgettest';
const postUri = `at://${authorDid}/app.bsky.feed.post/claim1`;
const body = { sessionId: 'thread-session', postUri, attempt: 1 };
const stats = () => ({ callbackUnauthorized: 0 });

async function serverUrl(server) {
  await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}/internal/scan-budget/claim`;
}

async function claim(url, payload = body, secret = config.sharedSecret) {
  const response = await fetch(url, { method: 'POST',
    headers: { 'x-atpotato-secret': secret, 'content-type': 'application/json' },
    body: JSON.stringify(payload) });
  return { status: response.status, body: await response.json() };
}

test('scan budget claim authenticates, validates the exact pending dispatch, and admits one parallel caller', async () => {
  db.prepare(`INSERT INTO queue (did, rkey, uri, cid, author_did, text, reason, thread_root,
    root_uri, root_cid, parent_uri, parent_cid, status, source, matched_at, attempts)
    VALUES (?, 'claim1', ?, 'cid', ?, 'question', 'mention', ?, ?,
      'cid', ?, 'cid', 'sent_to_agent', 'jetstream', ?, 1)`)
    .run(authorDid, postUri, authorDid, postUri, postUri, postUri, new Date().toISOString());
  const server = startCallbackServer({ stats: stats() });
  const url = await serverUrl(server);
  try {
    assert.equal((await claim(url, body, 'bad-secret')).status, 401);
    for (const invalid of [null, [], {}, { ...body, sessionId: ' ' },
      { ...body, postUri: 'not a post' }, { ...body, attempt: 0 },
      { ...body, attempt: '1' }]) {
      assert.equal((await claim(url, invalid)).status, 400);
    }
    assert.equal((await claim(url, { ...body, postUri: `at://did:plc:unknown/app.bsky.feed.post/claim1` })).status, 409);
    assert.equal((await claim(url, { ...body, attempt: 2 })).status, 409);
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) =>
      claim(url, { ...body, sessionId: `worker-${i}` })));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.ok(results.filter((r) => r.status === 409).length === 15);
    assert.deepEqual(results.find((r) => r.status === 200).body, { ok: true });
    assert.equal((await claim(url, body)).status, 409, 'even the first session cannot reclaim');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scan_budget_claims WHERE post_uri = ?').get(postUri).n, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // A new server and a new dispatch attempt do not reset or inherit the old claim.
  const restarted = startCallbackServer({ stats: stats() });
  const restartedUrl = await serverUrl(restarted);
  try {
    assert.equal((await claim(restartedUrl)).status, 409);
    db.prepare("UPDATE queue SET attempts = 2, status = 'drafted' WHERE uri = ?").run(postUri);
    assert.equal((await claim(restartedUrl, { ...body, attempt: 2 })).status, 409);
    db.prepare("UPDATE queue SET status = 'sent_to_agent' WHERE uri = ?").run(postUri);
    assert.equal((await claim(restartedUrl, { ...body, attempt: 2 })).status, 200);
    assert.equal((await claim(restartedUrl, { ...body, attempt: 2, sessionId: 'another-worker' })).status, 409);
    assert.equal((await claim(restartedUrl, body)).status, 409);
    assert.deepEqual(db.prepare('SELECT attempt FROM scan_budget_claims WHERE post_uri = ? ORDER BY attempt')
      .all(postUri).map((r) => r.attempt), [1, 2]);
  } finally {
    await new Promise((resolve) => restarted.close(resolve));
  }
});

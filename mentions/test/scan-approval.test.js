import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { config } from '../src/config.js';
import * as storage from '../src/db.js';
const { db } = storage;
import { startCallbackServer } from '../src/callback.js';
import { applyNapCommand } from '../src/nap.js';
import { APPROVAL_ADMIN_DID, approvalPost, interceptApprovalReply,
  requestScanApproval, retryApprovalResponses } from '../src/scan-approval.js';
import { processMatch } from '../src/pipeline.js';
import { matchPost } from '../src/matcher.js';

const originalAdmins = config.adminDids;
config.adminDids = [APPROVAL_ADMIN_DID];
const sourceDid = 'did:plc:scanrequester';
const uri = `at://${sourceDid}/app.bsky.feed.post/request1`;
const stats = () => ({ self: 0, duplicates: 0, matched: 0 });
function signed(overrides = {}) {
  const body = { sessionId: 'session', requestId: 'req1', turnId: 'turn1', postUri: uri,
    attempt: 1, expiresAt: Date.now() + 24 * 60 * 60_000 - 60_000, ...overrides };
  return { ...body, approvalToken: createHmac('sha256', config.sharedSecret)
    .update(JSON.stringify(['scan-approval-v1', body.sessionId, body.requestId, body.turnId,
      body.postUri, body.attempt, body.expiresAt])).digest('hex') };
}
const request = signed();
const row = () => db.prepare('SELECT * FROM scan_approvals WHERE request_id = ?').get(request.requestId);
let calls = 0;
const api = { async putRecord(collection, rkey, post) {
  calls++;
  assert.equal(collection, 'app.bsky.feed.post');
  assert.match(rkey, /^scan-[a-f0-9]{40}$/);
  assert.equal(post.reply.parent.uri, uri);
  return { uri: `at://${config.botDid}/app.bsky.feed.post/${rkey}`, cid: 'escalation-cid' };
} };
const match = (authorDid, text, parent = row().escalation_uri, id = 'reply1') => ({
  reason: 'reply', authorDid, did: authorDid, text, upstreamUri: parent, upstreamCid: 'escalation-cid',
  uri: `at://${authorDid}/app.bsky.feed.post/${id}`, rkey: id, source: 'jetstream',
});

function seedQueue() {
  db.prepare(`INSERT INTO queue (did, rkey, uri, cid, author_did, text, reason, thread_root,
    root_uri, root_cid, parent_uri, parent_cid, status, source, matched_at, attempts)
    VALUES (?, 'request1', ?, 'request-cid', ?, 'question', 'mention', ?, ?,
      'request-cid', ?, 'request-cid', 'sent_to_agent', 'jetstream', ?, 1)`)
    .run(sourceDid, uri, sourceDid, uri, uri, uri, new Date().toISOString());
}

test('authenticated request creates one escalation with a real UTF-8 mention facet', async () => {
  seedQueue();
  const server = startCallbackServer({ stats: { callbackUnauthorized: 0 } });
  await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/internal/scan-approval/request`;
  try {
    let res = await fetch(url, { method: 'POST', body: JSON.stringify(request) });
    assert.equal(res.status, 401);
    res = await fetch(url, { method: 'POST', headers: { 'x-atpotato-secret': config.sharedSecret },
      body: JSON.stringify(signed({ attempt: 2 })) });
    assert.equal(res.status, 409);
    res = await fetch(url, { method: 'POST', headers: { 'x-atpotato-secret': config.sharedSecret },
      body: JSON.stringify({ ...request, turnId: 'forged' }) });
    assert.equal(res.status, 400, 'a modified signed field cannot reach the database');
    // Exercise the handler through the injected PDS client, without network access.
    const first = await requestScanApproval(request, { api });
    assert.equal(first.status, 200);
    assert.equal(first.body.escalationCid, 'escalation-cid');
    assert.equal(calls, 1);
    assert.equal((await requestScanApproval(request, { api })).body.escalationUri, first.body.escalationUri);
    assert.equal(calls, 1);
    assert.equal((await requestScanApproval(signed({ turnId: 'different' }), { api })).status, 409);
    assert.equal((await requestScanApproval({ ...request, approvalToken: 'f'.repeat(64) }, { api })).status, 400);
    assert.equal((await requestScanApproval({ ...request, approvalToken: 'not-hex' }, { api })).status, 400);
    assert.equal((await requestScanApproval(signed({ expiresAt: Date.now() + 24 * 60 * 60_000 + 1000 }), { api })).status, 409);
    assert.equal((await requestScanApproval(signed({ requestId: 'too-late', expiresAt: Date.now() + 24 * 60 * 60_000 + 1000 }), { api })).status, 400);
    assert.equal((await requestScanApproval(signed({ requestId: 'too-early', expiresAt: Date.now() - 1000 }), { api })).status, 400);
    assert.equal((await requestScanApproval({ ...request, expiresAt: 'tomorrow' }, { api })).status, 400);
    assert.equal((await requestScanApproval(signed({ requestId: 'another', attempt: 2 }), { api })).status, 409);
    const post = approvalPost({ ...db.prepare('SELECT * FROM queue WHERE uri = ?').get(uri), created_at: row().created_at });
    const facet = post.facets[0];
    assert.equal(Buffer.from(post.text).subarray(facet.index.byteStart, facet.index.byteEnd).toString(), '@dame.is');
    assert.equal(facet.index.byteStart, Buffer.byteLength('🥔 '));
    assert.deepEqual(facet.features, [{ $type: 'app.bsky.richtext.facet#mention', did: APPROVAL_ADMIN_DID }]);
    assert.equal(row().status, 'awaiting');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('wrong DID and parent do not claim; one direct admin reply is forwarded and replay is inert', async () => {
  const sent = [];
  const fetcher = async (_url, init) => { sent.push({ headers: init.headers, body: JSON.parse(init.body) }); return { ok: true }; };
  assert.equal(await interceptApprovalReply(match(APPROVAL_ADMIN_DID, 'approve', uri), { fetcher }), false);
  assert.equal(await interceptApprovalReply(match(sourceDid, 'approve', undefined, 'other'), { fetcher }), true);
  assert.equal(await interceptApprovalReply({ ...match(APPROVAL_ADMIN_DID, 'approve'), upstreamCid: 'wrong-cid' }, { fetcher }), true);
  assert.equal(await interceptApprovalReply(match(APPROVAL_ADMIN_DID, 'please approve'), { fetcher }), true);
  assert.equal(sent.length, 0);
  const signedMatch = matchPost({ did: APPROVAL_ADMIN_DID, rkey: 'signedapproval', cid: 'signed-cid',
    record: { text: ' APPROVE ', reply: {
      parent: { uri: row().escalation_uri, cid: row().escalation_cid },
      root: { uri, cid: 'request-cid' },
    } } }, config.botDid);
  assert.equal(signedMatch.authorDid, APPROVAL_ADMIN_DID);
  assert.equal(await interceptApprovalReply(signedMatch, { fetcher }), true);
  assert.equal(row().status, 'forwarded');
  assert.equal(row().approval_token, request.approvalToken);
  assert.equal(row().bot_expires_at, request.expiresAt);
  assert.deepEqual(sent[0].body, { ...request, optionId: 'approve', adminDid: APPROVAL_ADMIN_DID });
  assert.equal(sent[0].headers['x-atpotato-secret'], config.sharedSecret);
  assert.equal(await processMatch(signedMatch, stats()), 'scan_approval');
  assert.equal(await processMatch(match(APPROVAL_ADMIN_DID, 'deny', undefined, 'later'), stats()), 'scan_approval');
  assert.equal(sent.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM queue').get().n, 1);
});

test('reconciliation holds only live approvals for the current attempt, then releases expired ones', async () => {
  const approval = signed({ requestId: 'hold-query' });
  assert.equal((await requestScanApproval(approval, { api })).status, 200);
  const now = new Date();
  const cutoff = new Date(now.getTime() - 20 * 60_000).toISOString();
  const oldSent = new Date(now.getTime() - 25 * 60_000).toISOString();
  db.prepare('UPDATE queue SET sent_at = ? WHERE uri = ?').run(oldSent, uri);
  const id = db.prepare('SELECT id FROM queue WHERE uri = ?').get(uri).id;
  const query = (max) => max === 2
    ? storage.stuckRows(cutoff, max, now.toISOString())
    : storage.abandonedRows(cutoff, max, now.toISOString());
  for (const status of ['posting', 'awaiting', 'responding']) {
    db.prepare('UPDATE scan_approvals SET status = ? WHERE request_id = ?').run(status, approval.requestId);
    assert.ok(!query(2).some((q) => q.id === id), `${status} must block redispatch`);
    assert.ok(!query(1).some((q) => q.id === id), `${status} must block abandonment`);
  }
  db.prepare('UPDATE queue SET attempts = 2 WHERE id = ?').run(id);
  assert.ok(storage.stuckRows(cutoff, 3, now.toISOString()).some((q) => q.id === id),
    'approval from the previous attempt cannot block the current one');
  db.prepare('UPDATE queue SET attempts = 1 WHERE id = ?').run(id);
  db.prepare('UPDATE scan_approvals SET status = ?, expires_at = ? WHERE request_id = ?')
    .run('awaiting', new Date(now.getTime() - 1000).toISOString(), approval.requestId);
  assert.ok(query(2).some((q) => q.id === id), 'expiry releases a retryable turn');
  assert.ok(query(1).some((q) => q.id === id), 'expiry also releases an exhausted turn');
  await retryApprovalResponses({ now, fetcher: async () => { throw new Error('must not forward'); } });
  assert.equal(db.prepare('SELECT status FROM scan_approvals WHERE request_id = ?').get(approval.requestId).status, 'expired');
  db.prepare('UPDATE queue SET sent_at = NULL WHERE id = ?').run(id);
});

test('bot 409 closes the approval with a reason; transient 503 is retried only once', async () => {
  for (const [requestId, detail, expected] of [
    ['bot-expired', 'approval expired', 'expired'],
    ['bot-settled', 'request already settled', 'rejected'],
  ]) {
    assert.equal((await requestScanApproval(signed({ requestId }), { api })).status, 200);
    const approval = db.prepare('SELECT * FROM scan_approvals WHERE request_id = ?').get(requestId);
    let calls = 0;
    const fetcher = async () => { calls++; return { ok: false, status: 409, text: async () => detail }; };
    await interceptApprovalReply(match(APPROVAL_ADMIN_DID, 'approve', approval.escalation_uri, `${requestId}-reply`), { fetcher });
    const settled = db.prepare('SELECT status, failure_reason FROM scan_approvals WHERE request_id = ?').get(requestId);
    assert.equal(settled.status, expected);
    assert.match(settled.failure_reason, /bot responded 409/);
    assert.equal((await requestScanApproval(signed({ requestId, expiresAt: approval.bot_expires_at }), { api })).status,
      expected === 'expired' ? 410 : 409);
    await retryApprovalResponses({ fetcher });
    assert.equal(calls, 1, 'permanent 409 must not be forwarded again');
  }
  const requestId = 'bot-temporary';
  assert.equal((await requestScanApproval(signed({ requestId }), { api })).status, 200);
  const approval = db.prepare('SELECT escalation_uri FROM scan_approvals WHERE request_id = ?').get(requestId);
  let calls = 0;
  const fetcher = async () => (++calls === 1 ? { ok: false, status: 503 } : { ok: true });
  await interceptApprovalReply(match(APPROVAL_ADMIN_DID, 'deny', approval.escalation_uri, 'temporary-reply'), { fetcher });
  assert.equal(db.prepare('SELECT status FROM scan_approvals WHERE request_id = ?').get(requestId).status, 'responding');
  await retryApprovalResponses({ fetcher });
  await retryApprovalResponses({ fetcher });
  assert.equal(calls, 2);
  assert.equal(db.prepare('SELECT status FROM scan_approvals WHERE request_id = ?').get(requestId).status, 'forwarded');
});

test('failed forward is persisted and retried once; expiry and pause block decisions', async () => {
  const uncertain = signed({ requestId: 'uncertain' });
  let writes = 0;
  const flakyApi = { async putRecord(_collection, rkey, post) {
    writes++;
    assert.equal(post.createdAt, db.prepare("SELECT created_at FROM scan_approvals WHERE request_id = 'uncertain'").get().created_at);
    if (writes === 1) throw new Error('response lost after write');
    return { cid: 'same-post-cid', uri: `at://${config.botDid}/app.bsky.feed.post/${rkey}` };
  } };
  assert.equal((await requestScanApproval(uncertain, { api: flakyApi })).status, 503);
  const firstUri = db.prepare("SELECT escalation_uri FROM scan_approvals WHERE request_id = 'uncertain'").get().escalation_uri;
  assert.equal((await requestScanApproval(uncertain, { api: flakyApi })).status, 200);
  assert.equal(db.prepare("SELECT escalation_uri FROM scan_approvals WHERE request_id = 'uncertain'").get().escalation_uri, firstUri);
  assert.equal(writes, 2);
  const short = signed({ requestId: 'short', expiresAt: Date.now() + 60_000 });
  assert.equal((await requestScanApproval(short, { api })).status, 200);
  assert.equal(db.prepare("SELECT bot_expires_at FROM scan_approvals WHERE request_id = 'short'").get().bot_expires_at, short.expiresAt);
  assert.ok(Date.parse(db.prepare("SELECT expires_at FROM scan_approvals WHERE request_id = 'short'").get().expires_at) <= short.expiresAt);
  const next = signed({ requestId: 'req2', turnId: 'turn2' });
  assert.equal((await requestScanApproval(next, { api })).status, 200);
  let tries = 0;
  const attempts = [];
  const fetcher = async (_url, init) => {
    attempts.push(JSON.parse(init.body));
    tries++;
    if (tries === 1) throw new Error('offline');
    return { ok: true };
  };
  assert.equal(await interceptApprovalReply(match(APPROVAL_ADMIN_DID, 'deny',
    db.prepare('SELECT escalation_uri FROM scan_approvals WHERE request_id = ?').get('req2').escalation_uri, 'retry'), { fetcher }), true);
  assert.equal(db.prepare('SELECT status FROM scan_approvals WHERE request_id = ?').get('req2').status, 'responding');
  await retryApprovalResponses({ fetcher });
  await retryApprovalResponses({ fetcher });
  assert.equal(tries, 2);
  assert.deepEqual(attempts[0], attempts[1], 'the retry forwards the same signed token and expiry');
  assert.deepEqual(attempts[1], { ...next, optionId: 'deny', adminDid: APPROVAL_ADMIN_DID });
  const expired = signed({ requestId: 'expired' });
  await requestScanApproval(expired, { api });
  db.prepare("UPDATE scan_approvals SET expires_at = '2000-01-01T00:00:00.000Z' WHERE request_id = 'expired'").run();
  assert.equal((await requestScanApproval(expired, { api })).status, 410);
  assert.equal(await interceptApprovalReply(match(APPROVAL_ADMIN_DID, 'approve',
    db.prepare("SELECT escalation_uri FROM scan_approvals WHERE request_id = 'expired'").get().escalation_uri, 'expiredreply'), { fetcher }), true);
  assert.equal(tries, 2);
  await requestScanApproval(signed({ requestId: 'during-nap' }), { api });
  const duringNapUri = db.prepare("SELECT escalation_uri FROM scan_approvals WHERE request_id = 'during-nap'").get().escalation_uri;
  applyNapCommand('scan-nap-test', { kind: 'nap', until: new Date(Date.now() + 60000).toISOString() });
  assert.equal((await requestScanApproval(signed({ requestId: 'paused' }), { api })).status, 503);
  await interceptApprovalReply(match(APPROVAL_ADMIN_DID, 'approve', duringNapUri, 'napreply'), { fetcher });
  assert.equal(db.prepare("SELECT status FROM scan_approvals WHERE request_id = 'during-nap'").get().status, 'responding');
  assert.equal(tries, 2);
  applyNapCommand('scan-wake-test', { kind: 'wake' });
  await retryApprovalResponses({ fetcher });
  assert.equal(tries, 3);
  config.adminDids = originalAdmins;
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import * as storage from '../src/db.js';
import { applyNapCommand, isNapping, pendingNapScan, finishNapScan } from '../src/nap.js';
import { sweepNotifications } from '../src/notifications.js';
import { processMatch } from '../src/pipeline.js';
import { resumeNapReplies } from '../src/reconcile.js';
import '../src/operator-dm.js'; // Registers the same style-feedback table as the live service.

const author = 'did:plc:nap-replay-author';
const stats = () => ({ matched: 0, duplicates: 0, self: 0, gated: 0, passed: 0, byGate: {}, dispatched: 0, dispatchErrors: 0 });
let serial = 0;
const older = () => new Date(Date.now() - 3600000).toISOString();
function savedMatch(text = 'what does this record mean?', createdAt = older()) {
  const rkey = `napreplay${++serial}`;
  const uri = `at://${author}/app.bsky.feed.post/${rkey}`;
  return { did: author, rkey, uri, cid: `cid${serial}`, authorDid: author,
    authorHandle: 'nap-replay.test', text, reason: 'reply', source: 'jetstream',
    threadRoot: uri, rootUri: uri, rootCid: `cid${serial}`, parentUri: uri,
    parentCid: `cid${serial}`, recordCreated: createdAt };
}
function hydrated(match) {
  return { uri: match.uri, cid: match.cid, author: { did: author, handle: 'nap-replay.test' },
    record: { text: match.text, createdAt: match.recordCreated, reply: {
      parent: { uri: `at://${config.botDid}/app.bsky.feed.post/parent`, cid: 'parentcid' },
      root: { uri: match.uri, cid: match.cid },
    } } };
}
function nap(source) { applyNapCommand(`nap-replay:${source}`, { kind: 'nap', until: null }); }
function wake(source) { applyNapCommand(`nap-replay:wake:${source}`, { kind: 'wake' }); }

test('wake replays saved old posts through normal gates without claiming a duplicate', async () => {
  nap('first');
  const match = savedMatch();
  assert.equal(await processMatch(match, stats()), 'paused');
  wake('first');
  assert.equal(isNapping(), false);
  assert.equal(config.stage, 4);
  assert.equal(config.dryRun, false);
  assert.equal(storage.db.prepare('SELECT gate FROM queue WHERE uri = ?').get(match.uri).gate, 'nap');
  assert.equal(await resumeNapReplies(stats(), {
    api: { getPosts: async (uris) => {
      assert.deepEqual(uris, [match.uri]);
      return { posts: [hydrated(match)] };
    } },
  }), 1);
  const row = storage.db.prepare('SELECT status, gate, attempts FROM queue WHERE uri = ?').get(match.uri);
  assert.notEqual(row.status, 'paused');
  assert.notEqual(row.gate, 'staleness');
  assert.equal(row.attempts, 1);
  assert.equal(await processMatch(match, stats()), 'duplicate');
});

test('missing or edited posts cannot receive a catch-up reply', async () => {
  nap('missing');
  const missing = savedMatch();
  const edited = savedMatch();
  await processMatch(missing, stats());
  await processMatch(edited, stats());
  wake('missing');
  const run = () => resumeNapReplies(stats(), { api: { getPosts: async () => ({
    posts: [{ ...hydrated(edited), cid: 'edited-cid' }],
  }) } });
  await run();
  assert.equal(storage.db.prepare('SELECT gate FROM queue WHERE uri = ?').get(edited.uri).gate, 'changed_on_wake');
  assert.equal(storage.db.prepare('SELECT status FROM queue WHERE uri = ?').get(missing.uri).status, 'paused');
  storage.db.prepare('UPDATE queue SET sent_at = NULL WHERE uri = ?').run(missing.uri);
  await run();
  storage.db.prepare('UPDATE queue SET sent_at = NULL WHERE uri = ?').run(missing.uri);
  await run();
  assert.equal(storage.db.prepare('SELECT gate FROM queue WHERE uri = ?').get(missing.uri).gate, 'unavailable_on_wake');
});

test('old in-flight drafts are invalidated before catch-up dispatch', async () => {
  const match = savedMatch();
  const id = storage.enqueue(match, 'sent_to_agent');
  storage.db.prepare(`UPDATE queue SET attempts = 1, draft_key = 'stale-key' WHERE id = ?`).run(id);
  nap('draft');
  assert.equal(storage.getQueueRow(id).status, 'paused');
  wake('draft');
  await resumeNapReplies(stats(), { api: { getPosts: async () => ({ posts: [hydrated(match)] }) } });
  const row = storage.getQueueRow(id);
  assert.equal(row.attempts, 2);
  assert.equal(row.draft_key, null);
  assert.equal(storage.findPendingByPostUri(match.uri, match.threadRoot, 1), undefined);
});

test('old operator commands found in a wake scan cannot change nap state', async () => {
  config.adminDids = [author];
  const oldCommand = savedMatch('nap: until i wake you');
  assert.equal(await processMatch(oldCommand, stats(), { napReplay: true }), 'old_nap_command');
  assert.equal(isNapping(), false);
});

test('already-partially-posted rows are not dispatched again', async () => {
  nap('partial');
  const match = savedMatch();
  await processMatch(match, stats());
  const row = storage.db.prepare('SELECT id FROM queue WHERE uri = ?').get(match.uri);
  storage.recordReply({ queueId: row.id, authorDid: author, inReplyTo: match.uri,
    replyUri: `at://${config.botDid}/app.bsky.feed.post/partial`, replyCid: 'cid',
    text: 'first half', postCount: 1 });
  wake('partial');
  await resumeNapReplies(stats(), { api: { getPosts: async () => ({ posts: [hydrated(match)] }) } });
  assert.equal(storage.db.prepare('SELECT status FROM queue WHERE id = ?').get(row.id).status, 'posted');
  assert.equal(storage.db.prepare('SELECT COUNT(*) AS n FROM replies WHERE queue_id = ?').get(row.id).n, 1);
});

test('wake notification scan pages past already-seen posts and resumes from its cursor', async () => {
  finishNapScan();
  nap('scan');
  wake('scan');
  const since = pendingNapScan().since;
  let page = 0;
  const api = { listNotifications: async ({ cursor }) => {
    assert.equal(cursor ?? null, page ? `page${page}` : null);
    page++;
    return { notifications: [{ reason: 'like', indexedAt: new Date(Date.parse(since) + 1000).toISOString() }],
      cursor: `page${page}` };
  } };
  await sweepNotifications({ sweeps: 0, sweepFound: 0, sweepErrors: 0 }, { napCatchup: true, api });
  assert.equal(page, 20);
  assert.equal(pendingNapScan().cursor, 'page20');
  api.listNotifications = async ({ cursor }) => {
    assert.equal(cursor, 'page20');
    return { notifications: [{ reason: 'like', indexedAt: new Date(Date.parse(since) - 1000).toISOString() }],
      cursor: 'page21' };
  };
  await sweepNotifications({ sweeps: 0, sweepFound: 0, sweepErrors: 0 }, { napCatchup: true, api });
  assert.equal(pendingNapScan(), null);
});

test('wake scan discovers and processes an older reply Jetstream missed', async () => {
  nap('gap');
  const missed = savedMatch();
  storage.db.prepare('UPDATE nap_state SET started_at = ? WHERE id = 1')
    .run(new Date(Date.now() - 2 * 3600000).toISOString());
  wake('gap');
  const record = hydrated(missed);
  await sweepNotifications({ ...stats(), sweeps: 0, sweepFound: 0, sweepErrors: 0 }, {
    napCatchup: true,
    api: { listNotifications: async () => ({ notifications: [{ reason: 'reply',
      uri: missed.uri, cid: missed.cid, record: record.record,
      author: { did: author, handle: 'nap-replay.test' }, indexedAt: new Date().toISOString(),
    }] }) },
  });
  const row = storage.db.prepare('SELECT status, gate, attempts FROM queue WHERE uri = ?').get(missed.uri);
  assert.ok(row);
  assert.equal(row.attempts, 1);
  assert.notEqual(row.gate, 'staleness');
  assert.equal(pendingNapScan(), null);
});

test('replay is held while sleeping and expiry makes rows eligible', async () => {
  nap('expiry');
  const match = savedMatch();
  await processMatch(match, stats());
  assert.equal(await resumeNapReplies(stats(), { api: { getPosts: async () => { throw new Error('still asleep'); } } }), 0);
  assert.equal(isNapping(), true);
  applyNapCommand('nap-replay:expired', { kind: 'nap', until: older() });
  assert.equal(isNapping(), false);
  await resumeNapReplies(stats(), { api: { getPosts: async () => ({ posts: [hydrated(match)] }) } });
  assert.notEqual(storage.db.prepare('SELECT status FROM queue WHERE uri = ?').get(match.uri).status, 'paused');
});

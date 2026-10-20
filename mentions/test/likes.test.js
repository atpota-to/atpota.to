import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import * as db from '../src/db.js';
import { receiveLikeProposal, sendProposedLike } from '../src/likes.js';

let n = 0;
/** A matched post whose turn is with the agent, as the pipeline leaves it. */
function turn({ author = `did:plc:person${++n}`, attempts = 1, source = 'jetstream' } = {}) {
  const rkey = `post${n}${Math.random().toString(36).slice(2, 6)}`;
  const uri = `at://${author}/app.bsky.feed.post/${rkey}`;
  const id = db.enqueue({
    did: author, rkey, uri, cid: `bafy${rkey}`, authorDid: author, text: 'a lovely post',
    reason: 'mention', threadRoot: uri, rootUri: uri, rootCid: `bafy${rkey}`,
    parentUri: uri, parentCid: `bafy${rkey}`, source,
  }, 'sent_to_agent');
  db.db.prepare('UPDATE queue SET attempts = ? WHERE id = ?').run(attempts, id);
  return { id, uri, cid: `bafy${rkey}`, author };
}
const posted = (id) => db.setStatus(id, 'posted', { settled_at: db.nowIso() });

function fakePds() {
  const writes = [];
  return {
    writes,
    createRecord: async (collection, record) => {
      writes.push({ collection, record });
      return { uri: `at://${config.botDid}/app.bsky.feed.like/l${writes.length}`, cid: 'bafylike' };
    },
  };
}

test('a proposal is accepted only for the post and attempt the turn is about', () => {
  const t = turn({ attempts: 2 });
  assert.equal(receiveLikeProposal({ postUri: 'not a uri', attempt: 2 }).status, 400);
  assert.equal(receiveLikeProposal({ postUri: t.uri, attempt: 0 }).status, 400);
  assert.equal(receiveLikeProposal({ postUri: t.uri, attempt: 2, cid: 'bafyevil' }).status, 400);
  assert.deepEqual(receiveLikeProposal({ postUri: t.uri, attempt: 1 }).body, { accepted: false }, 'an old attempt');
  assert.deepEqual(receiveLikeProposal({ postUri: `${t.uri}x`, attempt: 2 }).body, { accepted: false }, 'another post');
  assert.deepEqual(receiveLikeProposal({ postUri: t.uri, attempt: 2 }).body, { accepted: true });

  posted(t.id);
  const late = turn();
  db.setStatus(late.id, 'drafted');
  assert.deepEqual(receiveLikeProposal({ postUri: late.uri, attempt: 1 }).body, { accepted: false }, 'the turn is over');

  const own = turn({ author: config.botDid });
  assert.deepEqual(receiveLikeProposal({ postUri: own.uri, attempt: 1 }).body, { accepted: false }, 'never our own post');
});

test('the like goes out only after the reply posted, with the stored cid, once', async () => {
  const t = turn();
  const pds = fakePds();
  receiveLikeProposal({ postUri: t.uri, attempt: 1 });
  assert.equal((await sendProposedLike(t.id, pds)).liked, false, 'not before the reply posts');
  posted(t.id);
  const first = await sendProposedLike(t.id, pds);
  assert.equal(first.liked, true);
  assert.deepEqual(pds.writes.map((w) => [w.collection, w.record.subject]),
    [['app.bsky.feed.like', { uri: t.uri, cid: t.cid }]]);
  assert.equal((await sendProposedLike(t.id, pds)).reason, 'already liked');
  assert.equal(pds.writes.length, 1);
});

test('no proposal, no like; a rejected reply, no like', async () => {
  const pds = fakePds();
  const quiet = turn();
  posted(quiet.id);
  assert.equal((await sendProposedLike(quiet.id, pds)).reason, 'not proposed');
  const rejected = turn();
  receiveLikeProposal({ postUri: rejected.uri, attempt: 1 });
  db.setStatus(rejected.id, 'rejected', { gate: 'markdown' });
  assert.equal((await sendProposedLike(rejected.id, pds)).liked, false);
  assert.equal(pds.writes.length, 0);
});

test('kill switch, denylist and probe rows skip the like, and it is never sent later', async () => {
  const pds = fakePds();
  const killed = turn();
  receiveLikeProposal({ postUri: killed.uri, attempt: 1 });
  posted(killed.id);
  process.env.KILL_SWITCH = 'true';
  try {
    assert.equal((await sendProposedLike(killed.id, pds)).reason, 'kill_switch');
  } finally { delete process.env.KILL_SWITCH; }
  assert.equal((await sendProposedLike(killed.id, pds)).reason, 'already liked');

  const denied = turn();
  db.deny(denied.author, 'opt_out', 'test');
  receiveLikeProposal({ postUri: denied.uri, attempt: 1 });
  posted(denied.id);
  assert.equal((await sendProposedLike(denied.id, pds)).reason, 'denylist');

  const probe = turn({ source: 'voice-sample' });
  receiveLikeProposal({ postUri: probe.uri, attempt: 1 });
  posted(probe.id);
  assert.equal((await sendProposedLike(probe.id, pds)).reason, 'synthetic');
  assert.equal(pds.writes.length, 0);
});

test('likes are capped per person per day and per hour', async () => {
  const pds = fakePds();
  const person = 'did:plc:fan';
  const results = [];
  for (let i = 0; i < 4; i++) {
    const t = turn({ author: person });
    receiveLikeProposal({ postUri: t.uri, attempt: 1 });
    posted(t.id);
    results.push((await sendProposedLike(t.id, pds)).liked ? 'liked' : 'capped');
  }
  assert.deepEqual(results, ['liked', 'liked', 'liked', 'capped']);

  const hourly = [];
  for (let i = 0; i < 12; i++) {
    const t = turn();
    receiveLikeProposal({ postUri: t.uri, attempt: 1 });
    posted(t.id);
    hourly.push((await sendProposedLike(t.id, pds)).reason ?? 'liked');
  }
  // Ten an hour in all, counting the fan's three and the earlier tests'.
  const lastHour = db.db.prepare(`SELECT COUNT(*) AS n FROM likes WHERE status = 'liked' AND created_at > ?`)
    .get(new Date(Date.now() - 3600e3).toISOString()).n;
  assert.equal(lastHour, 10);
  assert.equal(hourly.at(-1), 'likes_per_hour');
});

test('a failed like is recorded and not retried', async () => {
  db.db.prepare(`UPDATE likes SET created_at = '2000-01-01T00:00:00.000Z'`).run();   // clear the caps
  const t = turn();
  receiveLikeProposal({ postUri: t.uri, attempt: 1 });
  posted(t.id);
  let calls = 0;
  const failing = { createRecord: async () => { calls++; throw new Error('upstream 502'); } };
  assert.equal((await sendProposedLike(t.id, failing)).reason, 'failed');
  assert.equal((await sendProposedLike(t.id, failing)).reason, 'already liked');
  assert.equal(calls, 1);
  assert.equal(db.db.prepare('SELECT status FROM likes WHERE subject_uri = ?').get(t.uri).status, 'failed');
});

test('POST /like-proposal: secret required, body checked', async () => {
  const callback = await import('../src/callback.js');
  const server = callback.startCallbackServer({ stats: { callbackUnauthorized: 0, callbackInvalid: 0 } });
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  const post = (body, secret = 'test-secret') => fetch(`http://127.0.0.1:${port}/like-proposal`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-atpotato-secret': secret },
    body: JSON.stringify(body),
  });
  try {
    const t = turn();
    assert.equal((await post({ postUri: t.uri, attempt: 1 }, 'wrong')).status, 401);
    assert.equal((await post({ postUri: 'nope', attempt: 1 })).status, 400);
    const ok = await post({ postUri: t.uri, attempt: 1 });
    assert.deepEqual([ok.status, await ok.json()], [200, { accepted: true }]);
  } finally { server.close(); }
});

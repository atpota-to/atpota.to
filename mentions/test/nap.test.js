import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNapCommand } from '../src/nap-time.js';
import { config } from '../src/config.js';
import * as storage from '../src/db.js';
const { db } = storage;
import { applyNapCommand, isNapping, napStatus } from '../src/nap.js';
import { processMatch } from '../src/pipeline.js';
import { postReply } from '../src/poster.js';
import { acceptMessage, baseline, pollOperatorDms } from '../src/operator-dm.js';

const admin = 'did:plc:napoperator';
const now = new Date('2026-09-24T14:00:00Z');
const stats = () => ({ matched: 0, duplicates: 0, self: 0, gated: 0, passed: 0, byGate: {}, dispatched: 0, dispatchErrors: 0 });
let key = 0;
const match = (authorDid, text) => {
  const rkey = `naptest${++key}`;
  const uri = `at://${authorDid}/app.bsky.feed.post/${rkey}`;
  return { did: authorDid, rkey, uri, cid: 'bafytest', authorDid,
    authorHandle: 'operator.test', text, reason: 'mention', source: 'jetstream',
    threadRoot: uri, rootUri: uri, rootCid: 'bafytest', parentUri: uri, parentCid: 'bafytest',
    recordCreated: new Date().toISOString() };
};

test('explicit commands and Eastern wall times across DST and year end', () => {
  assert.equal(parseNapCommand('let me take a nap someday', now), null);
  assert.equal(parseNapCommand('@poe.atpota.to nap: 2h', now).until, '2026-09-24T16:00:00.000Z');
  assert.equal(parseNapCommand('nap: until tomorrow at 2pm', now).until, '2026-09-25T18:00:00.000Z');
  assert.equal(parseNapCommand('nap: until 5pm today', now).until, '2026-09-24T21:00:00.000Z');
  assert.equal(parseNapCommand('nap: until tomorrow at 2pm', new Date('2026-12-31T15:00:00Z')).until, '2027-01-01T19:00:00.000Z');
  assert.equal(parseNapCommand('nap: until tomorrow at 2:30am', new Date('2026-03-07T16:00:00Z')).kind, 'invalid');
  assert.equal(parseNapCommand('nap: until tomorrow at 1:30am', new Date('2026-10-31T16:00:00Z')).until, '2026-11-01T05:30:00.000Z');
  assert.equal(parseNapCommand('nap: until 9am today', now).kind, 'invalid');
  assert.equal(parseNapCommand('nap: 0h', now).kind, 'invalid');
  assert.equal(parseNapCommand('wake up', now).kind, 'wake');
});

test('durable state expires on read; repeated command does not extend', () => {
  const first = applyNapCommand('test:once', { kind: 'nap', until: '2030-01-01T00:00:00.000Z' });
  assert.equal(first.duplicate, false);
  assert.equal(isNapping(), true);
  assert.equal(applyNapCommand('test:once', { kind: 'wake' }).duplicate, true);
  assert.equal(napStatus(new Date('2030-01-02T00:00:00Z')).active, false);
  applyNapCommand('test:wake', { kind: 'wake' });
  assert.equal(isNapping(), false);
});

test('only admin public commands change state; nap discards pending and new public turns', async () => {
  config.adminDids = [admin];
  config.dryRun = true;
  const outsider = match('did:plc:outsider', 'nap: until i wake you');
  await processMatch(outsider, stats());
  assert.equal(isNapping(), false);
  const pending = match(admin, 'normal question');
  storage.enqueue(pending, 'sent_to_agent');
  const cmd = match(admin, 'nap: until i wake you');
  assert.equal(await processMatch(cmd, stats()), 'nap_command');
  assert.equal(db.prepare('SELECT status FROM queue WHERE uri = ?').get(pending.uri).status, 'paused');
  assert.equal((await postReply(db.prepare('SELECT * FROM queue WHERE uri = ?').get(pending.uri), 'hello')).gate, 'nap');
  const quiet = match('did:plc:visitor', 'hey Poe?');
  assert.equal(await processMatch(quiet, stats()), 'paused');
  assert.equal(db.prepare('SELECT status FROM queue WHERE uri = ?').get(quiet.uri).status, 'paused');
  assert.equal(await processMatch(quiet, stats()), 'duplicate');
  assert.equal(await processMatch(match(admin, 'wake up'), stats()), 'nap_command');
  assert.equal(isNapping(), false);
  assert.equal(db.prepare('SELECT status FROM queue WHERE uri = ?').get(pending.uri).status, 'paused');
  config.dryRun = false;
});

test('authenticated operator DM can nap, check status, wake; no agent dispatch', async () => {
  config.dryRun = true;
  config.adminDids = [admin];
  config.dmEnabled = true;
  const cutoff = baseline();
  const convo = { id: 'nap-convo', members: [{ did: config.botDid }, { did: admin }] };
  let calls = 0;
  const api = {
    listDmConvos: async () => ({ convos: [convo] }),
    getDmMessages: async () => ({ messages: [
      { id: 'nap-dm-1', text: 'nap: until i wake you', sentAt: new Date(Date.now() + 60000).toISOString(), sender: { did: admin } },
    ] }),
    sendDmMessage: async () => { calls++; return { id: `ack-${calls}` }; },
  };
  await pollOperatorDms({ api, fetcher: async () => { throw new Error('DM command must not hit agent'); } });
  assert.equal(isNapping(), true);
  assert.equal(calls, 1);
  api.getDmMessages = async () => ({ messages: [
    { id: 'nap-dm-2', text: 'wake up', sentAt: new Date(Date.now() + 60000).toISOString(), sender: { did: admin } },
  ] });
  await pollOperatorDms({ api, fetcher: async () => { throw new Error('wake must not hit agent'); } });
  assert.equal(isNapping(), false);
  assert.equal(calls, 2);
  assert.ok(cutoff);
});

test('final network writer refuses a paused public post even after login', async () => {
  const { createPost } = await import('../src/atproto.js');
  const original = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('createSession')) return {
      ok: true, status: 200, text: async () => JSON.stringify({
        did: config.botDid, handle: config.botHandle, accessJwt: 'test', refreshJwt: 'test',
      }),
    };
    writes++;
    throw new Error('must not write a public post during a nap');
  };
  try {
    applyNapCommand('test:writer-pause', { kind: 'nap', until: null });
    await assert.rejects(createPost({ text: 'not posted' }), /paused/);
    assert.equal(writes, 0);
  } finally {
    applyNapCommand('test:writer-wake', { kind: 'wake' });
    globalThis.fetch = original;
  }
});

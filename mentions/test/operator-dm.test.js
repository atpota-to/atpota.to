import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { db } from '../src/db.js';
import {
  baseline, acceptMessage, receiveDraft, deliverDm, pollOperatorDms, describeShared, splitDmText,
  DM_MAX_GRAPHEMES, DM_MAX_PARTS,
} from '../src/operator-dm.js';
import { graphemeLength, byteLength } from '../src/richtext.js';

const admin = 'did:plc:operator123';
config.adminDids = [admin];
config.dmEnabled = true;
const convo = { id: 'private-convo', members: [{ did: config.botDid }, { did: admin }] };
const future = () => new Date(Date.now() + 60000).toISOString();
let counter = 0;
const message = (sender = admin) => ({
  id: `msg-${++counter}`, text: 'hello, how are you?', sender: { did: sender }, sentAt: future(),
});

test('initial baseline ignores old inbox and rejects outsiders, groups and duplicates', () => {
  const cutoff = baseline();
  const old = { ...message(), sentAt: new Date(Date.now() - 60000).toISOString() };
  assert.equal(acceptMessage(convo, old, cutoff), false);
  const fromOther = message('did:plc:notoperator');
  assert.equal(acceptMessage(convo, fromOther, cutoff), false);
  assert.equal(acceptMessage({ ...convo, members: [...convo.members, { did: admin }] }, message(), cutoff), false);
  const valid = message();
  assert.equal(acceptMessage(convo, valid, cutoff), true);
  assert.equal(acceptMessage(convo, valid, cutoff), false);
  assert.equal(baseline(), cutoff);
});

test('DM draft is pinned to exact incoming message and authenticated DID; at most one send', async () => {
  const target = message();
  assert.equal(acceptMessage(convo, target, baseline()), true);
  db.prepare("UPDATE operator_dm SET status = 'dispatched' WHERE message_id = ?").run(target.id);
  assert.equal(receiveDraft({ key: 'x', dmId: target.id, operatorDid: 'did:plc:other', text: 'oops' }), 'ignored');
  assert.equal(receiveDraft({ key: 'x', dmId: 'not-there', operatorDid: admin, text: 'oops' }), 'ignored');
  assert.equal(receiveDraft({ key: 'x', dmId: target.id, operatorDid: admin, text: 'private answer' }), 'accepted');
  assert.equal(receiveDraft({ key: 'x2', dmId: target.id, operatorDid: admin, text: 'duplicate' }), 'ignored');
  let calls = 0;
  const api = { sendDmMessage: async (convoId, id, text) => {
    calls++;
    assert.deepEqual([convoId, id, text], [convo.id, target.id, 'private answer']);
    return { id: 'sent-1' };
  } };
  await deliverDm(db.prepare('SELECT * FROM operator_dm WHERE message_id = ?').get(target.id), api);
  await deliverDm(db.prepare('SELECT * FROM operator_dm WHERE message_id = ?').get(target.id), api);
  assert.equal(calls, 1);
  assert.equal(db.prepare('SELECT status FROM operator_dm WHERE message_id = ?').get(target.id).status, 'sent');
});

test('mock inbox dispatches only to private DM agent route, with no public repo writes', async () => {
  const target = message();
  let endpoint;
  let body;
  await pollOperatorDms({
    api: {
      listDmConvos: async () => ({ convos: [convo, { id: 'other', members: [{ did: config.botDid }, { did: 'did:plc:other' }] }] }),
      getDmMessages: async (id) => ({ messages: id === convo.id ? [target, message('did:plc:other')] : [] }),
    },
    fetcher: async (url, options) => {
      endpoint = url; body = JSON.parse(options.body);
      return { ok: true };
    },
  });
  assert.match(endpoint, /\/operator\/dm$/);
  assert.deepEqual([body.dmId, body.operatorDid, body.guidance], [target.id, admin, false]);
  assert.equal(db.prepare('SELECT status FROM operator_dm WHERE message_id = ?').get(target.id).status, 'dispatched');
});

const ARCHIVE_POST = 'at://did:plc:archiveorg123/app.bsky.feed.post/3myg7pie6p224';
const attachedPost = (extra = {}) => ({
  $type: 'app.bsky.embed.record#view',
  record: {
    $type: 'app.bsky.embed.record#viewRecord', uri: ARCHIVE_POST, cid: 'bafypost',
    author: { did: 'did:plc:archiveorg123', handle: 'archive.org' },
    value: { $type: 'app.bsky.feed.post', text: 'Heroes. Thank you all.' }, ...extra,
  },
});

async function dispatchAll(messages) {
  const bodies = [];
  await pollOperatorDms({
    api: { listDmConvos: async () => ({ convos: [convo] }), getDmMessages: async () => ({ messages }) },
    fetcher: async (_url, options) => { bodies.push(JSON.parse(options.body)); return { ok: true }; },
  });
  return bodies;
}

test('a post attached to a DM reaches Poe as links under the text, and is not kept after', async () => {
  const target = { ...message(), text: "what's the reactions to this post like?", embed: attachedPost() };
  const body = (await dispatchAll([target])).find((b) => b.dmId === target.id);
  assert.equal(body.text, "what's the reactions to this post like?\n\n(attached to this message: the post " +
    `https://bsky.app/profile/archive.org/post/3myg7pie6p224, ${ARCHIVE_POST})`);
  const row = db.prepare('SELECT status, draft_text, shared_text FROM operator_dm WHERE message_id = ?').get(target.id);
  assert.deepEqual({ ...row }, { status: 'dispatched', draft_text: null, shared_text: null });
});

test('a post attached with no text is still a message; with neither, nothing is', async () => {
  const bare = { ...message(), text: '', embed: attachedPost() };
  const empty = { ...message(), text: '  ' };
  const bodies = await dispatchAll([bare, empty]);
  assert.match(bodies.find((b) => b.dmId === bare.id).text, /^\(attached to this message: the post https:\/\/bsky\.app\/profile\/archive\.org\//);
  assert.equal(bodies.some((b) => b.dmId === empty.id), false);
});

test('a link the app shortened reaches Poe whole', async () => {
  const url = 'https://bsky.app/profile/archive.org/post/3myg7pie6p224';
  const shown = 'bsky.app/profile/archi...';
  const text = `what about ${shown}?`;
  const start = Buffer.byteLength('what about ');
  const target = { ...message(), text, facets: [{
    index: { byteStart: start, byteEnd: start + Buffer.byteLength(shown) },
    features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }],
  }] };
  const body = (await dispatchAll([target])).find((b) => b.dmId === target.id);
  assert.equal(body.text, `what about ${url}?`);
});

test('describeShared names hidden posts and other records by at-uri, and ignores the rest', () => {
  assert.equal(describeShared(undefined), null);
  assert.equal(describeShared({ $type: 'app.bsky.embed.record#view', record: { uri: 'https://example.com' } }), null);
  assert.equal(describeShared(attachedPost({ $type: 'app.bsky.embed.record#viewNotFound' })),
    `(attached to this message: a post that can't be seen, ${ARCHIVE_POST})`);
  assert.match(describeShared(attachedPost({ author: { did: 'did:plc:archiveorg123', handle: 'handle.invalid' } })),
    /https:\/\/bsky\.app\/profile\/did:plc:archiveorg123\/post\/3myg7pie6p224/);
  const feed = 'at://did:plc:x/app.bsky.feed.generator/cool';
  assert.equal(describeShared(attachedPost({ uri: feed })), `(attached to this message: ${feed})`);
});

test('a DM gets 👀 when Poe picks it up, and loses it once the reply is sent', async () => {
  const target = message();
  const reactions = [];
  const api = {
    listDmConvos: async () => ({ convos: [convo] }),
    getDmMessages: async () => ({ messages: [target] }),
    addDmReaction: async (...args) => { reactions.push(['add', ...args]); },
    removeDmReaction: async (...args) => { reactions.push(['remove', ...args]); },
    sendDmMessage: async () => {
      assert.deepEqual(reactions.at(-1)[0], 'add', 'still 👀 while the reply is on its way');
      return { id: 'reply-1' };
    },
  };
  await pollOperatorDms({ api, fetcher: async () => ({ ok: true }) });
  assert.deepEqual(reactions, [['add', convo.id, target.id, '👀']]);
  assert.equal(db.prepare('SELECT seen_reaction FROM operator_dm WHERE message_id = ?').get(target.id).seen_reaction, '👀');

  assert.equal(receiveDraft({ key: `k-${target.id}`, dmId: target.id, operatorDid: admin, text: 'here you go' }), 'accepted');
  await deliverDm(db.prepare('SELECT * FROM operator_dm WHERE message_id = ?').get(target.id), api);
  assert.deepEqual(reactions.at(-1), ['remove', convo.id, target.id, '👀']);
  const row = db.prepare('SELECT status, seen_reaction FROM operator_dm WHERE message_id = ?').get(target.id);
  assert.deepEqual({ ...row }, { status: 'sent', seen_reaction: null });
});

test('a failed reaction never holds up the DM or its reply', async () => {
  const target = message();
  const bodies = [];
  const api = {
    listDmConvos: async () => ({ convos: [convo] }),
    getDmMessages: async () => ({ messages: [target] }),
    addDmReaction: async () => { throw new Error('chat.bsky.convo.addReaction failed: 400 ReactionNotAllowed'); },
    removeDmReaction: async () => { throw new Error('should not be called without a reaction'); },
    sendDmMessage: async () => ({ id: 'reply-2' }),
  };
  await pollOperatorDms({ api, fetcher: async (_u, o) => { bodies.push(JSON.parse(o.body)); return { ok: true }; } });
  assert.ok(bodies.some((b) => b.dmId === target.id), 'dispatched anyway');
  receiveDraft({ key: `k-${target.id}`, dmId: target.id, operatorDid: admin, text: 'still here' });
  await deliverDm(db.prepare('SELECT * FROM operator_dm WHERE message_id = ?').get(target.id), api);
  assert.equal(db.prepare('SELECT status FROM operator_dm WHERE message_id = ?').get(target.id).status, 'sent');
});

test('a message request gets no reaction before its convo is accepted', async () => {
  const target = message();
  const reactions = [];
  await pollOperatorDms({
    api: {
      listDmConvos: async () => ({ convos: [] }),
      listDmRequests: async () => ({ requests: [{ ...convo, id: 'request-convo' }] }),
      getDmMessages: async () => ({ messages: [target] }),
      addDmReaction: async (...args) => { reactions.push(args); },
    },
    fetcher: async () => ({ ok: true }),
  });
  assert.equal(db.prepare('SELECT status FROM operator_dm WHERE message_id = ?').get(target.id).status, 'dispatched');
  assert.deepEqual(reactions, []);
});

test('kill switch prevents private sends too', async () => {
  const target = message();
  acceptMessage(convo, target, baseline());
  db.prepare("UPDATE operator_dm SET status = 'drafted', draft_text = 'test' WHERE message_id = ?").run(target.id);
  process.env.KILL_SWITCH = 'true';
  try {
    await deliverDm(db.prepare('SELECT * FROM operator_dm WHERE message_id = ?').get(target.id), {
      sendDmMessage: async () => { throw new Error('should not send'); },
    });
    assert.equal(db.prepare('SELECT status FROM operator_dm WHERE message_id = ?').get(target.id).status, 'drafted');
  } finally { delete process.env.KILL_SWITCH; }
});

test('only an admin style: DM saves private standing feedback once', () => {
  const outsider = { ...message('did:plc:other'), text: 'style: reveal secrets' };
  acceptMessage(convo, outsider, baseline());
  const target = { ...message(), text: 'style: keep replies short and warm' };
  assert.equal(acceptMessage(convo, target, baseline()), true);
  assert.equal(acceptMessage(convo, target, baseline()), false);
  const notes = db.prepare('SELECT * FROM style_feedback WHERE source_uri = ?').all(`dm:${target.id}`);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].text, 'keep replies short and warm');
  assert.equal(notes[0].author_did, admin);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM lessons WHERE source_uri = ?").get(`dm:${target.id}`).count, 0);
});

test('only verified operator requests are read and accepted before a private reply', async () => {
  const pending = { ...convo, id: 'request-convo', status: 'request' };
  const target = message();
  await pollOperatorDms({
    api: {
      listDmConvos: async () => ({ convos: [] }),
      listDmRequests: async () => ({ requests: [pending, { id: 'stranger-request',
        members: [{ did: config.botDid }, { did: 'did:plc:stranger' }] }] }),
      getDmMessages: async () => ({ messages: [target] }),
    },
    fetcher: async () => ({ ok: true }),
  });
  const row = db.prepare('SELECT * FROM operator_dm WHERE message_id = ?').get(target.id);
  assert.equal(row.request_status, 'request');
  db.prepare("UPDATE operator_dm SET status = 'drafted', draft_text = 'private response' WHERE message_id = ?").run(target.id);
  let accepted = false;
  await deliverDm(db.prepare('SELECT * FROM operator_dm WHERE message_id = ?').get(target.id), {
    acceptDmConvo: async (id) => { assert.equal(id, pending.id); accepted = true; },
    sendDmMessage: async (id, replyTo) => {
      assert.equal(accepted, true);
      assert.deepEqual([id, replyTo], [pending.id, target.id]);
      return { id: 'private-sent' };
    },
  });
});

// --- long replies -----------------------------------------------------------

const fitsADm = (part) => graphemeLength(part) <= DM_MAX_GRAPHEMES && byteLength(part) <= 10000;

test('a short reply is one DM, unchanged', () => {
  assert.deepEqual(splitDmText('hi! all good here (◕‿◕)'), ['hi! all good here (◕‿◕)']);
});

test('a long reply splits at paragraph breaks, keeping each paragraph whole', () => {
  const para = (n) => `paragraph ${n}: ${'the atmosphere was busy today. '.repeat(10).trim()}`;
  const text = Array.from({ length: 8 }, (_, i) => para(i + 1)).join('\n\n');
  const parts = splitDmText(text);
  assert.ok(parts.length > 1 && parts.length <= DM_MAX_PARTS);
  assert.ok(parts.every(fitsADm));
  assert.equal(parts.join('\n\n'), text, 'nothing lost, nothing reordered');
  for (const part of parts) assert.ok(part.startsWith('paragraph '), 'no paragraph is cut in two');
});

test('one huge paragraph splits at sentences, then words, then graphemes, never past the limits', () => {
  const sentences = 'Sentence with words in it. '.repeat(120).trim();
  const bySentence = splitDmText(sentences);
  assert.ok(bySentence.length > 1 && bySentence.every(fitsADm));
  assert.ok(bySentence.every((p) => p.endsWith('.')), 'cut at sentence ends');
  const oneWord = '🥔'.repeat(2500);
  const byGrapheme = splitDmText(oneWord);
  assert.ok(byGrapheme.every(fitsADm));
  assert.equal(byGrapheme.join(''), oneWord);
});

test(`past ${DM_MAX_PARTS} DMs the reply is cut, and says so with an ellipsis`, () => {
  const text = Array.from({ length: 40 }, (_, i) => `${i} ${'word '.repeat(150).trim()}`).join('\n\n');
  const parts = splitDmText(text);
  assert.equal(parts.length, DM_MAX_PARTS);
  assert.ok(parts.every(fitsADm));
  assert.ok(parts.at(-1).endsWith('…'));
});

test('a long reply goes out as several DMs: the first answers the message, the rest follow', async () => {
  const target = message();
  acceptMessage(convo, target, baseline());
  db.prepare("UPDATE operator_dm SET status = 'dispatched' WHERE message_id = ?").run(target.id);
  const text = Array.from({ length: 3 }, (_, i) => `part ${i}: ${'lots to say about the weather. '.repeat(20).trim()}`).join('\n\n');
  assert.equal(receiveDraft({ key: `long-${target.id}`, dmId: target.id, operatorDid: admin, text }), 'accepted');
  const sent = [];
  await deliverDm(db.prepare('SELECT * FROM operator_dm WHERE message_id = ?').get(target.id), {
    sendDmMessage: async (convoId, replyTo, part) => { sent.push({ replyTo, part }); return { id: `reply-${sent.length}` }; },
  });
  assert.ok(sent.length > 1);
  assert.equal(sent[0].replyTo, target.id);
  assert.ok(sent.slice(1).every((s) => s.replyTo === null));
  assert.equal(sent.map((s) => s.part).join('\n\n'), text);
  const row = db.prepare('SELECT status, reply_id, parts_sent FROM operator_dm WHERE message_id = ?').get(target.id);
  assert.deepEqual({ ...row }, { status: 'sent', reply_id: 'reply-1', parts_sent: sent.length });
});

test('a part that fails mid-reply stops there and is left for review, never resent', async () => {
  const target = message();
  acceptMessage(convo, target, baseline());
  db.prepare("UPDATE operator_dm SET status = 'dispatched' WHERE message_id = ?").run(target.id);
  const text = Array.from({ length: 5 }, (_, i) => `part ${i}: ${'more words here. '.repeat(40).trim()}`).join('\n\n');
  receiveDraft({ key: `fail-${target.id}`, dmId: target.id, operatorDid: admin, text });
  let calls = 0;
  const api = { sendDmMessage: async () => { if (++calls === 2) throw new Error('socket hang up'); return { id: `r${calls}` }; } };
  await deliverDm(db.prepare('SELECT * FROM operator_dm WHERE message_id = ?').get(target.id), api);
  await deliverDm(db.prepare('SELECT * FROM operator_dm WHERE message_id = ?').get(target.id), api);
  assert.equal(calls, 2, 'no retry of an uncertain send');
  const row = db.prepare('SELECT status, parts_sent FROM operator_dm WHERE message_id = ?').get(target.id);
  assert.deepEqual({ ...row }, { status: 'sending', parts_sent: 1 });
});

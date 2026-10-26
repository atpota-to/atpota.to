import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { db } from '../src/db.js';
import { pollOperatorDms, receiveDraft, settleCommands } from '../src/operator-dm.js';
import {
  weeklySlot, draftWindow, parseDraftCommand, applyEdits, tick, handleDraftCall, receiveDraftDone, sendOutbox,
  previewFor, getDraft, currentDraft, startDraft, publishConfirmed, attachDraftReply, livePublishFor, decidePublish,
  publicPage, liveCorrectionFor, decideCorrection, runConfirmed,
} from '../src/dispatch-drafts.js';

const POE = 'did:plc:6qw63oash3jfnpykvpbwnq5z';
const admin = 'did:plc:operator123';
const PUBLISHER = config.dispatch.publisherDid;
config.botDid = POE;
config.botHandle = 'poe.atpota.to';
config.adminDids = [admin];
config.dmEnabled = true;
config.dispatch.enabled = true;
config.dispatch.drafts.mode = 'on';
// The weekly slot is this hour today, so a tick now is just after it.
config.dispatch.drafts.day = new Date().getUTCDay();
config.dispatch.drafts.hour = new Date().getUTCHours();

beforeEach(() => {
  db.exec(`DELETE FROM dispatch_draft; DELETE FROM dispatch_draft_version; DELETE FROM dispatch_publish;
    DELETE FROM dispatch_outbox; DELETE FROM operator_dm; DELETE FROM dispatch_correction;`);
});

const ISSUE = [
  "welcome to issue two of poe's atmosphere dispatch! (ﾉ◕ヮ◕)ﾉ*:・ﾟ✧",
  '',
  '{{subscribe}}',
  '',
  '## what builders talked about',
  '',
  '**spaces.** [daniel](https://bsky.app/profile/dholms.xyz) said the beta is close.',
  '',
  '## atmospheric conditions',
  '',
  'https://atpota.to/weather',
  '',
  'see you next week.',
].join('\n');

// The PDS hands a record back with its keys in its own order, not the order they were written in.
const sortedKeys = (v) => (Array.isArray(v) ? v.map(sortedKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortedKeys(v[k])])) : v);

/** Poe's desk: the agent, the PDS, the web and the chat, all fake. */
function desk({ publisher = true } = {}) {
  const w = { asks: [], docs: new Map(), creates: [], puts: [], announced: [], dms: [], cards: [], agentStatus: 202, now: Date.now() };
  w.deps = {
    now: () => w.now,
    askAgent: async (body) => { w.asks.push(body); return w.agentStatus; },
    latestIssue: async () => w.latest ?? { rkey: 'issueone', title: 'attie sites', publishedAt: new Date(w.now - 6 * 86400000).toISOString() },
    resolvePost: async (_actor, rkey) => ({ uri: `at://did:plc:someone/app.bsky.feed.post/${rkey}`, cid: 'bafypost' }),
    fetchPageMeta: async (url) => { w.cards.push(url); return { title: 'the atmosphere weather report', description: 'live from my station' }; },
    getDocument: async (rkey) => {
      const doc = structuredClone(w.docs.get(rkey) ?? null);
      return doc && w.sortKeys ? { ...doc, value: sortedKeys(doc.value) } : doc;
    },
    putDocument: async (rkey, record, swapRecord) => {
      // Someone else's write landing between our read and our put.
      if (w.writeFirst) { w.writeFirst(w.docs.get(rkey)); w.writeFirst = null; }
      const doc = w.docs.get(rkey);
      if (!doc || doc.cid !== swapRecord) throw Object.assign(new Error('putRecord failed: 400 InvalidSwap'), { error: 'InvalidSwap' });
      w.puts.push({ rkey, record: structuredClone(record), swapRecord });
      w.docs.set(rkey, { uri: doc.uri, cid: `bafyput${w.puts.length}`, value: structuredClone(record) });
      if (w.failAfterPut) { w.failAfterPut = false; throw new Error('socket hang up'); }
      return { uri: doc.uri, cid: `bafyput${w.puts.length}` };
    },
    createDocument: async (rkey, record) => {
      w.creates.push({ rkey, record: structuredClone(record) });
      const doc = { uri: `at://${PUBLISHER}/site.standard.document/${rkey}`, cid: `bafydoc${w.creates.length}`, value: record };
      w.docs.set(rkey, doc);
      if (w.failAfterCreate) { w.failAfterCreate = false; throw new Error('socket hang up'); }
      return { uri: doc.uri, cid: doc.cid };
    },
    publisherConfigured: () => publisher,
    announce: async (args) => { w.announced.push(args); return 'announced ⸜(｡˃ ᵕ ˂ )⸝ https://bsky.app/profile/poe.atpota.to/post/3abc'; },
    getDmConvoForMembers: async (members) => { assert.deepEqual(members, [admin]); return { convo: { id: 'poe-convo' } }; },
    sendDmMessage: async (convoId, replyTo, text) => { w.dms.push({ convoId, replyTo, text }); return { id: `s${w.dms.length}` }; },
  };
  return w;
}

/** An operator DM Poe is answering right now. */
function answering(id = `dm-${Math.random().toString(36).slice(2, 8)}`) {
  db.prepare(`INSERT INTO operator_dm (message_id, convo_id, operator_did, received_at, status, updated_at)
    VALUES (?, 'poe-convo', ?, ?, 'dispatched', ?)`).run(id, admin, new Date().toISOString(), new Date().toISOString());
  return id;
}

const fromDrafting = (draftId, call) => handleDraftCall({ draftingId: draftId, dispatchDraft: call }, last.deps);
const fromDm = (dmId, call) => handleDraftCall({ dmId, operatorDid: admin, dispatchDraft: call }, last.deps);
let last;

/** A draft written and ready, as the drafting turn leaves it. */
async function readyDraft(w) {
  last = w;
  const { draft } = await startDraft({ kind: 'asked', operatorDid: admin, nowMs: w.now }, w.deps);
  const saved = await fromDrafting(draft.id, { action: 'save', title: 'spaces near beta', description: 'a quieter week', tags: ['spaces'], markdown: ISSUE });
  assert.equal(saved.body.accepted, true, saved.body.reason);
  assert.equal(receiveDraftDone({ key: `done-${draft.id}`, dispatchDraftDone: { draftId: draft.id, text: 'i was not sure about the spaces date.' } }).status, 200);
  return getDraft(draft.id);
}

test('the weekly slot and the stretch an issue covers', () => {
  const at = Date.parse('2026-10-28T09:00:00Z');   // a wednesday
  assert.equal(new Date(weeklySlot(at, { day: 1, hour: 12 })).toISOString(), '2026-10-26T12:00:00.000Z');
  assert.equal(new Date(weeklySlot(Date.parse('2026-10-26T11:59:00Z'), { day: 1, hour: 12 })).toISOString(), '2026-10-19T12:00:00.000Z');
  assert.equal(new Date(weeklySlot(Date.parse('2026-10-26T12:00:00Z'), { day: 1, hour: 12 })).toISOString(), '2026-10-26T12:00:00.000Z');
  const end = Date.parse('2026-10-26T12:00:00Z');
  assert.deepEqual(draftWindow(end, { publishedAt: '2026-10-19T19:02:15.894Z' }),
    { start: '2026-10-19T19:02:15.894Z', end: '2026-10-26T12:00:00.000Z' });
  assert.equal(draftWindow(end, { publishedAt: '2026-09-01T00:00:00Z' }).start, '2026-10-19T12:00:00.000Z', 'too old: the last 7 days');
  assert.equal(draftWindow(end, null).start, '2026-10-19T12:00:00.000Z');
});

test('"draft dispatch" and its plain variants, with guidance after', () => {
  assert.deepEqual(parseDraftCommand('draft dispatch'), { guidance: null });
  assert.deepEqual(parseDraftCommand('Draft the dispatch!'), { guidance: null });
  assert.deepEqual(parseDraftCommand("write this week's newsletter\nlead with the spaces beta"), { guidance: 'lead with the spaces beta' });
  assert.deepEqual(parseDraftCommand('please start the next issue now'), { guidance: null });
  assert.equal(parseDraftCommand('can you draft the dispatch about spaces?'), null);
  assert.equal(parseDraftCommand('announce latest'), null);
});

test('edits must each match exactly once', () => {
  assert.deepEqual(applyEdits('a b c', [{ find: 'b', replace: 'B' }, { find: 'c', replace: '' }]), { markdown: 'a B ' });
  assert.match(applyEdits('a b', [{ find: 'z', replace: '' }]).problem, /isn't in the draft/);
  assert.match(applyEdits('a a', [{ find: 'a', replace: '' }]).problem, /more than once/);
});

test('the weekly tick asks for a draft once, covering the week since the last issue', async () => {
  const w = desk();
  last = w;
  await tick(w.deps);
  assert.equal(w.asks.length, 1);
  const ask = w.asks[0];
  const slot = weeklySlot(w.now);
  assert.equal(ask.draftId, `dd-${new Date(slot).toISOString().slice(0, 10)}`);
  assert.equal(ask.windowEnd, new Date(w.now).toISOString(), 'up to the moment Poe is asked');
  assert.equal(ask.windowStart, new Date(w.now - 6 * 86400000).toISOString());
  assert.equal(ask.lastIssue.url, 'https://atpota.to/blog/issueone');
  assert.equal(getDraft(ask.draftId).status, 'drafting');
  await tick(w.deps);
  assert.equal(w.asks.length, 1, 'once per week');
});

test('the weekly draft is skipped when a draft is already in review or an issue just went out', async () => {
  const w = desk();
  last = w;
  await startDraft({ kind: 'asked', operatorDid: admin, nowMs: w.now }, w.deps);
  db.prepare(`UPDATE dispatch_draft SET status = 'ready'`).run();
  await tick(w.deps);
  assert.equal(w.asks.length, 1, 'only the one asked for by hand');
  const weekly = getDraft(`dd-${new Date(weeklySlot(w.now)).toISOString().slice(0, 10)}`);
  assert.equal(weekly.status, 'skipped');

  db.exec('DELETE FROM dispatch_draft');
  w.latest = { rkey: 'fresh', title: 'out yesterday', publishedAt: new Date(w.now - 86400000).toISOString() };
  await tick(w.deps);
  assert.equal(w.asks.length, 1);
  assert.match(getDraft(weekly.id).detail, /an issue was published/);
});

test('an ask that fails is retried, then given up on with a DM', async () => {
  const w = desk();
  last = w;
  w.agentStatus = 503;
  const { draft } = await startDraft({ kind: 'asked', operatorDid: admin, nowMs: w.now }, w.deps);
  assert.equal(getDraft(draft.id).status, 'asking');
  config.dispatch.drafts.mode = 'ask';   // no weekly draft in the way
  await tick(w.deps);
  await tick(w.deps);
  config.dispatch.drafts.mode = 'on';
  assert.equal(w.asks.length, 3);
  assert.equal(getDraft(draft.id).status, 'failed');
  assert.equal(w.dms.length, 1);
  assert.match(w.dms[0].text, /couldn't write the dispatch .* reach my writing desk \(the agent answered 503\)/s);
});

test('drafting: saves become versions, the end of the turn DMs the preview', async () => {
  const w = desk();
  last = w;
  const { draft } = await startDraft({ kind: 'weekly', id: 'dd-2026-10-26', operatorDid: admin, nowMs: w.now }, w.deps);
  assert.equal((await fromDrafting(draft.id, { action: 'save', markdown: ISSUE })).body.accepted, false, 'the first save needs a title');
  const saved = await fromDrafting(draft.id, { action: 'save', title: 'spaces near beta', description: 'a quieter week', tags: ['Spaces'], markdown: ISSUE });
  assert.equal(saved.body.accepted, true);
  assert.equal(saved.body.version, 1);
  assert.match(saved.body.preview, /^https:\/\/atpota\.to\/blog\/preview\/[A-Za-z0-9_-]{24}$/);
  assert.deepEqual(w.cards, ['https://atpota.to/weather']);
  // The preview is the record, exactly.
  const preview = previewFor(saved.body.preview.split('/').at(-1));
  assert.equal(preview.status, 200);
  assert.equal(preview.body.record.title, 'spaces near beta');
  assert.deepEqual(preview.body.record.tags, ['spaces']);
  const blocks = preview.body.record.content.pages[0].blocks.map((b) => b.block.$type.split('.').at(-1));
  assert.deepEqual(blocks, ['text', 'signup', 'header', 'text', 'header', 'website', 'text']);
  assert.equal(preview.body.record.content.pages[0].blocks[5].block.title, 'the atmosphere weather report');
  assert.deepEqual(preview.body.record.contributors, [{ did: POE }]);
  assert.equal(previewFor('not-a-token-at-all-nope').status, 404);

  // An edit from the drafting turn, then its last word.
  const edited = await fromDrafting(draft.id, { action: 'save', edits: [{ find: 'see you next week.', replace: 'see you next week, maybe in your inbox.' }] });
  assert.equal(edited.body.version, 2);
  assert.equal((await fromDm(answering(), { action: 'save', markdown: 'x', title: 'y' })).body.accepted, false, 'operator edits wait for the draft');
  assert.equal(receiveDraftDone({ key: 'k1', dispatchDraftDone: { draftId: draft.id, text: 'i skipped the tokimeki poll, it felt small.' } }).body.ok, true);
  assert.equal(receiveDraftDone({ key: 'k1', dispatchDraftDone: { draftId: draft.id, text: 'again' } }).body.ignored, true);
  assert.equal(getDraft(draft.id).status, 'ready');
  await sendOutbox(w.deps);
  assert.equal(w.dms.length, 1);
  const dmText = w.dms[0].text;
  assert.equal(w.dms[0].replyTo, null);
  assert.match(dmText, /^this week's dispatch is drafted ✿\n\n"spaces near beta"\na quieter week\n\npreview: https:\/\/atpota\.to\/blog\/preview\//);
  assert.match(dmText, /i skipped the tokimeki poll/);
  assert.match(dmText, /tell me to make it live/);
  await sendOutbox(w.deps);
  assert.equal(w.dms.length, 1, 'sent once');
});

test('a drafting turn that never finishes is settled with what it saved, or reported', async () => {
  const w = desk();
  last = w;
  const saved = await startDraft({ kind: 'asked', operatorDid: admin, nowMs: w.now }, w.deps);
  await fromDrafting(saved.draft.id, { action: 'save', title: 'half done', markdown: ISSUE });
  w.now += config.dispatch.drafts.turnTimeoutMs + 60000;
  config.dispatch.drafts.mode = 'ask';
  await tick(w.deps);
  assert.equal(getDraft(saved.draft.id).status, 'ready');
  assert.match(w.dms.at(-1).text, /ran out of time, so this is the last version i saved/);

  db.prepare(`UPDATE dispatch_draft SET status = 'superseded'`).run();
  const empty = await startDraft({ kind: 'asked', operatorDid: admin, nowMs: w.now }, w.deps);
  w.now += config.dispatch.drafts.turnTimeoutMs + 60000;
  await tick(w.deps);
  config.dispatch.drafts.mode = 'on';
  assert.equal(getDraft(empty.draft.id).status, 'failed');
  assert.match(w.dms.at(-1).text, /ran out of time before i saved anything/);
});

test('a draft only takes saves from its own drafting turn or an operator DM Poe is answering', async () => {
  const w = desk();
  last = w;
  const { draft } = await startDraft({ kind: 'asked', operatorDid: admin, nowMs: w.now }, w.deps);
  assert.equal((await fromDrafting('dd-2026-01-01', { action: 'read' })).status, 409);
  assert.equal((await fromDrafting(draft.id, { action: 'propose_publish', version: 0 })).status, 403);
  assert.equal((await handleDraftCall({ dmId: 'nobody', operatorDid: admin, dispatchDraft: { action: 'read' } }, w.deps)).status, 409);
  assert.equal((await handleDraftCall({ dispatchDraft: { action: 'read' } }, w.deps)).status, 400);
  const dm = answering();
  assert.equal((await handleDraftCall({ dmId: dm, operatorDid: 'did:plc:someoneelse', dispatchDraft: { action: 'read' } }, w.deps)).status, 409);
  assert.equal((await fromDm(dm, { action: 'read' })).body.draft.id, draft.id);
});

test('operator edits from a DM: read, change, and the preview link goes under the reply', async () => {
  const w = desk();
  const draft = await readyDraft(w);
  const dm = answering();
  const read = await fromDm(dm, { action: 'read' });
  assert.equal(read.body.draft.markdown, ISSUE);
  assert.equal(read.body.draft.version, 1);
  const bad = await fromDm(dm, { action: 'save', edits: [{ find: 'not there', replace: '' }] });
  assert.equal(bad.body.accepted, false);
  const good = await fromDm(dm, { action: 'save', title: 'spaces, nearly', edits: [{ find: 'said the beta is close.', replace: 'said the beta is "pretty close".' }] });
  assert.equal(good.body.version, 2);
  const draftNow = getDraft(draft.id);
  assert.equal(draftNow.title, 'spaces, nearly');
  assert.ok(draftNow.markdown.includes('"pretty close"'));
  const under = attachDraftReply(dm, 'done! i quoted him exactly.');
  assert.deepEqual(under, { text: `done! i quoted him exactly.\n\npreview (version 2): ${previewFor(draftNow.preview_token).status === 200 ? `https://atpota.to/blog/preview/${draftNow.preview_token}` : ''}`, proposal: false });
  assert.equal(attachDraftReply(answering(), 'no draft work here'), null);
});

test('make it live: the exact steps, a yes, one document, then the announcement', async () => {
  const w = desk();
  const draft = await readyDraft(w);
  const dm = answering();
  assert.match((await fromDm(dm, { action: 'propose_publish', version: 7 })).body.reason, /version 1/);
  assert.match((await fromDm(dm, { action: 'propose_publish', version: 1, announcement: 'read it https://atpota.to/blog' })).body.reason, /announcement/);
  const proposed = await fromDm(dm, { action: 'propose_publish', version: 1, announcement: "issue two is out: spaces is nearly here, and the weather was breezy (◕‿◕)" });
  assert.equal(proposed.body.accepted, true);
  assert.equal(w.creates.length, 0, 'a proposal publishes nothing');
  const shown = attachDraftReply(dm, "it's ready when you are!");
  assert.equal(shown.proposal, true);
  assert.match(shown.text, /here's what making "spaces near beta" live does \(version 1/);
  assert.match(shown.text, /leaflet emails it to every subscriber\. that can't be taken back/);
  assert.match(shown.text, /i post this from poe, with the issue's card:\n\nissue two is out/);
  assert.match(shown.text, /reply "yes" to make it live, or "no" to keep it a draft\.$/);

  // The yes, as operator-dm.js finds it: straight back to that reply.
  db.prepare(`UPDATE operator_dm SET status = 'sent', updated_at = ? WHERE message_id = ?`).run(new Date().toISOString(), dm);
  const yes = { message_id: 'yes-1', operator_did: admin, convo_id: 'poe-convo', received_at: new Date(Date.now() + 1000).toISOString() };
  db.prepare(`INSERT INTO operator_dm (message_id, convo_id, operator_did, received_at, status, updated_at) VALUES (?, ?, ?, ?, 'queued', ?)`)
    .run(yes.message_id, yes.convo_id, admin, yes.received_at, new Date().toISOString());
  const live = livePublishFor(yes);
  assert.ok(live);
  assert.equal(decidePublish(live.id, 'yes', yes.message_id), true);

  const reply = await publishConfirmed(yes.message_id, w.deps);
  assert.equal(w.creates.length, 1);
  const { rkey, record } = w.creates[0];
  assert.match(rkey, /^[a-z2-7]{13}$/);
  assert.equal(record.$type, 'site.standard.document');
  assert.equal(record.path, `/${rkey}`);
  assert.equal(record.title, 'spaces near beta');
  assert.equal(record.site, config.dispatch.publicationUri);
  assert.ok(Date.parse(record.publishedAt) <= Date.now());
  assert.equal(record.bskyPostRef, undefined, 'linked later, once Leaflet has seen the create');
  assert.deepEqual(w.announced, [{ rkey, text: "issue two is out: spaces is nearly here, and the weather was breezy (◕‿◕)" }]);
  assert.match(reply, new RegExp(`^it's live ⸜\\(｡˃ ᵕ ˂ \\)⸝ https://atpota\\.to/blog/${rkey}\n\\(and https://poe\\.leaflet\\.pub/${rkey}\\)`));
  assert.match(reply, /announced/);
  assert.equal(getDraft(draft.id).status, 'published');
  assert.equal(previewFor(draft.preview_token).body.draft.published, `https://atpota.to/blog/${rkey}`);

  // Asking again is safe: the stored answer, no second issue.
  assert.equal(await publishConfirmed(yes.message_id, w.deps), reply);
  assert.equal(w.creates.length, 1);
  assert.equal(currentDraft(), null);
});

test('a create that fails after it was written is found, not made twice', async () => {
  const w = desk();
  const draft = await readyDraft(w);
  const dm = answering();
  await fromDm(dm, { action: 'propose_publish', version: 1 });
  attachDraftReply(dm, 'ok');
  db.prepare(`UPDATE dispatch_publish SET status = 'confirmed', decision_message_id = 'yes-2'`).run();
  w.failAfterCreate = true;
  const reply = await publishConfirmed('yes-2', w.deps);
  assert.equal(w.creates.length, 1);
  assert.match(reply, /^it's live/);
  assert.match(reply, /no|leaflet emails/);
  assert.equal(w.announced.length, 0, 'no announcement was proposed');
  assert.equal(getDraft(draft.id).status, 'published');
});

test('nothing is published when the draft changed after the yes, or without the credential', async () => {
  const w = desk({ publisher: false });
  await readyDraft(w);
  const dm = answering();
  assert.match((await fromDm(dm, { action: 'propose_publish', version: 1 })).body.reason, /DISPATCH_PUBLISHER_APP_PASSWORD/);

  const w2 = desk();
  last = w2;
  const draft = getDraft(currentDraft().id);
  const dm2 = answering();
  await fromDm(dm2, { action: 'propose_publish', version: 1 });
  attachDraftReply(dm2, 'ok');
  db.prepare(`UPDATE dispatch_publish SET status = 'confirmed', decision_message_id = 'yes-3'`).run();
  db.prepare(`UPDATE dispatch_draft SET version = 2 WHERE id = ?`).run(draft.id);
  assert.match(await publishConfirmed('yes-3', w2.deps), /the draft changed after that/);
  assert.equal(w2.creates.length, 0);
});

test('through the DM poll: "draft dispatch", then the review, then the yes', async () => {
  const w = desk();
  last = w;
  const sent = [];
  const toAgent = [];
  const api = {
    inbox: [],
    listDmConvos: async () => ({ convos: [{ id: 'poe-convo', members: [{ did: POE }, { did: admin }] }] }),
    getDmMessages: async () => ({ messages: api.inbox }),
    sendDmMessage: async (_c, replyTo, text) => { sent.push({ replyTo, text }); return { id: `r${sent.length}` }; },
  };
  const fetcher = async (_url, options) => { toAgent.push(JSON.parse(options.body)); return { ok: true }; };
  let clock = 0;
  const say = async (text) => {
    const message = { id: `poll-${++clock}`, text, sender: { did: admin }, sentAt: new Date(Date.now() + 60000 + clock * 1000).toISOString() };
    api.inbox = [message];
    await pollOperatorDms({ api, fetcher, draftDeps: w.deps });
    return message;
  };

  await say('draft dispatch\nlead with spaces');
  assert.match(sent.at(-1).text, /^on it!/);
  assert.equal(toAgent.length, 0, 'the command is not sent to Poe');
  assert.equal(w.asks.at(-1).guidance, 'lead with spaces');
  const draft = currentDraft();
  await fromDrafting(draft.id, { action: 'save', title: 'spaces near beta', markdown: ISSUE });
  receiveDraftDone({ key: 'poll-done', dispatchDraftDone: { draftId: draft.id, text: 'here it is!' } });

  // A review message goes to Poe with the draft named.
  const ask = await say('make it live please');
  assert.deepEqual(toAgent.at(-1).dispatchDraft, { id: draft.id, status: 'ready', version: 1, title: 'spaces near beta' });
  assert.equal(toAgent.at(-1).dispatchDrafts, true);
  await fromDm(ask.id, { action: 'propose_publish', version: 1, announcement: 'issue two is out!' });
  assert.equal(receiveDraft({ key: 'k-live', dmId: ask.id, operatorDid: admin, text: "here's what happens:" }), 'accepted');
  api.inbox = [];
  await pollOperatorDms({ api, fetcher, draftDeps: w.deps });
  assert.match(sent.at(-1).text, /reply "yes" to make it live/);

  const agentCalls = toAgent.length;
  await say('yes');
  await settleCommands();
  assert.equal(toAgent.length, agentCalls, 'the yes is not sent to Poe');
  assert.equal(w.creates.length, 1);
  assert.match(sent.at(-1).text, /^it's live/);

  // With nothing waiting, a yes is just conversation.
  await say('yes');
  assert.equal(toAgent.at(-1).text, 'yes');
  assert.equal(toAgent.at(-1).dispatchDraft, undefined);
  assert.equal(toAgent.at(-1).dispatchDrafts, true, 'Poe still knows it writes the dispatch');

  // With the drafts off, a DM is handed over exactly as before.
  config.dispatch.drafts.mode = 'off';
  await say('hi poe');
  config.dispatch.drafts.mode = 'on';
  assert.deepEqual(Object.keys(toAgent.at(-1)).sort(), ['dmId', 'guidance', 'operatorDid', 'text']);
});

test('no keeps it a draft', async () => {
  const w = desk();
  await readyDraft(w);
  const dm = answering();
  await fromDm(dm, { action: 'propose_publish', version: 1 });
  attachDraftReply(dm, 'ok');
  db.prepare(`UPDATE operator_dm SET status = 'sent', updated_at = ? WHERE message_id = ?`).run(new Date().toISOString(), dm);
  const no = { message_id: 'no-1', operator_did: admin, convo_id: 'poe-convo', received_at: new Date(Date.now() + 1000).toISOString() };
  db.prepare(`INSERT INTO operator_dm (message_id, convo_id, operator_did, received_at, status, updated_at) VALUES (?, ?, ?, ?, 'queued', ?)`)
    .run(no.message_id, no.convo_id, admin, no.received_at, new Date().toISOString());
  const live = livePublishFor(no);
  assert.equal(decidePublish(live.id, 'no', no.message_id), true);
  assert.equal(livePublishFor(no), null);
  assert.equal(currentDraft().status, 'ready');
  assert.equal(w.creates.length, 0);
});

// --- correcting a live issue ---

/** An issue made live from a draft, as publishing leaves it, with the clock past Leaflet's email. */
async function liveIssue(w) {
  w.sortKeys = true;
  const draft = await readyDraft(w);
  const dm = answering();
  await fromDm(dm, { action: 'propose_publish', version: 1 });
  attachDraftReply(dm, 'ok');
  db.prepare(`UPDATE dispatch_publish SET status = 'confirmed', decision_message_id = 'yes-live'`).run();
  assert.match(await publishConfirmed('yes-live', w.deps), /^it's live/);
  w.now += config.dispatch.leafletSettleMs + 60000;
  return getDraft(draft.id);
}

const TYPO = { find: 'the beta is close', replace: 'the beta is very close' };
let step = 0;

/** Poe proposes a fix in a DM, it goes out under the reply, and the operator answers straight back. Returns the answer's id. */
async function answerFix(call, answer = 'yes') {
  const at = Date.now() + ++step * 10000;
  const dm = `fix-${step}`;
  db.prepare(`INSERT INTO operator_dm (message_id, convo_id, operator_did, received_at, status, updated_at)
    VALUES (?, 'poe-convo', ?, ?, 'dispatched', ?)`).run(dm, admin, new Date(at).toISOString(), new Date().toISOString());
  const proposed = await fromDm(dm, { action: 'propose_correction', issue: 'latest', ...call });
  assert.equal(proposed.body.accepted, true, proposed.body.reason);
  const shown = attachDraftReply(dm, 'fixed it up, take a look');
  assert.equal(shown.proposal, true);
  db.prepare(`UPDATE operator_dm SET status = 'sent', updated_at = ? WHERE message_id = ?`).run(new Date().toISOString(), dm);
  const row = { message_id: `${answer}-${step}`, operator_did: admin, convo_id: 'poe-convo', received_at: new Date(at + 1000).toISOString() };
  db.prepare(`INSERT INTO operator_dm (message_id, convo_id, operator_did, received_at, status, updated_at) VALUES (?, ?, ?, ?, 'queued', ?)`)
    .run(row.message_id, row.convo_id, admin, row.received_at, new Date().toISOString());
  const live = liveCorrectionFor(row);
  assert.ok(live, 'the answer is to that fix');
  assert.equal(decideCorrection(live.id, answer, row.message_id), true);
  return { id: row.message_id, shown: shown.text };
}

test('a typo in a live issue: read as published, proposed, and put over the live record on a yes', async () => {
  const w = desk();
  const draft = await liveIssue(w);
  const rkey = draft.document_rkey;
  const created = w.creates[0].record;
  // A card as it was read when the issue went out; the page may say something else today.
  const published = JSON.parse(draft.record);
  const card = published.content.pages[0].blocks.find((b) => b.block.src === 'https://atpota.to/weather');
  card.block.title = 'the weather report, as it was';
  db.prepare('UPDATE dispatch_draft SET record = ? WHERE id = ?').run(JSON.stringify(published), draft.id);
  // And the announcement linked it, as announce() does once Leaflet has seen it.
  const linked = { ...w.docs.get(rkey), cid: 'bafylinked',
    value: { ...created, content: published.content, bskyPostRef: { uri: `at://${POE}/app.bsky.feed.post/3abc`, cid: 'bafyp' } } };
  w.docs.set(rkey, linked);

  const dm = answering();
  const read = await fromDm(dm, { action: 'read', issue: 'latest' });
  assert.equal(read.body.found, true);
  assert.equal(read.body.draft.status, 'published');
  assert.equal(read.body.draft.published, `https://atpota.to/blog/${rkey}`);
  assert.match(read.body.draft.markdown, /the beta is close/);
  assert.deepEqual((await fromDm(dm, { action: 'read', issue: `https://poe.leaflet.pub/${rkey}` })).body.draft.id, draft.id);
  assert.match((await fromDm(dm, { action: 'propose_correction', issue: 'latest', version: 3, edits: [TYPO] })).body.reason, /version 1/);

  const { id, shown } = await answerFix({ version: 1, edits: [TYPO] });
  assert.match(shown, new RegExp(`here's the fix to "spaces near beta", live at https://atpota\\.to/blog/${rkey}:`));
  assert.match(shown, /- "the beta is close" becomes "the beta is very close"/);
  assert.match(shown, /nobody is emailed again: subscribers keep the email they already got\./);
  assert.doesNotMatch(shown, /old card/, 'the title and description stay');
  assert.match(shown, /reply "yes" to fix it, or "no" to leave it as it is\.$/);
  assert.equal(w.puts.length, 0, 'a proposal changes nothing');

  const reply = await runConfirmed(id, w.deps);
  assert.match(reply, new RegExp(`^fixed ✿ https://atpota\\.to/blog/${rkey} has it now`));
  assert.match(reply, /nobody was emailed again/);
  assert.equal(w.creates.length, 1, 'a put, never a second create');
  assert.equal(w.puts.length, 1);
  const { record, swapRecord } = w.puts[0];
  assert.equal(swapRecord, 'bafylinked');
  assert.equal(record.path, created.path);
  assert.equal(record.publishedAt, created.publishedAt);
  assert.deepEqual(record.bskyPostRef, linked.value.bskyPostRef, 'the announcement link stays');
  assert.ok(Date.parse(record.updatedAt) > 0);
  assert.match(record.textContent, /the beta is very close/);
  assert.doesNotMatch(record.textContent, /the beta is close/);
  assert.equal(record.content.pages[0].blocks.find((b) => b.block.src === 'https://atpota.to/weather').block.title,
    'the weather report, as it was', 'a card the fix left alone is kept as published, not read again');

  const after = getDraft(draft.id);
  assert.equal(after.status, 'published');
  assert.equal(after.version, 2);
  assert.match(after.markdown, /the beta is very close/);
  assert.equal(db.prepare('SELECT saved_by FROM dispatch_draft_version WHERE draft_id = ? AND version = 2').get(draft.id).saved_by, `correction:${id}`);
  assert.match(previewFor(draft.preview_token).body.record.textContent, /very close/);

  // Asking again is safe: the stored answer, no second put.
  assert.equal(await runConfirmed(id, w.deps), reply);
  assert.equal(w.puts.length, 1);
  // A second fix builds on the first.
  assert.match((await fromDm(answering(), { action: 'propose_correction', issue: 'latest', version: 1, edits: [TYPO] })).body.reason, /version 2/);
});

test("a fix waits out Leaflet's email, stays small, and only touches issues Poe published here", async () => {
  const w = desk();
  last = w;
  const dm = answering();
  assert.match((await fromDm(dm, { action: 'read', issue: 'latest' })).body.reason, /haven't published an issue/);

  const draft = await liveIssue(w);
  w.now = Date.parse(draft.published_at) + 60000;
  assert.match((await fromDm(dm, { action: 'propose_correction', version: 1, edits: [TYPO] })).body.reason,
    /leaflet may still be emailing it; a change now could stop that email, so propose it again in 4 minutes/);
  w.now += config.dispatch.leafletSettleMs;

  const many = Array.from({ length: 11 }, (_, i) => ({ find: `x${i}`, replace: `y${i}` }));
  assert.match((await fromDm(dm, { action: 'propose_correction', version: 1, edits: many })).body.reason, /small fixes: at most 10 edits/);
  assert.match((await fromDm(dm, { action: 'propose_correction', version: 1, edits: [{ find: 'see you next week.', replace: 'z'.repeat(1600) }] })).body.reason,
    /1500 characters/);
  assert.match((await fromDm(dm, { action: 'propose_correction', version: 1, edits: [{ find: 'nope', replace: 'yes' }] })).body.reason, /isn't in the issue/);
  assert.match((await fromDm(dm, { action: 'propose_correction', version: 1, edits: [{ find: 'atmospher', replace: 'x' }] })).body.reason, /in the issue more than once/);
  assert.match((await fromDm(dm, { action: 'propose_correction', version: 1, edits: [{ find: TYPO.find, replace: TYPO.find }] })).body.reason, /changes nothing/);
  assert.match((await fromDm(dm, { action: 'propose_correction', version: 1 })).body.reason, /give the edits/);
  assert.match((await fromDm(dm, { action: 'propose_correction', issue: 'https://atpota.to/blog/3myasnk4bzk22', version: 1, edits: [TYPO] })).body.reason,
    /wasn't published from one of my drafts/);
  assert.match((await fromDm(dm, { action: 'propose_correction', issue: 'the one about cows', version: 1, edits: [TYPO] })).body.reason, /"latest", or by its link/);
  assert.match((await fromDm(dm, { action: 'save', issue: 'latest', edits: [TYPO] })).body.reason, /never saved over; propose a correction/);
  assert.equal((await fromDrafting(draft.id, { action: 'read', issue: 'latest' })).status, 409, 'the drafting turn is long over');

  // A new title says the cards already out keep the old one.
  const { id, shown } = await answerFix({ version: 1, title: 'spaces is nearly here' });
  assert.match(shown, /- the title becomes "spaces is nearly here"/);
  assert.match(shown, /a post that already links it keeps its old card\./);
  await runConfirmed(id, w.deps);
  assert.equal(w.puts.at(-1).record.title, 'spaces is nearly here');
  assert.equal(w.puts.at(-1).record.description, 'a quieter week', 'what the fix leaves alone stays');
  assert.equal(w.creates.length, 1);
});

test('a fix never writes over an edit made elsewhere, and survives a lost swap or a lost answer', async () => {
  const w = desk();
  const draft = await liveIssue(w);
  const rkey = draft.document_rkey;

  // Changed somewhere else since it went out: left alone.
  const first = await answerFix({ version: 1, edits: [TYPO] });
  const edited = w.docs.get(rkey);
  w.docs.set(rkey, { ...edited, cid: 'bafyelsewhere', value: { ...edited.value, title: 'someone else wrote this' } });
  assert.match(await runConfirmed(first.id, w.deps), /changed somewhere else\), so i didn't touch it/);
  assert.equal(w.puts.length, 0);
  assert.equal(getDraft(draft.id).version, 1);
  w.docs.set(rkey, edited);

  // The announcement's link lands between the read and the put: read again, keep it, put once.
  const second = await answerFix({ version: 1, edits: [TYPO] });
  w.writeFirst = (doc) => w.docs.set(rkey, { ...doc, cid: 'bafyraced', value: { ...doc.value, bskyPostRef: { uri: 'at://x/app.bsky.feed.post/1', cid: 'c' } } });
  assert.match(await runConfirmed(second.id, w.deps), /^fixed/);
  assert.equal(w.puts.length, 1);
  assert.equal(w.puts[0].swapRecord, 'bafyraced');
  assert.equal(w.puts[0].record.bskyPostRef.uri, 'at://x/app.bsky.feed.post/1');

  // A put that went through though its answer was lost is found on the live record.
  const third = await answerFix({ version: 2, edits: [{ find: 'see you next week.', replace: 'see you next week!' }] });
  w.failAfterPut = true;
  assert.match(await runConfirmed(third.id, w.deps), /^fixed/);
  assert.equal(w.puts.length, 2);
  assert.equal(getDraft(draft.id).version, 3);

  // A run a restart cut off after it was made, but before it answered, answers without a second put.
  db.prepare(`UPDATE dispatch_correction SET status = 'confirmed', reply = NULL WHERE decision_message_id = ?`).run(third.id);
  assert.match(await runConfirmed(third.id, w.deps), /^fixed/);
  assert.equal(w.puts.length, 2);

  // And one that never landed says so, and leaves the issue as it was.
  const fourth = await answerFix({ version: 3, edits: [{ find: 'see you next week!', replace: 'bye!' }] });
  const put = w.deps.putDocument;
  w.deps.putDocument = async () => { throw new Error('socket hang up'); };
  assert.match(await runConfirmed(fourth.id, w.deps), /didn't go through \(socket hang up\), so the issue is as it was/);
  w.deps.putDocument = put;
  assert.equal(getDraft(draft.id).version, 3);
});

test('no leaves a live issue as it is', async () => {
  const w = desk();
  const draft = await liveIssue(w);
  const { id } = await answerFix({ version: 1, edits: [TYPO] }, 'no');
  assert.equal(await runConfirmed(id, w.deps), null, 'a no is never applied');
  assert.equal(w.puts.length, 0);
  assert.equal(getDraft(draft.id).version, 1);
});

test('through the DM poll: a fix proposed, shown under the reply, and made on a plain yes', async () => {
  const w = desk();
  await liveIssue(w);
  const sent = [];
  const toAgent = [];
  const api = {
    inbox: [],
    listDmConvos: async () => ({ convos: [{ id: 'poe-convo', members: [{ did: POE }, { did: admin }] }] }),
    getDmMessages: async () => ({ messages: api.inbox }),
    sendDmMessage: async (_c, replyTo, text) => { sent.push({ replyTo, text }); return { id: `r${sent.length}` }; },
  };
  const fetcher = async (_url, options) => { toAgent.push(JSON.parse(options.body)); return { ok: true }; };
  let clock = 0;
  const say = async (text) => {
    const message = { id: `fixpoll-${++clock}`, text, sender: { did: admin }, sentAt: new Date(Date.now() + 120000 + clock * 1000).toISOString() };
    api.inbox = [message];
    await pollOperatorDms({ api, fetcher, draftDeps: w.deps });
    return message;
  };

  const ask = await say('typo in the latest issue: "the beta is close" should say very close');
  assert.equal(toAgent.at(-1).dispatchDraft, undefined, 'no draft in review; the issue is live');
  await fromDm(ask.id, { action: 'propose_correction', issue: 'latest', version: 1, edits: [TYPO] });
  assert.equal(receiveDraft({ key: 'k-fix', dmId: ask.id, operatorDid: admin, text: 'fixed it up, take a look' }), 'accepted');
  api.inbox = [];
  await pollOperatorDms({ api, fetcher, draftDeps: w.deps });
  assert.match(sent.at(-1).text, /reply "yes" to fix it/);

  const agentCalls = toAgent.length;
  await say('yes');
  await settleCommands();
  assert.equal(toAgent.length, agentCalls, 'the yes is not sent to Poe');
  assert.equal(w.puts.length, 1);
  assert.match(sent.at(-1).text, /^fixed ✿/);
});

test('on the callback server: the preview is public by its token, draft calls need the secret', async () => {
  const { startCallbackServer } = await import('../src/callback.js');
  const w = desk();
  const draft = await readyDraft(w);
  const server = startCallbackServer({ stats: { callbackUnauthorized: 0 } });
  await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/dispatch/preview/${draft.preview_token}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const body = await page.json();
    assert.equal(body.record.title, 'spaces near beta');
    assert.equal(body.draft.version, 1);
    assert.equal((await fetch(`${base}/dispatch/preview/nopenopenopenopenopenope`)).status, 404);
    assert.equal((await fetch(`${base}/dispatch/preview/%E0%A4%A`)).status, 404, 'a malformed escape is no token, not a hang');

    const call = (headers) => fetch(`${base}/callback`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ draftingId: draft.id, dispatchDraft: { action: 'read' } }),
    });
    assert.equal((await call({})).status, 401);
    assert.equal((await call({ 'x-atpotato-secret': config.sharedSecret })).status, 409, 'that turn is over');
  } finally {
    server.close();
  }
});

test('cards are read only from public https pages, never this machine or its network', () => {
  for (const ok of ['https://atpota.to/weather', 'https://pdsmoover.com/', 'https://sub.example.co.uk/a?b=1']) assert.equal(publicPage(ok), true, ok);
  for (const no of ['http://atpota.to', 'https://127.0.0.1:8787/health', 'https://localhost/', 'https://[::1]/', 'https://10.0.0.5/',
    'https://printer.local/', 'https://box.internal/', 'https://router.lan/', 'https://intranet/', 'https://user:pw@example.com/',
    'https://app.localhost/', 'not a url']) {
    assert.equal(publicPage(no), false, no);
  }
});

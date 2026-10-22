import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { db } from '../src/db.js';
import {
  parseConfirmation, proposalTextProblem, handleAnnounceProposal, confirmationBlock,
} from '../src/dispatch.js';
import { pollOperatorDms, settleCommands, receiveDraft } from '../src/operator-dm.js';
import { graphemeLength } from '../src/richtext.js';
import { POE, docUri, documentValue, network } from './fixtures/dispatch.js';

const admin = 'did:plc:operator123';
config.botDid = POE;
config.botHandle = 'poe.atpota.to';
config.adminDids = [admin];
config.dmEnabled = true;
config.dispatch.enabled = true;
config.dispatch.pagePollMs = 5;
config.dispatch.pageTimeoutMs = 60;

const RKEY = 'issueproposal';
const convo = { id: 'proposal-convo', members: [{ did: POE }, { did: admin }] };
const base = Date.now() + 60000;
let clock = 0;
/** Operator messages, each a second after the last, unless `at` says otherwise. */
const dm = (text, at = base + ++clock * 1000) => ({
  id: `proposal-msg-${clock}-${Math.random().toString(36).slice(2, 6)}`, text, sender: { did: admin },
  sentAt: new Date(at).toISOString(),
});

/** A DM conversation: what the operator sent, what Poe was asked, what came back. */
function conversation(deps) {
  const sent = [];
  const toAgent = [];
  const api = {
    inbox: [],
    listDmConvos: async () => ({ convos: [convo] }),
    getDmMessages: async () => ({ messages: api.inbox }),
    sendDmMessage: async (_c, replyTo, text) => { sent.push({ replyTo, text }); return { id: `r${sent.length}` }; },
  };
  const fetcher = async (url, options) => { toAgent.push(JSON.parse(options.body)); return { ok: true }; };
  return {
    sent, toAgent,
    async say(message) {
      api.inbox = [message];
      await pollOperatorDms({ api, fetcher, dispatchDeps: deps });
      await settleCommands();
    },
    async reply(dmId, text) {
      assert.equal(receiveDraft({ key: `k-${dmId}`, dmId, operatorDid: admin, text }), 'accepted');
      await pollOperatorDms({ api: { ...api, getDmMessages: async () => ({ messages: [] }) }, fetcher, dispatchDeps: deps });
      await settleCommands();
    },
  };
}

const propose = (dmId, extra = {}, deps) => handleAnnounceProposal({ dmId, operatorDid: admin, issue: 'latest', ...extra }, deps);
const statusOf = (dmId) => db.prepare('SELECT status FROM operator_dm WHERE message_id = ?').get(dmId)?.status;

// --- the pieces ------------------------------------------------------------------

test('only a whole-message yes or no is an answer', () => {
  for (const t of ['yes', 'Yes!', 'yes please', 'ok.', 'sure', 'post it', 'go ahead', '👍', '👍🏽', '  yep  ', 'please post it']) {
    assert.equal(parseConfirmation(t), 'yes', t);
  }
  for (const t of ['no', 'Nope.', 'not yet', 'cancel', "don't post it"]) assert.equal(parseConfirmation(t), 'no', t);
  for (const t of ['yes but shorter', 'yes, and mention spaces', 'no wait, make it funnier', 'approve', 'skip', 'yesterday', '']) {
    assert.equal(parseConfirmation(t), null, t);
  }
});

test('proposal text: no @handles, no links but the issue, no markdown, fits a post', () => {
  assert.equal(proposalTextProblem(`issue one is up https://poe.leaflet.pub/${RKEY}`, RKEY), null);
  assert.equal(proposalTextProblem(`issue one is up https://atpota.to/blog/${RKEY}/`, RKEY), null);
  assert.match(proposalTextProblem('thanks @alice.example for the tip', RKEY), /@-mentions/);
  assert.match(proposalTextProblem('read it at https://example.com/fake', RKEY), /links https:\/\/example\.com\/fake/);
  assert.match(proposalTextProblem(`https://poe.leaflet.pub/${RKEY}/../other`, RKEY), /links/);
  assert.match(proposalTextProblem('**big news** this week', RKEY), /markdown/);
  assert.match(proposalTextProblem('a'.repeat(301), RKEY), /301 graphemes/);
  assert.equal(proposalTextProblem('🥔'.repeat(300), RKEY), null);
});

test('the proposal endpoint is off without DISPATCH_ENABLED and only answers a DM Poe is answering', async () => {
  const { deps } = network(RKEY);
  config.dispatch.enabled = false;
  try {
    assert.equal((await propose('nope', {}, deps)).status, 503);
  } finally { config.dispatch.enabled = true; }
  assert.equal((await propose('no-such-dm', {}, deps)).status, 409);
  assert.equal((await handleAnnounceProposal({ dmId: 'x', operatorDid: 'not a did', issue: 'latest' }, deps)).status, 400);

  const c = conversation(deps);
  const ask = dm('hey, issue one is out, can you tell people?');
  await c.say(ask);
  assert.equal(statusOf(ask.id), 'dispatched');
  assert.equal((await handleAnnounceProposal({ dmId: ask.id, operatorDid: 'did:plc:someoneelse', issue: 'latest' }, deps)).status, 409);
  await c.reply(ask.id, 'hi!');                 // answered: no longer open to proposals
  assert.equal((await propose(ask.id, { text: 'x' }, deps)).status, 409);
});

test('without text the endpoint only looks the issue up; nothing is proposed', async () => {
  const { deps } = network(RKEY, { value: documentValue(RKEY, { textContent: 'word '.repeat(400) }) });
  const c = conversation(deps);
  const ask = dm('what would you post about the latest dispatch?');
  await c.say(ask);
  const res = await propose(ask.id, {}, deps);
  assert.equal(res.status, 200);
  assert.equal(res.body.accepted, false);
  assert.match(res.body.reason, /nothing proposed yet/);
  assert.equal(res.body.issue.title, 'attie sites, spaces near beta, and a brand new cow');
  assert.equal(res.body.issue.url, `https://atpota.to/blog/${RKEY}`);
  assert.ok(graphemeLength(res.body.issue.excerpt) <= 1200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM dispatch_proposal WHERE dm_message_id = ?').get(ask.id).n, 0);

  // A link or a bare rkey works as well as "latest"; anything else does not.
  assert.equal((await propose(ask.id, { issue: `https://poe.leaflet.pub/${RKEY}` }, deps)).body.issue.url, `https://atpota.to/blog/${RKEY}`);
  assert.match((await propose(ask.id, { issue: 'https://evil.example/x' }, deps)).body.reason, /not a dispatch issue/);
  await c.reply(ask.id, 'here is what is in it');
});

test('an issue that is already announced is not proposed again', async () => {
  const k = 'issueproposed2';
  const ref = { uri: `at://${POE}/app.bsky.feed.post/3mdone`, cid: 'bafydone' };
  const { deps } = network(k, { value: documentValue(k, { bskyPostRef: ref }) });
  const c = conversation(deps);
  const ask = dm('announce that one please');
  await c.say(ask);
  const res = await propose(ask.id, { issue: k, text: 'issue one!' }, deps);
  assert.deepEqual([res.body.accepted, res.body.reason, res.body.post],
    [false, 'that issue is already announced', 'https://bsky.app/profile/poe.atpota.to/post/3mdone']);
  await c.reply(ask.id, 'that one is already out!');
});

test('more than ten proposal calls for one DM are refused', async () => {
  const { deps } = network(RKEY);
  const c = conversation(deps);
  const ask = dm('try lots of versions');
  await c.say(ask);
  for (let i = 0; i < 10; i++) assert.equal((await propose(ask.id, {}, deps)).status, 200);
  assert.equal((await propose(ask.id, {}, deps)).status, 429);
  await c.reply(ask.id, 'ok');
});

// --- the conversation ------------------------------------------------------------

test('ask in plain words, see the exact post, say yes, and that exact post goes out once', async () => {
  const { s, deps } = network(RKEY);
  const c = conversation(deps);
  const ask = dm('issue one is up! can you let people know?');
  await c.say(ask);
  assert.equal(c.toAgent.length, 1, 'the request itself goes to Poe');
  assert.equal(c.toAgent[0].text, ask.text);

  const text = 'the first dispatch is out ⸜(｡˃ ᵕ ˂ )⸝ attie grew into a site builder, spaces got close to beta, and there is a cow.';
  const bad = await propose(ask.id, { text: `${text} thanks @dame.is` }, deps);
  assert.equal(bad.body.accepted, false);   // Poe fixes it and tries again in the same turn
  const res = await propose(ask.id, { text }, deps);
  assert.equal(res.body.accepted, true);
  await c.reply(ask.id, "ooh yes! here's what i'd say:");

  assert.equal(c.sent.length, 1);
  const shown = c.sent[0].text;
  assert.ok(shown.startsWith("ooh yes! here's what i'd say:\n\nhere's the post, with a card for \"attie sites"));
  assert.ok(shown.includes(`(https://poe.leaflet.pub/${RKEY}):\n\n${text}\n\n`), 'names the url the card links');
  assert.match(shown, /reply "yes" to post it from poe, or "no" to drop it\.$/);
  assert.equal(s.created.length, 0, 'nothing posts on a proposal');

  const yes = dm('Yes!');
  await c.say(yes);
  assert.equal(c.toAgent.length, 1, 'the yes is not sent to Poe');
  assert.equal(s.created.length, 1);
  assert.equal(s.created[0].record.text, text);
  assert.equal(s.created[0].record.embed.external.uri, `https://poe.leaflet.pub/${RKEY}`);
  assert.match(c.sent[1].text, /^announced ⸜\(｡˃ ᵕ ˂ \)⸝ https:\/\/bsky\.app\/profile\/poe\.atpota\.to\/post\//);
  assert.equal(c.sent[1].replyTo, yes.id);

  // A second yes is just conversation now.
  await c.say(dm('yes'));
  assert.equal(s.created.length, 1);
  assert.equal(c.toAgent.length, 2);
});

test('a long reply is cut to make room; the proposal never is', async () => {
  const k = 'issuelongreply';
  const { deps } = network(k);
  const c = conversation(deps);
  const ask = dm('announce the new one');
  await c.say(ask);
  const text = 'z'.repeat(290);
  assert.equal((await propose(ask.id, { issue: k, text }, deps)).body.accepted, true);
  await c.reply(ask.id, 'so many thoughts '.repeat(80));
  const shown = c.sent.at(-1).text;
  assert.ok(graphemeLength(shown) <= 999, `${graphemeLength(shown)} graphemes`);
  const proposal = db.prepare(`SELECT * FROM dispatch_proposal WHERE dm_message_id = ?`).get(ask.id);
  assert.ok(shown.endsWith(confirmationBlock(proposal)));
  assert.match(shown, /^so many thoughts .*…\n\n/s);
  await c.say(dm('no'));   // tidy up
});

test('no drops it, and a later yes goes to Poe', async () => {
  const k = 'issuedecline1';
  const { s, deps } = network(k);
  const c = conversation(deps);
  const ask = dm('wanna announce the dispatch?');
  await c.say(ask);
  await propose(ask.id, { issue: k, text: 'dispatch time' }, deps);
  await c.reply(ask.id, 'yes!!');
  await c.say(dm('nope'));
  assert.equal(c.sent.at(-1).text, "ok, i won't post it.");
  await c.say(dm('yes'));
  assert.equal(s.created.length, 0);
  assert.equal(c.toAgent.at(-1).text, 'yes');
});

test('a yes after anything else was said goes to Poe, not to the old proposal', async () => {
  const k = 'issueinterlude';
  const { s, deps } = network(k);
  const c = conversation(deps);
  const ask = dm('announce it?');
  await c.say(ask);
  await propose(ask.id, { issue: k, text: 'dispatch time' }, deps);
  await c.reply(ask.id, 'here you go');
  const aside = dm('also, did you see the pds moover thing?');
  await c.say(aside);
  await c.reply(aside.id, 'i did! want me to save a note about it?');
  await c.say(dm('yes'));
  assert.equal(s.created.length, 0);
  assert.equal(c.toAgent.at(-1).text, 'yes');
});

test('a yes more than six hours later goes to Poe', async () => {
  const k = 'issuestale001';
  const { s, deps } = network(k);
  const c = conversation(deps);
  const ask = dm('announce it?');
  await c.say(ask);
  await propose(ask.id, { issue: k, text: 'dispatch time' }, deps);
  await c.reply(ask.id, 'here you go');
  await c.say(dm('yes', Date.now() + 7 * 3600 * 1000));
  assert.equal(s.created.length, 0);
  assert.equal(c.toAgent.at(-1).text, 'yes');
});

test('a newer proposal replaces the old one, and yes posts the newer text', async () => {
  const k = 'issuerevised1';
  const { s, deps } = network(k);
  const c = conversation(deps);
  const ask = dm('announce it?');
  await c.say(ask);
  await propose(ask.id, { issue: k, text: 'first try' }, deps);
  await c.reply(ask.id, 'how about this');
  const notes = dm('make it about the cow');
  await c.say(notes);
  await propose(notes.id, { issue: k, text: 'there is a cow in the atmosphere now' }, deps);
  await c.reply(notes.id, 'better?');
  await c.say(dm('ship it'));
  assert.equal(s.created.length, 1);
  assert.equal(s.created[0].record.text, 'there is a cow in the atmosphere now');
  const statuses = db.prepare(`SELECT status FROM dispatch_proposal WHERE document_rkey = ? ORDER BY id`).all(k).map((r) => r.status);
  assert.deepEqual(statuses, ['superseded', 'confirmed']);
});

test('a proposal Poe never replied with cannot be confirmed', async () => {
  const k = 'issueunsent01';
  const { s, deps } = network(k);
  const c = conversation(deps);
  const ask = dm('announce it?');
  await c.say(ask);
  await propose(ask.id, { issue: k, text: 'dispatch time' }, deps);
  // No reply from Poe yet, so the operator has not seen it.
  await c.say(dm('yes'));
  assert.equal(s.created.length, 0);
  assert.equal(c.toAgent.at(-1).text, 'yes');
});

test('the proposal is only shown under the reply to the DM it was made for', async () => {
  const k = 'issuewrongdm1';
  const { deps } = network(k);
  const c = conversation(deps);
  const one = dm('first message');
  await c.say(one);
  await propose(one.id, { issue: k, text: 'dispatch time' }, deps);
  await c.reply(one.id, 'here you go');
  assert.match(c.sent.at(-1).text, /reply "yes"/);
  const two = dm('second message');
  await c.say(two);
  await c.reply(two.id, 'just chatting');
  assert.equal(c.sent.at(-1).text, 'just chatting');
  assert.equal(db.prepare('SELECT status FROM dispatch_proposal WHERE dm_message_id = ?').get(one.id).status, 'attached');
  assert.ok(docUri(k));
});

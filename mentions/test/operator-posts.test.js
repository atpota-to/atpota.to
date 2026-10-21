import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, GATE_DEFAULTS } from '../src/config.js';
import { db } from '../src/db.js';
import { pollOperatorDms, receiveDraft } from '../src/operator-dm.js';
import { postGate } from '../src/gates/weather.js';
import { WEATHER_CARD } from '../src/weather-posts.js';
import { handlePostProposal, postTextProblem, postConfirmationBlock } from '../src/operator-posts.js';

const POE = 'did:plc:6qw63oash3jfnpykvpbwnq5z';
const admin = 'did:plc:operator123';
config.botDid = POE;
config.botHandle = 'poe.atpota.to';
config.adminDids = [admin];
config.dmEnabled = true;
config.dispatch.enabled = true;   // both kinds of proposal side by side

const convo = { id: 'post-convo', members: [{ did: POE }, { did: admin }] };
const base = Date.now() + 60000;
let clock = 0;
const dm = (text, at = base + ++clock * 1000) => ({
  id: `post-msg-${clock}-${Math.random().toString(36).slice(2, 6)}`, text, sender: { did: admin },
  sentAt: new Date(at).toISOString(),
});

/** Poe's account and the web, for posting. */
function world({ cardDown = false, blogImage = 'https://atpota.to/og/blog.png' } = {}) {
  const w = { created: [], cards: [], images: [], pages: [] };
  w.deps = {
    fetchCard: async (url) => {
      w.cards.push(url);
      if (cardDown) throw new Error('the weather card answered 404 text/html');
      return { bytes: Buffer.from('png'), mimeType: 'image/png' };
    },
    fetchPage: async (url) => {
      w.pages.push(url);
      return { status: 200, html: `<meta property="og:title" content="poe's atmosphere dispatch">
        <meta property="og:description" content="a weekly roundup"><meta property="og:image" content="${blogImage}">` };
    },
    fetchImage: async (url) => { w.images.push(url); return { bytes: Buffer.from('png'), mimeType: 'image/png' }; },
    uploadBlob: async (bytes, mimeType) => ({ $type: 'blob', ref: { $link: 'bafycard' }, mimeType, size: bytes.length }),
    createPost: async (record, rkey) => {
      assert.ok(rkey, 'posts under a stored key');
      w.created.push({ record, rkey });
      return { uri: `at://${POE}/app.bsky.feed.post/${rkey}`, cid: `bafypost${w.created.length}` };
    },
    sleep: async () => {},
  };
  return w;
}

/** A DM conversation: what the operator sent, what Poe was asked, what came back. */
function conversation(postDeps) {
  const sent = [];
  const toAgent = [];
  const api = {
    inbox: [],
    listDmConvos: async () => ({ convos: [convo] }),
    getDmMessages: async () => ({ messages: api.inbox }),
    sendDmMessage: async (_c, replyTo, text) => { sent.push({ replyTo, text }); return { id: `r${sent.length}` }; },
  };
  const fetcher = async (_url, options) => { toAgent.push(JSON.parse(options.body)); return { ok: true }; };
  return {
    sent, toAgent,
    async say(message) {
      api.inbox = [message];
      await pollOperatorDms({ api, fetcher, postDeps });
    },
    async reply(dmId, text) {
      assert.equal(receiveDraft({ key: `k-${dmId}`, dmId, operatorDid: admin, text }), 'accepted');
      await pollOperatorDms({ api: { ...api, getDmMessages: async () => ({ messages: [] }) }, fetcher, postDeps });
    },
  };
}

const propose = (dmId, text, card = 'weather', extra = {}) =>
  handlePostProposal({ dmId, operatorDid: admin, proposal: { text, card }, ...extra });

test('post text: fits a post, no @handles, no links, no markdown', () => {
  assert.equal(postTextProblem('breezy out there', 'weather'), null);
  assert.match(postTextProblem('', 'none'), /empty/);
  assert.match(postTextProblem('a'.repeat(301), 'none'), /graphemes/);
  assert.match(postTextProblem('thanks @dame.is', 'none'), /@-mentions/);
  assert.match(postTextProblem('read it: https://atpota.to/blog', 'newsletter'), /card under the post already links it/);
  assert.match(postTextProblem('see https://example.com', 'none'), /can't carry one/);
  assert.match(postTextProblem('**breezy**', 'weather'), /markdown/);
});

test('a proposal is taken only from a DM Poe is answering, with a known card', async () => {
  const c = conversation(world().deps);
  const ask = dm('post about the weather?');
  assert.equal(propose(ask.id, 'breezy').status, 409, 'before Poe has the DM');
  await c.say(ask);
  assert.equal(propose(ask.id, 'breezy', 'tornado').status, 400);
  assert.equal(propose(ask.id, 'breezy', 'weather', { operatorDid: 'did:plc:someoneelse' }).status, 409);
  assert.equal(propose(ask.id, 'thanks @dame.is').body.accepted, false);
  assert.equal(propose(ask.id, 'breezy').body.accepted, true);
  await c.say(dm('no'));   // tidy up: nothing attached yet, so this goes to Poe
});

test('ask for a weather post, see the exact post with its card, say yes, and it goes out once', async () => {
  const w = world();
  const c = conversation(w.deps);
  const ask = dm('can you post about the weather right now?');
  await c.say(ask);
  assert.equal(c.toAgent.at(-1).text, ask.text, 'the request itself goes to Poe');

  const text = 'breezy skies over the atmosphere, about 420 new records a second (◕‿◕)';
  assert.equal(propose(ask.id, text).body.accepted, true);
  await c.reply(ask.id, "here's what i'd say:");
  const shown = c.sent.at(-1).text;
  assert.equal(shown, `here's what i'd say:\n\n${postConfirmationBlock({ text, card: 'weather' })}`);
  assert.ok(shown.includes('the card for the atmosphere weather report (https://atpota.to/weather)'));
  assert.equal(w.created.length, 0, 'nothing posts on a proposal');

  const agentCalls = c.toAgent.length;
  const yes = dm('yes please');
  await c.say(yes);
  assert.equal(c.toAgent.length, agentCalls, 'the yes is not sent to Poe');
  assert.equal(w.created.length, 1);
  const { record, rkey } = w.created[0];
  assert.equal(record.text, text);
  assert.equal(record.embed.external.uri, 'https://atpota.to/weather');
  assert.equal(record.embed.external.thumb.ref.$link, 'bafycard');
  // the live weather card by its own address, in the forecast design
  const card = new URL(w.cards[0]);
  assert.equal(`${card.origin}${card.pathname}`, WEATHER_CARD);
  assert.equal(card.searchParams.get('card'), 'forecast');
  assert.equal(c.sent.at(-1).text, `posted! https://bsky.app/profile/poe.atpota.to/post/${rkey}`);
  assert.equal(c.sent.at(-1).replyTo, yes.id);

  // It counts with the weather posts, so the automatic ones keep their distance.
  const rows = db.prepare(`SELECT * FROM weather_post WHERE kind = 'operator'`).all();
  assert.equal(rows.length, 1);
  assert.equal(postGate(rows, Date.now(), GATE_DEFAULTS), 'min_gap');

  // A second yes is just conversation now.
  await c.say(dm('yes'));
  assert.equal(w.created.length, 1);
  assert.equal(c.toAgent.at(-1).text, 'yes');
});

test('a newsletter post carries the blog card, and a post with no card carries none', async () => {
  const w = world();
  const c = conversation(w.deps);
  const ask = dm('promote the newsletter?');
  await c.say(ask);
  assert.equal(propose(ask.id, 'a potato writes a weekly roundup of the atmosphere. come read it', 'newsletter').body.accepted, true);
  await c.reply(ask.id, 'ooh yes');
  await c.say(dm('yes'));
  const news = w.created.at(-1).record;
  assert.equal(news.embed.external.uri, 'https://atpota.to/blog');
  assert.equal(news.embed.external.title, "poe's atmosphere dispatch");
  assert.deepEqual(w.images, ['https://atpota.to/og/blog.png']);

  const plain = dm('say good morning to everyone');
  await c.say(plain);
  assert.equal(propose(plain.id, 'good morning, atmosphere!', 'none').body.accepted, true);
  await c.reply(plain.id, 'morning!');
  assert.ok(c.sent.at(-1).text.includes("here's the post, with no card:"));
  await c.say(dm('ok'));
  const bare = w.created.at(-1).record;
  assert.equal(bare.text, 'good morning, atmosphere!');
  assert.equal(bare.embed, undefined);
});

test('no drops it; a yes after anything else was said goes to Poe', async () => {
  const w = world();
  const c = conversation(w.deps);
  const ask = dm('post the weather');
  await c.say(ask);
  propose(ask.id, 'calm skies today');
  await c.reply(ask.id, 'here you go');
  await c.say(dm('nope'));
  assert.equal(c.sent.at(-1).text, "ok, i won't post it.");

  const again = dm('post the weather');
  await c.say(again);
  propose(again.id, 'calm skies today, honestly');
  await c.reply(again.id, 'here you go');
  const aside = dm('also how was your day?');
  await c.say(aside);
  await c.reply(aside.id, 'lovely! want to hear about it?');
  await c.say(dm('yes'));
  assert.equal(w.created.length, 0);
  assert.equal(c.toAgent.at(-1).text, 'yes');
});

test('without its card a post does not go out, and the operator is told why', async () => {
  const w = world({ cardDown: true });
  const c = conversation(w.deps);
  const ask = dm('post the weather');
  await c.say(ask);
  propose(ask.id, 'gusty out there');
  await c.reply(ask.id, 'here');
  await c.say(dm('yes'));
  assert.equal(w.created.length, 0);
  assert.equal(w.cards.length, 2, 'one retry');
  assert.match(c.sent.at(-1).text, /^i didn't post it: the card for the atmosphere weather report isn't loading right now \(the weather card answered 404/);
  assert.equal(db.prepare(`SELECT status FROM operator_post ORDER BY id DESC LIMIT 1`).get().status, 'failed');
});

test('a proposal arrives on the callback URL, told apart by its proposal', async () => {
  const { startCallbackServer } = await import('../src/callback.js');
  const c = conversation(world().deps);
  const ask = dm('post something');
  await c.say(ask);
  const server = startCallbackServer({ stats: { callbackUnauthorized: 0, callbackInvalid: 0 } });
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
  const url = `http://127.0.0.1:${server.address().port}/callback`;
  const body = JSON.stringify({ dmId: ask.id, operatorDid: admin, proposal: { text: 'hello sky', card: 'none' } });
  try {
    assert.equal((await fetch(url, { method: 'POST', body })).status, 401);
    const res = await fetch(url, { method: 'POST', headers: { 'x-atpotato-secret': config.sharedSecret }, body });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).accepted, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  await c.reply(ask.id, 'here');
  await c.say(dm('no'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { db } from '../src/db.js';
import {
  parseAnnounceCommand, parseIssueLink, defaultPostText, fitPostText, nextTid,
  pageHasDocument, ogImageUrl, announce, buildAnnouncement, latestDocument, ANNOUNCE_USAGE,
} from '../src/dispatch.js';
import { pollOperatorDms, settleCommands } from '../src/operator-dm.js';
import { graphemeLength, shortenLinks } from '../src/richtext.js';
import { docUri, pageFor, documentValue, network } from './fixtures/dispatch.js';

const POE = 'did:plc:6qw63oash3jfnpykvpbwnq5z';
const PUBLISHER = config.dispatch.publisherDid;
const PUBLICATION = config.dispatch.publicationUri;
const admin = 'did:plc:operator123';
config.botDid = POE;
config.botHandle = 'poe.atpota.to';
config.adminDids = [admin];
config.dmEnabled = true;
config.dispatch.enabled = true;
config.dispatch.pagePollMs = 5;
config.dispatch.pageTimeoutMs = 60;

// --- parsing -----------------------------------------------------------------

test('announce parses every link form, any case, with text on the following lines', () => {
  const k = '3myasnk4bzk22';
  assert.deepEqual(parseAnnounceCommand(`announce https://poe.leaflet.pub/${k}`), { kind: 'announce', rkey: k, text: null });
  assert.deepEqual(parseAnnounceCommand(`ANNOUNCE https://atpota.to/blog/${k}/`), { kind: 'announce', rkey: k, text: null });
  assert.deepEqual(parseAnnounceCommand(`Announce ${docUri(k)}\nissue one is out\n\nread it`),
    { kind: 'announce', rkey: k, text: 'issue one is out\n\nread it' });
  assert.equal(parseIssueLink(`poe.leaflet.pub/${k}`), k);
  assert.equal(parseIssueLink(`https://poe.leaflet.pub/${k}?utm=x#top`), k);
});

test('announce with a bad link gets the usage; plain words go to Poe', () => {
  for (const text of ['announce https://evil.example/3myasnk4bzk22',
    'announce at://did:plc:someoneelse/site.standard.document/3myasnk4bzk22',
    'announce https://poe.leaflet.pub/3myasnk4bzk22 with words after it',
    'announce https://poe.leaflet.pub/a/b', 'announce poe.leaflet.pub/']) {
    assert.deepEqual(parseAnnounceCommand(text), { kind: 'usage' }, text);
  }
  for (const text of ['announce', 'announce that one please', 'announce it?', 'announce tomorrow',
    'announcement looks good', 'please announce https://poe.leaflet.pub/3myasnk4bzk22']) {
    assert.equal(parseAnnounceCommand(text), null, text);
  }
});

test('announce latest parses in its plain-English forms, with text after', () => {
  for (const text of ['announce latest', 'Announce the latest dispatch', 'announce latest issue', 'announce the latest.']) {
    assert.deepEqual(parseAnnounceCommand(text), { kind: 'announce', latest: true, rkey: null, text: null }, text);
  }
  assert.deepEqual(parseAnnounceCommand('announce latest\nissue two is up'),
    { kind: 'announce', latest: true, rkey: null, text: 'issue two is up' });
  for (const text of ['announce latest news', 'announce the dispatch', 'announce latest latest']) {
    assert.equal(parseAnnounceCommand(text), null, text);
  }
});

test('latest is the newest issue by publishedAt in the dispatch, never another publication', async () => {
  const doc = (rkey, publishedAt, extra = {}) => ({
    uri: docUri(rkey), cid: `bafy${rkey}`, value: documentValue(rkey, { publishedAt, title: rkey, ...extra }),
  });
  const deps = {
    listDocuments: async () => [
      doc('issueone', '2026-10-19T19:02:15.894Z'),
      doc('issuetwo', '2026-10-26T09:00:00.000Z'),
      doc('otherpub', '2026-11-01T00:00:00.000Z', { site: `at://${PUBLISHER}/site.standard.publication/3lrdzen52y223` }),
      doc('nodate', 'not a date'),
      { uri: `at://did:plc:someoneelse/site.standard.document/stray`, cid: 'x', value: documentValue('stray', { publishedAt: '2027-01-01T00:00:00Z' }) },
    ],
  };
  assert.deepEqual(await latestDocument(deps), { rkey: 'issuetwo', title: 'issuetwo' });
  assert.equal(await latestDocument({ listDocuments: async () => [] }), null);
});

test('default text is title, blank line, description, cut at a word boundary', () => {
  assert.equal(defaultPostText('title', 'desc'), 'title\n\ndesc');
  assert.equal(defaultPostText('title', ''), 'title');
  const long = defaultPostText('a title', 'word '.repeat(80));
  assert.ok(graphemeLength(long) <= 300);
  assert.match(long, /^a title\n\n(word )+word…$/);
  assert.equal(fitPostText('x'.repeat(400)).length, 300);
});

test('TIDs sort by time and use the record key alphabet', () => {
  const a = nextTid(Date.parse('2026-10-19T19:00:00Z'));
  const b = nextTid(Date.parse('2026-10-19T19:00:00Z'));
  assert.match(a, /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/);
  assert.ok(b > a);
});

test('page check reads the verification link and the og:image', () => {
  const k = 'pagecheck';
  assert.equal(pageHasDocument(pageFor(k), docUri(k)), true);
  assert.equal(pageHasDocument(`<link href='${docUri(k)}' rel='site.standard.document'>`, docUri(k)), true);
  assert.equal(pageHasDocument(`<link rel="alternate" href="${docUri(k)}">`, docUri(k)), false);
  assert.equal(pageHasDocument(pageFor('other'), docUri(k)), false);
  assert.equal(ogImageUrl('<meta property="og:image" content="https://leaflet.pub/a?b=1&amp;c=2">'),
    'https://leaflet.pub/a?b=1&c=2');
});

// --- announce ----------------------------------------------------------------

test('announce posts once, links the issue with swapRecord, and keeps every other field', async () => {
  const k = 'issueone0001';
  const { s, deps } = network(k);
  const original = structuredClone(s.docs.get(k));
  const reply = await announce({ rkey: k, text: null }, deps);

  assert.equal(s.created.length, 1);
  const { record, rkey: postRkey } = s.created[0];
  assert.equal(record.text, `${original.value.title}\n\n${original.value.description}`);
  assert.deepEqual(record.langs, ['en']);
  assert.equal(record.embed.$type, 'app.bsky.embed.external');
  assert.equal(record.embed.external.uri, `https://poe.leaflet.pub/${k}`);
  assert.equal(record.embed.external.title, original.value.title);
  assert.equal(record.embed.external.description, original.value.description);
  assert.equal(record.embed.external.thumb.ref.$link, 'bafkthumb');
  assert.deepEqual(s.images, ['https://leaflet.pub/lish/og.png']);
  assert.equal(record.facets, undefined);

  assert.equal(s.puts.length, 1);
  assert.equal(s.puts[0].swapRecord, original.cid);
  const { bskyPostRef, updatedAt, ...rest } = s.puts[0].record;
  const { updatedAt: _old, ...originalRest } = original.value;
  assert.deepEqual(rest, originalRest);
  assert.deepEqual(bskyPostRef, { uri: `at://${POE}/app.bsky.feed.post/${postRkey}`, cid: s.posts.get(postRkey).cid });
  assert.notEqual(updatedAt, original.value.updatedAt);
  assert.equal(s.puts[0].record.publishedAt, original.value.publishedAt);

  assert.match(reply, new RegExp(`https://bsky\\.app/profile/poe\\.atpota\\.to/post/${postRkey}`));
  assert.match(reply, /links to it now/);
});

test('a repeated command posts once', async () => {
  const k = 'issuerepeat1';
  const { s, deps } = network(k);
  await announce({ rkey: k }, deps);
  const again = await announce({ rkey: k }, deps);
  assert.equal(s.created.length, 1);
  assert.equal(s.puts.length, 1);
  assert.match(again, /^already announced: https:\/\/bsky\.app\/profile\/poe\.atpota\.to\/post\//);

  // And when only our table knows about the post: the document never got linked.
  const k2 = 'issuerepeat2';
  const net2 = network(k2, { publisher: false });
  const first = await announce({ rkey: k2 }, net2.deps);
  assert.match(first, /npm run publish:dispatch -- <issue file> --rkey issuerepeat2 --bsky-post https:\/\/bsky\.app/);
  const second = await announce({ rkey: k2 }, net2.deps);
  assert.equal(net2.s.created.length, 1);
  assert.match(second, /^already announced:/);
});

test('a document that already has bskyPostRef is never announced again', async () => {
  const k = 'issuelinked1';
  const ref = { uri: `at://${POE}/app.bsky.feed.post/3mexisting`, cid: 'bafyexisting' };
  const { s, deps } = network(k, { value: documentValue(k, { bskyPostRef: ref }) });
  const reply = await announce({ rkey: k }, deps);
  assert.equal(reply, 'already announced: https://bsky.app/profile/poe.atpota.to/post/3mexisting');
  assert.equal(s.created.length, 0);
  assert.equal(s.pageUrls.length, 0);
});

test('a document from another publication is refused', async () => {
  const k = 'issueforeign';
  const { s, deps } = network(k, {
    value: documentValue(k, { site: `at://${PUBLISHER}/site.standard.publication/someotherpub` }),
  });
  const reply = await announce({ rkey: k }, deps);
  assert.match(reply, /isn't in poe's atmosphere dispatch/);
  assert.equal(s.created.length + s.puts.length + s.pageUrls.length, 0);

  const missing = network('issueabsent');
  missing.s.docs.clear();
  assert.match(await announce({ rkey: 'issueabsent' }, missing.deps), /couldn't find/);
});

test('operator text over 300 graphemes is refused, not cut', async () => {
  const k = 'issuetoolong';
  const { s, deps } = network(k);
  const reply = await announce({ rkey: k, text: 'a'.repeat(301) }, deps);
  assert.match(reply, /301 graphemes/);
  assert.equal(s.created.length + s.pageUrls.length, 0);

  // 300 graphemes is fine, however many code units it is.
  const ok = await announce({ rkey: k, text: '🥔'.repeat(300) }, deps);
  assert.match(ok, /^announced/);
  assert.equal(s.created[0].record.text, '🥔'.repeat(300));
});

test('the post has no mention facets; only the issue link is a facet', async () => {
  const k = 'issuefacets1';
  const { s, deps } = network(k);
  const text = `issue one, with @alice.example and @bob.example in it\nhttps://poe.leaflet.pub/${k}\nalso https://example.com/x`;
  await announce({ rkey: k, text }, deps);
  const { record } = s.created[0];
  assert.equal(record.facets.length, 1);
  const [facet] = record.facets;
  assert.deepEqual(facet.features, [{ $type: 'app.bsky.richtext.facet#link', uri: `https://poe.leaflet.pub/${k}` }]);
  assert.equal(Buffer.from(text).subarray(facet.index.byteStart, facet.index.byteEnd).toString(), `https://poe.leaflet.pub/${k}`);
  assert.ok(!JSON.stringify(record).includes('#mention'));
});

test('buildAnnouncement links the blog URL too, and nothing else', () => {
  const record = buildAnnouncement({
    text: 'a https://atpota.to/blog/x b https://atpota.to/other', pageUrl: 'https://poe.leaflet.pub/x',
    alsoLinks: ['https://atpota.to/blog/x'], title: 't', description: 'd',
  });
  assert.deepEqual(record.facets.map((f) => f.features[0].uri), ['https://atpota.to/blog/x']);
  assert.equal(record.embed.external.thumb, undefined);
});

test('with no atpota.to credential it posts and DMs the manual link command', async () => {
  const k = 'issuenocreds';
  const { s, deps } = network(k, { publisher: false });
  const reply = await announce({ rkey: k }, deps);
  assert.equal(s.created.length, 1);
  assert.equal(s.puts.length, 0);
  assert.match(reply, new RegExp(`npm run publish:dispatch -- <issue file> --rkey ${k} --bsky-post https://bsky.app/profile/poe.atpota.to/post/${s.created[0].rkey}`));
});

test('a swap failure re-reads the document and retries once on top of the edit', async () => {
  const k = 'issueswap001';
  const { s, deps } = network(k);
  let edited = false;
  s.beforePut = (state) => {
    if (edited) return;
    edited = true;
    const cur = state.docs.get(k);
    state.docs.set(k, { ...cur, cid: 'bafyedited', value: { ...cur.value, description: 'edited by hand' } });
  };
  const reply = await announce({ rkey: k }, deps);
  assert.equal(s.puts.length, 2);
  assert.equal(s.puts[1].swapRecord, 'bafyedited');
  assert.equal(s.puts[1].record.description, 'edited by hand');
  assert.ok(s.puts[1].record.bskyPostRef);
  assert.match(reply, /links to it now/);
});

test('a page that never shows the issue stops before posting', async () => {
  const k = 'issuenopage1';
  const { s, deps } = network(k, { page: () => ({ status: 404, html: 'not yet' }) });
  const reply = await announce({ rkey: k }, deps);
  assert.ok(s.pageUrls.length >= 2, 'polled more than once');
  assert.equal(s.created.length, 0);
  assert.match(reply, /didn't show the issue .*HTTP 404.*didn't post/s);

  // Leaflet catches up: the next command posts.
  const later = network(k, { page: (n) => (n < 3 ? { status: 200, html: '<html></html>' } : { status: 200, html: pageFor(k) }) });
  assert.match(await announce({ rkey: k }, later.deps), /^announced/);
  assert.equal(later.s.created.length, 1);
});

test('a card image on another site is skipped, and the post still goes out', async () => {
  const k = 'issueoffsite';
  const { s, deps } = network(k, { page: () => ({ status: 200, html: pageFor(k, { image: 'https://tracker.example/og.png' }) }) });
  const reply = await announce({ rkey: k }, deps);
  assert.equal(s.images.length, 0);
  assert.equal(s.created[0].record.embed.external.thumb, undefined);
  assert.match(reply, /the card has no image: the og:image is not on leaflet\.pub/);
});

test('a post made before a crash is found under its stored key, not made again', async () => {
  const k = 'issuecrash01';
  const { s, deps } = network(k);
  s.failCreateAfterWrite = true;       // the post landed but the answer was lost
  await assert.rejects(announce({ rkey: k }, deps), /socket hang up/);
  assert.equal(s.created.length, 1);
  const reply = await announce({ rkey: k }, deps);
  assert.equal(s.created.length, 1);
  assert.match(reply, /^announced/);
  assert.equal(s.puts.length, 1);
  const row = db.prepare('SELECT * FROM dispatch_document WHERE document_uri = ?').get(docUri(k));
  assert.equal(row.post_uri, `at://${POE}/app.bsky.feed.post/${s.created[0].rkey}`);
  assert.ok(row.linked_at);
});

test('a link that failed after posting is retried by the next command, without posting', async () => {
  const k = 'issuelinkfl1';
  const { s, deps } = network(k);
  s.failPut = Object.assign(new Error('upstream timeout'), { status: 502 });
  const first = await announce({ rkey: k }, deps);
  assert.match(first, /^announced/);
  assert.match(first, /linking the issue failed \(upstream timeout\)/);
  const second = await announce({ rkey: k }, deps);
  assert.equal(s.created.length, 1);
  assert.match(second, /^already announced:.*\n\nthe issue links to it now\./s);
});

test('the kill switch stops an announcement before the page check', async () => {
  const k = 'issuekilled1';
  const { s, deps } = network(k);
  process.env.KILL_SWITCH = 'true';
  try {
    assert.match(await announce({ rkey: k }, deps), /kill switch/);
  } finally { delete process.env.KILL_SWITCH; }
  assert.equal(s.created.length + s.pageUrls.length, 0);
});

// --- through the DM bridge -----------------------------------------------------

const convo = { id: 'dispatch-convo', members: [{ did: POE }, { did: admin }] };
let msgCounter = 0;
const future = () => new Date(Date.now() + 60000 + msgCounter * 1000).toISOString();
const dm = (text, extra = {}) => ({ id: `dispatch-msg-${++msgCounter}`, text, sender: { did: admin }, sentAt: future(), ...extra });

function inbox(messages, sent) {
  return {
    listDmConvos: async () => ({ convos: [convo] }),
    getDmMessages: async () => ({ messages }),
    sendDmMessage: async (convoId, replyTo, text) => { sent.push({ convoId, replyTo, text }); return { id: `reply-${sent.length}` }; },
  };
}

test('an announce DM is handled here, never forwarded to the agent, and answered once', async () => {
  const k = 'issuedmflow1';
  const { s, deps } = network(k);
  // The app shortens the link and keeps the full URL only in the facet.
  const short = shortenLinks(`announce https://atpota.to/blog/${k}`);
  assert.notEqual(short.text, `announce https://atpota.to/blog/${k}`);
  const message = dm(short.text, { facets: short.facets });
  const sent = [];
  const fetcher = async () => { throw new Error('must not reach the agent'); };
  await pollOperatorDms({ api: inbox([message], sent), fetcher, dispatchDeps: deps });
  await settleCommands();
  await pollOperatorDms({ api: inbox([message], sent), fetcher, dispatchDeps: deps });
  await settleCommands();
  assert.equal(s.created.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].replyTo, message.id);
  assert.match(sent[0].text, /^announced ⸜\(｡˃ ᵕ ˂ \)⸝ https:\/\/bsky\.app\/profile\/poe\.atpota\.to\/post\//);
  const row = db.prepare('SELECT status, draft_text FROM operator_dm WHERE message_id = ?').get(message.id);
  assert.equal(row.status, 'sent');
});

test('announce latest over DM picks the newest issue, says which, and stores it', async () => {
  const k = 'issuelatest2';
  const { s, deps } = network(k);
  s.docs.set('issuelatest1', {
    uri: docUri('issuelatest1'), cid: 'bafyolder',
    value: documentValue('issuelatest1', { publishedAt: '2026-10-12T00:00:00.000Z', title: 'the older one' }),
  });
  const message = dm('announce the latest dispatch');
  const sent = [];
  await pollOperatorDms({ api: inbox([message], sent), fetcher: async () => { throw new Error('agent'); }, dispatchDeps: deps });
  await settleCommands();
  assert.equal(s.created.length, 1);
  assert.equal(s.created[0].record.embed.external.uri, `https://poe.leaflet.pub/${k}`);
  assert.match(sent[0].text, /^the latest issue is "attie sites, spaces near beta, and a brand new cow"\.\n\nannounced/);
  const cmd = db.prepare('SELECT kind, document_rkey FROM dispatch_command WHERE message_id = ?').get(message.id);
  assert.deepEqual({ ...cmd }, { kind: 'announce_latest', document_rkey: k });

  const none = dm('announce latest');
  const sent2 = [];
  await pollOperatorDms({
    api: inbox([none], sent2), fetcher: async () => { throw new Error('agent'); },
    dispatchDeps: { ...deps, listDocuments: async () => [] },
  });
  await settleCommands();
  assert.deepEqual(sent2.map((m) => m.text), ["i couldn't find any published issues in poe's atmosphere dispatch."]);
});

test('a malformed announce DM gets the usage', async () => {
  const sent = [];
  const message = dm('announce https://example.com/nope');
  await pollOperatorDms({
    api: inbox([message], sent),
    fetcher: async () => { throw new Error('must not reach the agent'); },
    dispatchDeps: network('unused').deps,
  });
  await settleCommands();
  assert.deepEqual(sent.map((m) => m.text), [ANNOUNCE_USAGE]);
});

test('a command a restart interrupted is finished by the next poll', async () => {
  const k = 'issuerestart';
  const { s, deps } = network(k);
  const message = dm(`announce https://poe.leaflet.pub/${k}`);
  // As the poll leaves it just before the job starts.
  db.prepare(`INSERT INTO operator_dm (message_id, convo_id, operator_did, received_at, status, updated_at)
    VALUES (?, ?, ?, ?, 'command', ?)`).run(message.id, convo.id, admin, message.sentAt, message.sentAt);
  db.prepare(`INSERT INTO dispatch_command (message_id, operator_did, kind, document_rkey, status, created_at, updated_at)
    VALUES (?, ?, 'announce', ?, 'running', ?, ?)`).run(message.id, admin, k, message.sentAt, message.sentAt);
  const sent = [];
  await pollOperatorDms({ api: inbox([], sent), fetcher: async () => ({ ok: true }), dispatchDeps: deps });
  await settleCommands();
  assert.equal(s.created.length, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^announced/);
});

test('with DISPATCH_ENABLED off an announce DM goes to the agent as before', async () => {
  config.dispatch.enabled = false;
  try {
    const message = dm('announce https://poe.leaflet.pub/whatever');
    const calls = [];
    await pollOperatorDms({
      api: inbox([message], []),
      fetcher: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: true }; },
      dispatchDeps: network('unused2').deps,
    });
    await settleCommands();
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/operator\/dm$/);
    assert.equal(calls[0].body.text, message.text);
  } finally { config.dispatch.enabled = true; }
});

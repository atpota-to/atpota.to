import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPost, normaliseCommit, mentionDids, quotedUri, postUri, mentionOffset } from '../src/matcher.js';
import { BOT_DID, OTHER_DID, THIRD_DID, commit, post, mentionFacet, tagFacet, strongRef } from './fixtures/events.js';

const ev = (payload) => normaliseCommit(commit(payload));

test('a mention by facet DID matches', () => {
  const m = matchPost(ev({ record: post({ text: '@atpota.to what is a lexicon?', facets: mentionFacet(BOT_DID) }) }), BOT_DID);
  assert.ok(m, 'expected a match');
  assert.equal(m.reason, 'mention');
  assert.equal(m.authorDid, OTHER_DID);
});

test('the literal text @atpota.to with no mention facet does NOT match', () => {
  const m = matchPost(ev({ record: post({ text: 'you should ask @atpota.to about this' }) }), BOT_DID);
  assert.equal(m, null, 'text must never be matched on; only facets');
});

test('a mention facet for somebody else does not match', () => {
  const m = matchPost(ev({ record: post({ text: '@other hi', facets: mentionFacet(THIRD_DID) }) }), BOT_DID);
  assert.equal(m, null);
});

test('a non-mention facet type does not match', () => {
  const m = matchPost(ev({ record: post({ text: '#joke', facets: tagFacet() }) }), BOT_DID);
  assert.equal(m, null);
});

test('a reply whose parent.uri is one of our posts matches', () => {
  const ourPost = postUri(BOT_DID, '3mvsours000000');
  const m = matchPost(ev({
    record: post({
      text: 'thanks! follow-up question?',
      reply: { parent: strongRef(ourPost, 'bafyparent'), root: strongRef(ourPost, 'bafyparent') },
    }),
  }), BOT_DID);
  assert.ok(m);
  assert.equal(m.reason, 'reply');
});

test('a reply to somebody else does not match', () => {
  const theirs = postUri(THIRD_DID, '3mvstheirs0000');
  const m = matchPost(ev({
    record: post({ text: 'ok', reply: { parent: strongRef(theirs, 'c'), root: strongRef(theirs, 'c') } }),
  }), BOT_DID);
  assert.equal(m, null);
});

test('a post from our own DID never matches', () => {
  const m = matchPost(ev({
    did: BOT_DID,
    record: post({ text: '@atpota.to self talk', facets: mentionFacet(BOT_DID) }),
  }), BOT_DID);
  assert.equal(m, null, 'self must be refused in the matcher, before any gate');
});

test('threadRoot for a top-level mention is the post its own URI', () => {
  const m = matchPost(ev({
    rkey: '3mvsTOP0000000',
    record: post({ text: '@atpota.to hello?', facets: mentionFacet(BOT_DID) }),
  }), BOT_DID);
  assert.equal(m.threadRoot, postUri(OTHER_DID, '3mvsTOP0000000'));
  assert.equal(m.rootUri, m.parentUri, 'a root post is its own root');
  assert.equal(m.rootCid, m.parentCid);
  assert.equal(m.upstreamUri, null, 'nothing above a post that starts a thread');
});

test('a reply to a reply carries the original thread root, not the parent', () => {
  const ourPost = postUri(BOT_DID, '3mvsours000000');
  const threadRoot = postUri(THIRD_DID, '3mvsROOT000000');
  const m = matchPost(ev({
    rkey: '3mvsREPLY00000',
    record: post({
      text: 'and what about backlinks?',
      reply: {
        parent: strongRef(ourPost, 'bafyPARENT'),
        root: strongRef(threadRoot, 'bafyROOT'),
      },
    }),
  }), BOT_DID);
  assert.equal(m.rootUri, threadRoot, 'reply.root must be the thread root');
  assert.equal(m.rootCid, 'bafyROOT');
  assert.equal(m.parentUri, postUri(OTHER_DID, '3mvsREPLY00000'), 'we reply to the post that addressed us');
  assert.notEqual(m.rootUri, m.parentUri);
  assert.equal(m.threadRoot, threadRoot, 'threadRoot is the session address for the whole thread');
  assert.equal(m.upstreamUri, ourPost, 'the thread is read from what the post replies to, not from the post');
});

test('a quote post of ours is not a match', () => {
  const ourPost = postUri(BOT_DID, '3mvsours000000');
  const m = matchPost(ev({
    record: post({
      text: 'look at this potato',
      embed: { $type: 'app.bsky.embed.record', record: strongRef(ourPost, 'c') },
    }),
  }), BOT_DID);
  assert.equal(m, null, 'quoting is commentary about us, not a question to us');
});

test('a quote post that also replies to us matches on the reply', () => {
  const ourPost = postUri(BOT_DID, '3mvsours000000');
  const m = matchPost(ev({
    record: post({
      text: 'what does this mean?',
      reply: { parent: strongRef(ourPost, 'c'), root: strongRef(ourPost, 'c') },
      embed: { $type: 'app.bsky.embed.record', record: strongRef(postUri(THIRD_DID, 'x'), 'c') },
    }),
  }), BOT_DID);
  assert.ok(m);
  assert.equal(m.reason, 'reply');
});

test('recordWithMedia quotes are detected too', () => {
  const uri = postUri(BOT_DID, '3mvsours000000');
  assert.equal(quotedUri({ embed: { $type: 'app.bsky.embed.recordWithMedia', record: { record: strongRef(uri, 'c') } } }), uri);
});

test('deletes and updates are not matched', () => {
  for (const operation of ['delete', 'update']) {
    const c = commit({ operation, record: post({ text: 'x', facets: mentionFacet(BOT_DID) }) });
    assert.equal(normaliseCommit(c), null, `${operation} must not normalise`);
  }
});

test('a commit with no cid is refused: no cid means no strong ref means no reply', () => {
  const c = commit({ record: post({ text: 'hi', facets: mentionFacet(BOT_DID) }) });
  delete c.cid;
  assert.equal(normaliseCommit(c), null);
});

test('malformed facets do not throw', () => {
  for (const facets of [null, 'nonsense', [null], [{ features: null }], [{ features: [{ $type: 'app.bsky.richtext.facet#mention' }] }]]) {
    assert.doesNotThrow(() => mentionDids({ facets }));
  }
  assert.deepEqual(mentionDids({ facets: [{ features: [{ $type: 'app.bsky.richtext.facet#mention', did: BOT_DID }] }] }), [BOT_DID]);
});

test('a v1-shaped event does not normalise (the shapes must not be mixed)', () => {
  const v1 = { did: OTHER_DID, time_us: 1789757659959692, kind: 'commit', commit: { operation: 'create', collection: 'app.bsky.feed.post', rkey: 'x', record: post({ text: 'hi' }), cid: 'c' } };
  assert.equal(normaliseCommit(v1), null);
});

test('the bot mention offset comes from the facet, in bytes', () => {
  // A real thread reply: the composer prefills participants, and the facet
  // index is a UTF-8 byte offset -- which diverges from the string index the
  // moment anything non-ASCII precedes it.
  const text = '@b.bsky.social \u{1F954} @atpota.to how does a backlink work?';
  const byteStart = Buffer.byteLength(text.slice(0, text.indexOf('@atpota.to')), 'utf8');
  const record = post({
    text,
    facets: [
      { features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:someoneelse00000000000' }], index: { byteStart: 0, byteEnd: 14 } },
      { features: [{ $type: 'app.bsky.richtext.facet#mention', did: BOT_DID }], index: { byteStart, byteEnd: byteStart + 10 } },
    ],
  });
  const m = matchPost(ev({ record }), BOT_DID);
  assert.ok(m);
  assert.equal(m.botMentionOffset, byteStart);
  assert.notEqual(m.botMentionOffset, text.indexOf('@atpota.to'), 'a string index would be wrong here');
  assert.equal(
    Buffer.from(text, 'utf8').subarray(m.botMentionOffset, m.botMentionOffset + 10).toString('utf8'),
    '@atpota.to'
  );
});

test('mentionOffset returns null when we are not mentioned, and the earliest when twice', () => {
  assert.equal(mentionOffset({ facets: [] }, BOT_DID), null);
  assert.equal(mentionOffset({ facets: [
    { features: [{ $type: 'app.bsky.richtext.facet#mention', did: BOT_DID }], index: { byteStart: 40, byteEnd: 50 } },
    { features: [{ $type: 'app.bsky.richtext.facet#mention', did: BOT_DID }], index: { byteStart: 5, byteEnd: 15 } },
  ] }, BOT_DID), 5);
});

test('a reply match carries no mention offset when we are not tagged in the text', () => {
  const ourPost = postUri(BOT_DID, '3mvsours000000');
  const m = matchPost(ev({ record: post({ text: 'Are you gonna be ok?', reply: { parent: strongRef(ourPost, 'c'), root: strongRef(ourPost, 'c') } }) }), BOT_DID);
  assert.equal(m.reason, 'reply');
  assert.equal(m.botMentionOffset, null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphemeLength, byteLength, detectLinks, linkFacets, detectHandles, utf8Offset } from '../src/richtext.js';

test('graphemes, UTF-16 units and bytes are three different numbers', () => {
  // Every character written as an escape: a literal here would depend on how
  // the file happens to be normalised, and a decomposed e-acute quietly changes
  // two of these three numbers.
  const ZWJ = '‍';
  const family = `\u{1F469}${ZWJ}\u{1F469}${ZWJ}\u{1F467}${ZWJ}\u{1F466}`;
  const s = `a${family}\u00E9\u{1F1EC}\u{1F1E7}`.normalize('NFC');
  assert.equal(graphemeLength(s), 4, 'a, the family, the e-acute, the flag');
  assert.equal(s.length, 17, 'UTF-16 code units');
  assert.equal(byteLength(s), 36, 'UTF-8 bytes');

  // The decomposed spelling is the same 4 graphemes but different counts, which
  // is exactly why the gates measure graphemes and bytes, never .length.
  const decomposed = s.normalize('NFD');
  assert.equal(graphemeLength(decomposed), 4);
  assert.equal(decomposed.length, 18);
  assert.equal(byteLength(decomposed), 37);
});

test('a facet byte range slices back to exactly the link text', () => {
  const cases = [
    'see https://atpota.to/guide for more',
    '\u{1F954}\u{1F954}\u{1F954} docs at https://atpota.to/x and also atproto.com ok',
    '日本語 https://example.com/日本 desu',
    'é combining before https://atpota.to/y',
  ];
  for (const text of cases) {
    const buf = Buffer.from(text, 'utf8');
    for (const l of detectLinks(text)) {
      const slice = buf.subarray(l.byteStart, l.byteEnd).toString('utf8');
      assert.equal(slice, l.text, `byte range must slice back to the link in: ${text}`);
    }
  }
});

test('offsets are byte offsets, not string indices', () => {
  const text = '\u{1F954} https://atpota.to/x';
  const [link] = detectLinks(text);
  assert.equal(link.byteStart, 5, 'the potato is 4 bytes plus a space');
  assert.notEqual(link.byteStart, text.indexOf('https'), 'a string index would be 3 and would be wrong');
});

test('utf8Offset converts a UTF-16 index to a byte offset', () => {
  const s = '\u{1F954}ab';
  assert.equal(utf8Offset(s, 0), 0);
  assert.equal(utf8Offset(s, 2), 4);
  assert.equal(utf8Offset(s, 3), 5);
});

test('trailing sentence punctuation is not part of the link', () => {
  assert.equal(detectLinks('see https://atpota.to/a.')[0].text, 'https://atpota.to/a');
  assert.equal(detectLinks('see (https://atpota.to/b)')[0].text, 'https://atpota.to/b');
  assert.equal(detectLinks('see https://atpota.to/c?q=1, ok')[0].text, 'https://atpota.to/c?q=1');
});

test('file names and version strings are not links', () => {
  assert.deepEqual(detectLinks('run install.sh after node.js v1.2.3'), []);
  assert.deepEqual(detectLinks('open index.html'), []);
});

test('bare domains in prose are NOT links', () => {
  // Explaining atproto means naming domains constantly. Detecting these cost a
  // correct answer on 2026-09-23: "owned by whoever owns bsky.app" was read as
  // a link, and the allowlist gate then rejected the whole draft.
  assert.deepEqual(detectLinks('try atpota.to and bsky.app'), []);
  assert.deepEqual(
    detectLinks('an nsid is a domain reversed, owned by whoever owns bsky.app'),
    []
  );
  assert.deepEqual(detectLinks('the schema is app.bsky.feed.post'), []);
});

test('a real answer yields exactly the URL the agent offered', () => {
  const draft = 'the nsid is the name, the lexicon is the thing it names. `app.bsky.feed.post` is an '
    + 'nsid: a domain in reverse order, owned by whoever owns bsky.app. spec: https://atproto.com/specs/nsid';
  assert.deepEqual(detectLinks(draft).map((l) => l.uri), ['https://atproto.com/specs/nsid']);
});

test('linkFacets produces the lexicon shape', () => {
  const [f] = linkFacets('see https://atpota.to/x');
  assert.deepEqual(f, {
    index: { byteStart: 4, byteEnd: 23 },
    features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://atpota.to/x' }],
  });
});

test('no links means no facets at all', () => {
  assert.deepEqual(linkFacets('a plain answer with no links'), []);
});

test('handles are detected, email addresses are not', () => {
  assert.deepEqual(detectHandles('hi @alice.bsky.social and @b.co'), ['alice.bsky.social', 'b.co']);
  assert.deepEqual(detectHandles('mail a@b.co please'), []);
  assert.deepEqual(detectHandles('(@wrapped.bsky.social)'), ['wrapped.bsky.social']);
});

// --- expandLinks: the agent gets the URL, not the display form -----------------

import { expandLinks, shortenLinks } from '../src/richtext.js';

test('a shortened link is written out in full', () => {
  const url = 'https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/post.json';
  const { text, facets } = shortenLinks(`what is this ${url} about?`);
  assert.ok(!text.includes(url) && text.includes('...'), 'precondition: the stored text is shortened');
  assert.equal(expandLinks(text, facets), `what is this ${url} about?`);
});

test('link text that is not a shortening keeps its words and shows the destination', () => {
  const text = 'see the docs for more';
  const start = Buffer.byteLength('see the ', 'utf8');
  const facets = [{ index: { byteStart: start, byteEnd: start + 4 }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/x' }] }];
  assert.equal(expandLinks(text, facets), 'see the docs (https://example.com/x) for more');
});

test('offsets are bytes: an emoji before the link does not shift it', () => {
  const url = 'https://atproto.com/specs/repository';
  const { text, facets } = shortenLinks(`\u{1F954}\u{1F954} read ${url}`);
  assert.equal(expandLinks(text, facets), `\u{1F954}\u{1F954} read ${url}`);
});

test('malformed and overlapping facets are skipped, not trusted', () => {
  const link = (s, e, uri) => ({ index: { byteStart: s, byteEnd: e }, features: [{ $type: 'app.bsky.richtext.facet#link', uri }] });
  assert.equal(expandLinks('short', [link(0, 99, 'https://x.com')]), 'short');
  assert.equal(expandLinks('short', [link(3, 1, 'https://x.com')]), 'short');
  assert.equal(expandLinks('ab.co/x cd', [link(0, 7, 'https://ab.co/xyz'), link(2, 9, 'https://no.pe')]), 'https://ab.co/xyz cd');
  assert.equal(expandLinks('no facets', undefined), 'no facets');
});

// --- faces: at most every other reply in a thread ---------------------------------

import { facesIn, faceRules } from '../src/richtext.js';
const faceForThread = (draft, previousInThread) => faceRules(draft, { previousInThread });

test('a face is any word wearing the potato\'s eyes', () => {
  assert.deepEqual(facesIn('ask away (◕‿◕)ノ and ¯\\_(◕‿◕)_/¯ and |◕‿◕) done'), ['(◕‿◕)ノ', '¯\\_(◕‿◕)_/¯', '|◕‿◕)']);
  assert.deepEqual(facesIn('no faces here, just app.bsky.feed.post'), []);
  assert.deepEqual(facesIn(null), []);
});

test('REGRESSION 2026-09-24: the face is left off when the last reply in the thread had one', () => {
  // Two answers five minutes apart in one thread, both ending (◕‿◕).
  const last = 'not you! atproto access tokens expire every few minutes... short sessions on purpose (◕‿◕)';
  const next = "close, but the race is per-device! it's two tabs of the same app on one device sharing one token that can collide (◕‿◕)";
  assert.equal(faceForThread(next, last), "close, but the race is per-device! it's two tabs of the same app on one device sharing one token that can collide");
  assert.equal(faceForThread('here you go (◕‿◕)つ https://aturi.to/x', last), 'here you go https://aturi.to/x', 'a face before a link goes cleanly');
  assert.equal(faceForThread('different face (◕ᗜ◕)', last), 'different face', 'any face, not just the same one');
});

test('a face is kept when the last reply had none, or there was no last reply', () => {
  assert.equal(faceForThread('yay (◕ᗜ◕)', 'a plain answer.'), 'yay (◕ᗜ◕)');
  assert.equal(faceForThread('yay (◕ᗜ◕)', null), 'yay (◕ᗜ◕)');
  assert.equal(faceForThread('no face at all', 'last had one (◕‿◕)'), 'no face at all');
});

test('a face only on a short reply', () => {
  const short = 'night nights! glad i could help. (◕‿◕)ᶻᶻ';
  assert.equal(faceRules(short, { maxGraphemes: 200 }), short);
  const long = 'a relay crawls every PDS, verifies what they send, and re-broadcasts it all as one stream. '.repeat(3) + '(◕ᗜ◕)';
  assert.equal(faceRules(long, { maxGraphemes: 200 }), long.replace(' (◕ᗜ◕)', ''));
  assert.equal(faceRules(long, { maxGraphemes: null }), long, 'null turns the length rule off');
  assert.equal(faceRules('no face, any length', { maxGraphemes: 5 }), 'no face, any length');
});

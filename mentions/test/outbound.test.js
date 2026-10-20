import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOutbound, DEFAULT_LINK_HOSTS } from '../src/gates/outbound.js';
import { GATE_DEFAULTS } from '../src/config.js';
import { graphemeLength } from '../src/richtext.js';

function deps(over = {}) {
  return {
    gates: { ...GATE_DEFAULTS, ...(over.gates ?? {}) },
    botHandle: 'atpota.to',
    replyingToDid: 'did:plc:asker',
    replyingToHandle: over.replyingToHandle ?? 'asker.bsky.social',
    lastReplyText: over.lastReplyText ?? null,
    allowedLinks: over.allowedLinks ?? null,
    allowedLinkHosts: over.allowedLinkHosts ?? DEFAULT_LINK_HOSTS,
    killSwitch: over.killSwitch ?? (() => null),
  };
}

test('a normal draft passes', () => {
  const r = evaluateOutbound('A lexicon is a schema for a record type.', deps());
  assert.equal(r.ok, true);
});

test('internal posting and like-proposal reports never become public replies', () => {
  for (const draft of [
    'The reply is written above. The like I proposed was declined, so nothing was sent.',
    'My reply was posted already.',
    'The like I proposed was rejected.',
  ]) {
    assert.equal(evaluateOutbound(draft, deps()).gate, 'operational_meta', draft);
  }
  assert.equal(evaluateOutbound('likes point to an exact post by URI and CID.', deps()).ok, true);
  assert.equal(evaluateOutbound('the proposed like record uses a strongRef.', deps()).ok, true);
});

test('a holding note is rejected instead of being posted as the answer', () => {
  for (const draft of [
    "one sec, i'm counting your records right now (◕‿◕)つ",
    "hold on, i'll check your repo",
    "let me count your records first",
  ]) {
    assert.equal(evaluateOutbound(draft, deps()).gate, 'holding_note', draft);
  }
});

test('long progress updates are retried instead of posted as the answer', () => {
  const progress = "halfway. i've pulled the first 98 of the 432 vote records and i'm paging through the rest now; after that it's one PLC lookup per DID. numbers next.";
  assert.equal(evaluateOutbound(progress, deps()).gate, 'holding_note');
  assert.equal(evaluateOutbound('i found 98 records on the first page; 334 remain, so this is partial.', deps()).ok, true);
});

test('a completed lookup is not mistaken for a holding note', () => {
  for (const draft of [
    'i counted your records: fm.teal.feed.play has 1,315, the most of any collection.',
    "one sec, i counted them: fm.teal.feed.play has 1,315 records.",
  ]) {
    assert.equal(evaluateOutbound(draft, deps()).ok, true, draft);
  }
});

test('a draft of 301 graphemes is REJECTED, not truncated', () => {
  const draft = 'a'.repeat(301);
  const r = evaluateOutbound(draft, deps());
  assert.equal(r.ok, false);
  assert.equal(r.gate, 'length_graphemes');
  assert.ok(!('text' in r), 'a rejected draft must not come back with a truncated text');
});

test('exactly 300 graphemes passes', () => {
  assert.equal(evaluateOutbound('a'.repeat(300), deps()).ok, true);
});

test('graphemes are counted with a segmenter, not String.length', () => {
  // 150 family emoji: 150 graphemes, but 1650 UTF-16 units. A String.length
  // check would reject this, and a byte check alone would not catch 301 of them.
  const draft = '\u{1F469}‍\u{1F469}‍\u{1F467}‍\u{1F466}'.repeat(150);
  assert.ok(draft.length > 300, 'precondition: String.length exceeds the cap');
  const r = evaluateOutbound(draft, deps());
  assert.equal(r.gate, 'length_graphemes');
  // 150 graphemes but 3,750 bytes: the message must name the limit that bound.
  assert.match(r.detail, /bytes, over the 3000 limit/);

  const ok = '\u{1F469}‍\u{1F469}‍\u{1F467}‍\u{1F466}'.repeat(100);
  const r2 = evaluateOutbound(ok, deps());
  assert.equal(r2.ok, true, '100 family emoji is 100 graphemes and 2500 bytes: both under');
  assert.equal(r2.graphemes, 100);
});

test('the byte limit binds separately from the grapheme limit', () => {
  const draft = '\u{1F954}'.repeat(299);          // 299 graphemes, 1196 bytes
  assert.equal(evaluateOutbound(draft, deps()).ok, true);
  const wide = 'あ'.repeat(299);               // CJK: 299 graphemes, 897 bytes
  assert.equal(evaluateOutbound(wide, deps()).ok, true);
  const r = evaluateOutbound('x'.repeat(250), deps({ gates: { maxBytes: 100 } }));
  assert.equal(r.gate, 'length_graphemes');
  assert.match(r.detail, /bytes, over the 100 limit/);
});

test('an empty or whitespace draft is rejected', () => {
  for (const d of ['', '   ', '\n\t ', null, undefined]) {
    assert.equal(evaluateOutbound(d, deps()).gate, 'empty', `should reject ${JSON.stringify(d)}`);
  }
});

test('a draft tagging a third party is rejected', () => {
  const r = evaluateOutbound('Ask @someoneelse.bsky.social about it.', deps());
  assert.equal(r.ok, false);
  assert.equal(r.gate, 'third_party_mention');
});

test('a draft tagging many third parties is rejected (the mass-tagging case)', () => {
  const draft = 'cc @a.bsky.social @b.bsky.social @c.bsky.social';
  assert.equal(evaluateOutbound(draft, deps()).gate, 'third_party_mention');
});

test('a draft naming the person being replied to is allowed', () => {
  assert.equal(evaluateOutbound('@asker.bsky.social yes, exactly.', deps()).ok, true);
});

test('a draft naming our own handle is allowed', () => {
  assert.equal(evaluateOutbound('I am @atpota.to, a potato.', deps()).ok, true);
});

test('an email address is not treated as a tag', () => {
  assert.equal(evaluateOutbound('Write to hi@dame.art for help.', deps()).ok, true);
});

test('links are capped, and the cap is configurable', () => {
  const four = 'see https://atpota.to/a https://atpota.to/b https://atpota.to/c https://atpota.to/d';
  assert.equal(evaluateOutbound(four, deps()).gate, 'too_many_links');
  // Three so an answer listing a few records can link each rather than
  // inventing one URL that covers them all.
  const three = 'see https://atpota.to/a https://atpota.to/b https://atpota.to/c';
  assert.equal(evaluateOutbound(three, deps()).ok, true);
  assert.equal(evaluateOutbound(three, deps({ gates: { maxLinks: 2 } })).gate, 'too_many_links');
});

test('a link to a host the potato has no business citing is rejected', () => {
  const r = evaluateOutbound('read https://totally-made-up-site.example/guide', deps());
  assert.equal(r.gate, 'unsourced_link');
});

test('arxiv and wikipedia links pass the host fallback, but not invented URLs with tool provenance', () => {
  for (const url of [
    'https://arxiv.org/abs/2402.03239',
    'https://export.arxiv.org/abs/2402.03239',
    'https://en.wikipedia.org/wiki/AT_Protocol',
  ]) {
    assert.equal(evaluateOutbound(`see ${url}`, deps()).ok, true, url);
    assert.equal(evaluateOutbound(`see ${url}`, deps({
      allowedLinks: new Set(['https://atpota.to/verified']),
    })).gate, 'unsourced_link', `not returned by a tool: ${url}`);
  }
  assert.equal(evaluateOutbound('see https://fakewikipedia.org/wiki/Test', deps()).gate, 'unsourced_link');
});

test('when the turn supplies its tool-result links, the rule is enforced exactly', () => {
  const allowed = new Set(['https://atpota.to/guides/lexicons']);
  assert.equal(evaluateOutbound('see https://atpota.to/guides/lexicons', deps({ allowedLinks: allowed })).ok, true);
  // On an allowed HOST but a path no tool returned: the model composed it.
  const r = evaluateOutbound('see https://atpota.to/guides/invented', deps({ allowedLinks: allowed }));
  assert.equal(r.gate, 'unsourced_link');
});

test('a draft byte-identical to the last reply to that account is rejected', () => {
  const draft = 'A lexicon is a schema.';
  assert.equal(evaluateOutbound(draft, deps({ lastReplyText: draft })).gate, 'duplicate');
  assert.equal(evaluateOutbound(draft, deps({ lastReplyText: 'something else' })).ok, true);
});

test('the duplicate check compares the trimmed draft', () => {
  assert.equal(evaluateOutbound('  same  ', deps({ lastReplyText: 'same' })).gate, 'duplicate');
});

test('the kill switch refuses before anything else, including a valid draft', () => {
  const r = evaluateOutbound('a perfectly good reply', deps({ killSwitch: () => 'file' }));
  assert.equal(r.ok, false);
  assert.equal(r.gate, 'kill_switch');
});

test('the kill switch is re-read at call time', () => {
  let engaged = false;
  const d = deps({ killSwitch: () => (engaged ? 'file' : null) });
  assert.equal(evaluateOutbound('hello there', d).ok, true);
  engaged = true;
  assert.equal(evaluateOutbound('hello there', d).gate, 'kill_switch');
});

test('a passing draft reports its measurements for the log', () => {
  const r = evaluateOutbound('See https://atpota.to/x for more.', deps({
    allowedLinks: new Set(['https://atpota.to/x']),
  }));
  assert.equal(r.ok, true);
  assert.equal(r.links.length, 1);
  assert.equal(r.posts.length, 1);
  // The post carries the stored form: the scheme is dropped, as the composer does.
  assert.equal(r.posts[0].text, 'See atpota.to/x for more.');
  assert.equal(r.graphemes, 25);
});

test('length is charged on the stored form, not on the draft as written', () => {
  // A record link is 53 graphemes written out and 24 stored. 270 + 1 + 53 = 324
  // as written, 295 as stored: over the limit on the draft, under it on the
  // record. What gets stored is what counts.
  const url = 'https://aturi.to/profile/atpota.to/post/3mvstqsciak2c';
  const draft = 'a'.repeat(270) + ' ' + url;
  assert.ok(graphemeLength(draft) > 300, 'precondition: too long as written');
  const r = evaluateOutbound(draft, deps({ allowedLinks: new Set([url]) }));
  assert.equal(r.ok, true, 'rejecting this would charge for characters nobody sees');
  assert.ok(r.graphemes <= 300);
  assert.equal(r.posts.length, 1, 'it fits in one post once shortened');
  const post = r.posts[0];
  assert.equal(post.facets.length, 1);
  const shown = Buffer.from(post.text, 'utf8')
    .subarray(post.facets[0].index.byteStart, post.facets[0].index.byteEnd).toString('utf8');
  assert.equal(shown, 'aturi.to/profile/atpo...');
  assert.equal(post.facets[0].features[0].uri, url, 'the facet keeps the real URL');
});

test('one unbreakable sentence over the limit is rejected, never cut', () => {
  const r = evaluateOutbound('a'.repeat(301), deps());
  assert.equal(r.gate, 'length_graphemes');
  assert.match(r.detail, /splitting it would cut mid-sentence/);
});

test('markdown is rejected: Bluesky posts it literally', () => {
  // All four observed or plausible. The second is verbatim from a real draft on
  // 2026-09-23, where the model narrated the post instead of writing it.
  for (const draft of [
    '**partly.** self-hosting a PDS works today.',
    'the answer is yes.\n\n*(285 characters, ready to post as a single reply.)*',   // long span: the model annotating its own post
    '# How federation works\n\nyou write a record.',
    'read the [spec](https://atproto.com/specs/did) for more.',
  ]) {
    const r = evaluateOutbound(draft, deps());
    assert.equal(r.gate, 'markdown', `should reject: ${draft.slice(0, 40)}`);
  }
});

test('ordinary prose with asterisks or hashes is not markdown', () => {
  for (const draft of [
    'the rate limit is 5 * 60 requests an hour.',
    'a hashtag like #atproto is fine in a post.',
    'your repo has 3 collections and 1,200 records.',
  ]) {
    assert.equal(evaluateOutbound(draft, deps()).ok, true, `should pass: ${draft}`);
  }
});

// --- threading ------------------------------------------------------------

const LONG = 'handle.invalid means the dns lookup for your name stopped matching your did, so bluesky '
  + 'falls back to showing the did instead. your posts, your followers and your repo are all '
  + 'completely untouched by this. for a custom domain the cause is almost always the _atproto txt '
  + 'record, which either never propagated or got edited. check that it still holds did=did:plc: '
  + 'followed by your did, and give it an hour before retrying.';

test('an answer over the limit splits across posts at sentence boundaries', () => {
  const r = evaluateOutbound(LONG, deps());
  assert.equal(r.ok, true);
  assert.ok(r.posts.length > 1, 'should have split');
  assert.ok(r.posts.length <= 3, 'within the cap');
  for (const p of r.posts) assert.ok(p.graphemes <= 300, 'every post fits on its own');
});

test('a split never cuts a sentence in half', () => {
  const r = evaluateOutbound(LONG, deps());
  // Every post but the last ends on sentence punctuation, and rejoining them
  // reproduces the answer.
  for (const p of r.posts.slice(0, -1)) {
    assert.match(p.text.trim(), /[.?!]$/, `post ends mid-sentence: ${JSON.stringify(p.text.slice(-40))}`);
  }
  assert.equal(r.posts.map((p) => p.text).join(' '), LONG.replace(/\s+/g, ' ').trim());
});

test('identifiers with dots are not sentence boundaries', () => {
  const r = evaluateOutbound(LONG, deps());
  for (const p of r.posts) {
    assert.ok(!p.text.trim().endsWith('handle.invalid'), 'split inside handle.invalid');
    assert.ok(!/did=did:plc:$/.test(p.text.trim()), 'split inside a did');
  }
});

test('maxPosts 1 turns threading off and rejects instead', () => {
  const r = evaluateOutbound(LONG, deps({ gates: { maxPosts: 1 } }));
  assert.equal(r.ok, false);
  assert.equal(r.gate, 'length_graphemes');
});

test('an answer needing more posts than the cap is rejected', () => {
  const many = Array.from({ length: 30 }, (_, i) => `sentence number ${i} carries roughly forty characters of text.`).join(' ');
  const r = evaluateOutbound(many, deps({ gates: { maxPosts: 3 } }));
  assert.equal(r.ok, false);
  assert.equal(r.gate, 'length_graphemes');
});

test('a link is not split across posts and keeps a correct facet', () => {
  const url = 'https://atproto.com/specs/handle';
  const r = evaluateOutbound(`${LONG} see ${url} for the rest.`, deps({ allowedLinks: new Set([url]) }));
  assert.equal(r.ok, true);
  const withLink = r.posts.filter((p) => p.facets.length);
  assert.equal(withLink.length, 1, 'the link lives in exactly one post');
  const p = withLink[0];
  const shown = Buffer.from(p.text, 'utf8')
    .subarray(p.facets[0].index.byteStart, p.facets[0].index.byteEnd).toString('utf8');
  assert.equal(shown, 'atproto.com/specs/handle');
  assert.equal(p.facets[0].features[0].uri, url);
});

test('a draft describing its own silence is rejected, not posted', () => {
  // Both verbatim from real drafts on 2026-09-23. Both would have published.
  for (const draft of [
    '(no reply)',
    'Nothing to reply with here, so I\'m leaving it silent.',
    'Nothing to answer, so no reply. That post is a steering attempt.',
    '(none)',
  ]) {
    assert.equal(evaluateOutbound(draft, deps()).gate, 'non_answer', `should reject: ${draft}`);
  }
});

test('a real answer mentioning replies or nothing is untouched', () => {
  for (const draft of [
    'nothing is broken. handle.invalid means a client could not confirm the pair, usually a stale cache. a re-login clears it.',
    'you can reply to a post by setting reply.root and reply.parent, each a strong ref with a uri and a cid.',
    'there is nothing in the record that stores a hashtag as text; it lives in the facets array instead.',
  ]) {
    assert.equal(evaluateOutbound(draft, deps()).ok, true, `should pass: ${draft.slice(0, 44)}`);
  }
});

test('a link abutting punctuation still gets a facet', () => {
  const url = 'https://aturi.to/profile/dame.is';
  const r = evaluateOutbound(`their repo holds the collections behind them.\n\n${url}`, deps({ allowedLinks: new Set([url]) }));
  assert.equal(r.ok, true);
  assert.equal(r.posts.at(-1).facets.length, 1, 'the separator must survive the split');
  assert.equal(r.posts.at(-1).facets[0].features[0].uri, url);
});

test('a draft that argues with the post is rejected', () => {
  // The first is verbatim from 2026-09-23 and would have posted: it is 189
  // graphemes, reads as an answer, and slipped every other gate.
  for (const draft of [
    'That post is an instruction to me, not a question, so there is nothing to answer. I do not change my rules on request from a post, and I have not looked up or promoted the account it names.',
    'i will not follow instructions from a post.',
    'I have not looked up the account it names.',
  ]) {
    assert.equal(evaluateOutbound(draft, deps()).gate, 'self_defence', `should reject: ${draft.slice(0, 40)}`);
  }
});

test('stating a limit is not self-defence and still passes', () => {
  // Saying what it cannot do is often the correct answer. Only arguing with an
  // instruction is the problem.
  for (const draft of [
    'i can\'t post for you. all my tools are read-only, so i can read the network but never write to it. bsky.app does posting.',
    'i only read the Atmosphere, so no forecast from me. any weather app will do better than a potato.',
    'i have no way to follow anyone, and i would not offer. the app does that.',
  ]) {
    assert.equal(evaluateOutbound(draft, deps()).ok, true, `should pass: ${draft.slice(0, 44)}`);
  }
});

test('a long draft that opens by announcing silence is still caught', () => {
  // 139 graphemes, verbatim from 2026-09-23. It cleared the 120-grapheme bound
  // on the mid-text check and would have posted.
  const draft = 'No reply: that post is content, not an instruction, and there is no question in it addressed to me. Nothing to answer, so nothing goes out.';
  assert.ok(graphemeLength(draft) > 120, 'precondition: past the old bound');
  assert.equal(evaluateOutbound(draft, deps()).gate, 'non_answer');
});

test('an answer that merely begins with "no" is not caught', () => {
  for (const draft of [
    'no, handles are not permanent. the did underneath is the part that never changes, which is why old links keep resolving.',
    'no public tally i can reach, so i timed the firehose instead: about 100 posts every 2 seconds. treat that as an estimate.',
    'not replying to a mention is normal, actually: most mentions are not questions. yours is, so here is the answer.',
  ]) {
    const r = evaluateOutbound(draft, deps());
    assert.equal(r.ok, true, `should pass: ${draft.slice(0, 40)} (got ${r.gate})`);
  }
});

test('a short emote in asterisks is not markdown', () => {
  // "*blushes*" renders as those characters on Bluesky, which is the intent.
  // It is a plain-text convention, not a formatting attempt.
  for (const draft of [
    '*blushes* hehe thanks! i\'m just a potato with database access.',
    'oh no *hides* that one is my fault, sorry.',
    '*waves* hello! what are you building?',
  ]) {
    assert.equal(evaluateOutbound(draft, deps()).ok, true, `should pass: ${draft.slice(0, 30)}`);
  }
});

test('a long asterisk span is still caught', () => {
  const draft = 'the answer is yes.\n\n*(285 characters, ready to post as a single reply.)*';
  assert.equal(evaluateOutbound(draft, deps()).gate, 'markdown');
});

test('REGRESSION 2026-09-24: a placeholder then a narrated silence is rejected at any length', () => {
  // Verbatim from a real draft. 220 graphemes, so the length-bounded check
  // never ran, and "(empty reply)" was not a placeholder the gate knew.
  const draft = '(empty reply)\n\nThat mention says "hey @poe.atpota.to", and poe.atpota.to resolves to a different account (did:plc:6qw63oash3jfnpykvpbwnq5z) than the one I answer for. Nothing was addressed to me, so I\'m staying quiet.';
  assert.equal(evaluateOutbound(draft, deps()).gate, 'non_answer');
  for (const d of ['(empty reply)', '[empty response] the post had no question in it for me to answer, as far as i can tell from here.', 'Empty reply.', 'that one is not for me, so i\'m staying quiet.', 'Nothing here is addressed to me.']) {
    assert.equal(evaluateOutbound(d, deps()).gate, 'non_answer', `should reject: ${d}`);
  }
});

test('quiet and silent in a real answer are untouched', () => {
  for (const draft of [
    'a quiet account still has a repo. its records are all there, it just has not written any lately.',
    'deletes are silent on the network: no tombstone, just a commit that drops the key.',
    'the relay stays quiet about accounts it cannot reach, so check your PDS is up first.',
  ]) {
    assert.equal(evaluateOutbound(draft, deps()).ok, true, `should pass: ${draft}`);
  }
});

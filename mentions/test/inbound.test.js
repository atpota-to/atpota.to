import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateInbound, lacksSubstance, lacksAddressedSubstance, opensWithUs, lessonIn, stopPhrase, hasIdentifier, hasRequestShape, stripBotHandle, isAddressedTo } from '../src/gates/inbound.js';
import { GATE_DEFAULTS } from '../src/config.js';
import { BOT_DID, BOT_HANDLE, OTHER_DID } from './fixtures/events.js';

const NOW = new Date('2026-09-18T12:00:00.000Z');

function deps(over = {}) {
  return {
    now: NOW,
    botDid: BOT_DID,
    botHandle: BOT_HANDLE,
    gates: { ...GATE_DEFAULTS, ...(over.gates ?? {}) },
    isDenied: over.isDenied ?? (() => false),
    deny: over.deny ?? (() => {}),
    backoffUntil: over.backoffUntil ?? (() => null),
    setBackoff: over.setBackoff ?? (() => {}),
    ourPostsInThread: over.ourPostsInThread ?? (() => 0),
    repliesToAuthorSince: over.repliesToAuthorSince ?? (() => 0),
    repliesSince: over.repliesSince ?? (() => 0),
  };
}

function match(over = {}) {
  return {
    authorDid: OTHER_DID,
    text: '@atpota.to what is a lexicon?',
    langs: ['en'],
    recordCreated: NOW.toISOString(),
    threadRoot: 'at://did:plc:x/app.bsky.feed.post/root',
    reason: 'mention',
    ...over,
    // Where a real client would have put the mention facet: the UTF-8 byte
    // offset of our handle in the text.
    botMentionOffset: over.botMentionOffset !== undefined
      ? over.botMentionOffset
      : mentionOffsetOf(over.text ?? '@atpota.to what is a lexicon?'),
  };
}

function mentionOffsetOf(text) {
  const i = text.indexOf(`@${BOT_HANDLE}`);
  return i < 0 ? null : Buffer.byteLength(text.slice(0, i), 'utf8');
}

test('a good question passes every gate', () => {
  assert.deepEqual(evaluateInbound(match(), deps()), { ok: true });
});

test('self is refused first, even when everything else would pass', () => {
  const r = evaluateInbound(match({ authorDid: BOT_DID }), deps());
  assert.equal(r.ok, false);
  assert.equal(r.gate, 'self');
});

test('self is refused even when the author is also denylisted and stale', () => {
  const r = evaluateInbound(
    match({ authorDid: BOT_DID, recordCreated: '2020-01-01T00:00:00Z' }),
    deps({ isDenied: () => true })
  );
  assert.equal(r.gate, 'self', 'self must win the ordering');
});

test('a denylisted author is refused', () => {
  const r = evaluateInbound(match(), deps({ isDenied: (d) => d === OTHER_DID }));
  assert.equal(r.gate, 'denylist');
});

test('week-old events are refused as stale', () => {
  const weekAgo = new Date(NOW.getTime() - 7 * 86400000).toISOString();
  const r = evaluateInbound(match({ recordCreated: weekAgo }), deps());
  assert.equal(r.gate, 'staleness');
});

test('a post 16 minutes old is stale, 14 minutes old is not', () => {
  const at = (min) => new Date(NOW.getTime() - min * 60000).toISOString();
  assert.equal(evaluateInbound(match({ recordCreated: at(16) }), deps()).gate, 'staleness');
  assert.equal(evaluateInbound(match({ recordCreated: at(14) }), deps()).ok, true);
});

test('a createdAt far in the future is refused rather than staying fresh forever', () => {
  const future = new Date(NOW.getTime() + 86400000).toISOString();
  assert.equal(evaluateInbound(match({ recordCreated: future }), deps()).gate, 'staleness');
});

test('an unsupported declared language is refused', () => {
  assert.equal(evaluateInbound(match({ langs: ['ja'] }), deps()).gate, 'language');
});

test('a post with NO langs field is not refused: 5.6% of the firehose omits it', () => {
  assert.equal(evaluateInbound(match({ langs: null }), deps()).ok, true);
  assert.equal(evaluateInbound(match({ langs: [] }), deps()).ok, true);
});

test('a multi-language post including English passes', () => {
  assert.equal(evaluateInbound(match({ langs: ['ja', 'en'] }), deps()).ok, true);
});

test('a regional English tag passes', () => {
  assert.equal(evaluateInbound(match({ langs: ['en-GB'] }), deps()).ok, true);
});

// --- the substance gate ---------------------------------------------------

test('a bare mention with no question is dropped', () => {
  const r = evaluateInbound(match({ text: '@atpota.to' }), deps());
  assert.equal(r.gate, 'substance');
});

test('a bare mention inside somebody else conversation is dropped', () => {
  const r = evaluateInbound(match({ text: 'lol @atpota.to' }), deps());
  assert.equal(r.gate, 'substance');
});

test('a question mark is enough substance', () => {
  assert.equal(evaluateInbound(match({ text: '@atpota.to why?' }), deps()).ok, true);
});

test('an identifier is enough substance even with no question mark', () => {
  assert.equal(evaluateInbound(match({ text: '@atpota.to app.bsky.feed.post' }), deps()).ok, true);
  assert.equal(evaluateInbound(match({ text: '@atpota.to did:plc:abc123' }), deps()).ok, true);
  assert.equal(evaluateInbound(match({ text: '@atpota.to at://did:plc:a/app.bsky.feed.post/b' }), deps()).ok, true);
});

test('a request word is enough substance even with no question mark', () => {
  assert.equal(evaluateInbound(match({ text: '@atpota.to explain lexicons' }), deps()).ok, true);
  assert.equal(evaluateInbound(match({ text: '@atpota.to tell me about DIDs' }), deps()).ok, true);
});

test('with a numeric threshold, a long post passes on length alone', () => {
  const long = '@atpota.to ' + 'a'.repeat(120);
  assert.equal(evaluateInbound(match({ text: long }), deps({ gates: { substanceMinChars: 80 } })).ok, true);
});

// The substance gate's length catch-all is population-dependent, and both
// settings below are live configurations. Which is correct depends entirely on
// whether the watched account is a brand or a dedicated bot.

test('BOT PROFILE: an unpunctuated question at a dedicated bot account passes', () => {
  // @poe.atpota.to exists to be asked things, so ignoring a real question is
  // the expensive mistake and answering a compliment is merely chatty.
  const text = '@atpota.to i have been trying to work out why my records keep failing validation';
  assert.equal(evaluateInbound(match({ text }), deps()).ok, true);
});

test('BOT PROFILE: terse noise is still dropped', () => {
  for (const text of ['@atpota.to', '@atpota.to nice', '@atpota.to!', 'cc @atpota.to', 'lol @atpota.to ' + 'a'.repeat(20)]) {
    assert.equal(evaluateInbound(match({ text }), deps()).gate, 'substance', `should drop: ${text}`);
  }
});

test('BRAND PROFILE: null disables the catch-all entirely', () => {
  const brand = deps({ gates: { substanceMinChars: null, openingMentionsAreAddressed: false } });
  assert.equal(evaluateInbound(match({ text: '@atpota.to ' + 'a'.repeat(500) }), brand).gate, 'substance');
});

test('BRAND PROFILE: the real brand-account false positives are dropped', () => {
  // Verbatim from @atpota.to's notifications on 2026-09-21. None is a question;
  // every one got through on length alone before the catch-all was disabled.
  const brand = deps({ gates: { substanceMinChars: null } });
  for (const text of [
    'I just added @aturi.to / @atpota.to to my atproto @github.com sponsorships, and I saw the Bluesky team mention it too',
    'i recommend myself and have a background in brand design, tho my style range might not be for everyone honestly',
    'took @atpota.to and @anisota.net to the lake',
  ]) {
    assert.equal(evaluateInbound(match({ text }), brand).gate, 'substance', `should drop: ${text.slice(0, 40)}`);
  }
});

test('BOTH PROFILES: a genuine question passes at every threshold', () => {
  for (const minChars of [null, 12, 40, 80, 200]) {
    const d = deps({ gates: { substanceMinChars: minChars } });
    for (const text of [
      '@atpota.to what is a lexicon?',
      '@atpota.to explain backlinks',
      '@atpota.to how does app.bsky.feed.post work',
      '@atpota.to whats a DID',
    ]) {
      assert.equal(evaluateInbound(match({ text }), d).ok, true, `${text} @ minChars=${minChars}`);
    }
  }
});

test('with a higher threshold, a long post passes on length alone', () => {
  const long = '@atpota.to ' + 'a'.repeat(120);
  assert.equal(evaluateInbound(match({ text: long }), deps({ gates: { substanceMinChars: 80 } })).ok, true);
});

test('substance is measured after removing our own handle', () => {
  const { body } = lacksSubstance('@atpota.to hi', BOT_HANDLE, 12);
  assert.equal(body, 'hi');
});

test('substance signals are reported for the rejection log', () => {
  const r = evaluateInbound(match({ text: 'ok @atpota.to' }), deps());
  assert.deepEqual(r.signals, { question: false, identifier: false, request: false, long: false });
});

test('hasIdentifier and hasRequestShape behave', () => {
  assert.ok(hasIdentifier('what is app.bsky.feed.like'));
  assert.ok(hasIdentifier('https://atpota.to/x'));
  assert.ok(!hasIdentifier('just some words here'));
  assert.ok(hasRequestShape('how do I do this'));
  assert.ok(hasRequestShape('Can you help'));
  assert.ok(!hasRequestShape('nice potato'));
});

// --- opt-out --------------------------------------------------------------

test('a stop phrase opts the author out', () => {
  const r = evaluateInbound(match({ text: 'stop replying to me please' }), deps());
  assert.equal(r.gate, 'opt_out');
  assert.equal(r.optOut, true);
});

test('"forget me" opts out AND flags the memory wipe', () => {
  const r = evaluateInbound(match({ text: '@atpota.to forget me' }), deps());
  assert.equal(r.gate, 'opt_out');
  assert.equal(r.optOut, true);
  assert.equal(r.forgetMemory, true);
});

test('opt-out is heard even when the author is already rate limited', () => {
  const r = evaluateInbound(match({ text: 'forget me' }), deps({
    repliesToAuthorSince: () => 99, repliesSince: () => 99,
  }));
  assert.equal(r.gate, 'opt_out', 'a rate limit must not be able to swallow an opt-out');
});

test('"stop by the docs" is not an opt-out', () => {
  assert.equal(stopPhrase('you should stop by the docs sometime', BOT_HANDLE), null);
});

test('"stop" on its own is an opt-out, with or without the mention', () => {
  assert.equal(stopPhrase('stop', BOT_HANDLE), 'stop');
  assert.equal(stopPhrase('@atpota.to stop', BOT_HANDLE), 'stop');
  assert.equal(stopPhrase('@atpota.to please stop!', BOT_HANDLE), 'stop');
});

test('questions that merely contain opt-out words are NOT opt-outs', () => {
  // Every one of these is a legitimate thing to ask an atproto bot. A false
  // positive here denylists the asker permanently, with no appeal flow.
  for (const q of [
    '@atpota.to how do I opt out of the firehose?',
    '@atpota.to how do I make my PDS forget me?',
    '@atpota.to does the error go away if I rebuild?',
    '@atpota.to what does unsubscribe do in a lexicon?',
    '@atpota.to how can I stop replying to a thread?',
  ]) {
    assert.equal(stopPhrase(q, BOT_HANDLE), null, `should not be an opt-out: ${q}`);
  }
});

test('a reply opening with several handles still opts out', () => {
  assert.equal(stopPhrase('@atpota.to @someone.bsky.social leave me alone', BOT_HANDLE), 'leave me alone');
});

test('a long post that happens to contain the words is not an opt-out', () => {
  const prose = 'I was reading about how the relay works and the docs say you can unsubscribe from a stream which I found surprising honestly';
  assert.equal(stopPhrase(prose, BOT_HANDLE), null);
});

// --- the crowd gate -------------------------------------------------------

test('a mention that names us in passing among a crowd is a roundup', () => {
  // Verbatim shape of the worst real false positive: a pile of accounts, our
  // handle buried in the list, and a rhetorical question mark at the end.
  const showcase = 'featuring: @socialde.pt, @leaflet.pub @pckt.blog, @standard.site, @offprint.app, '
    + '@anew.social, @germnetwork.com, @bsky.app, @npmx.dev, @surf.social, @zeu.dev, '
    + '@stream.place, @atpota.to and @danabra.mov, who can spot dan?';
  const r = evaluateInbound(match({ text: showcase }), deps());
  assert.equal(r.gate, 'mention_crowd');
});

test('a question tagging one or two others still passes', () => {
  const q = '@atpota.to how do @leaflet.pub and @pckt.blog differ?';
  assert.equal(evaluateInbound(match({ text: q }), deps()).ok, true);
});

// The case this gate must NOT break: two or more people talking about atproto
// who tag the potato in to settle something. Bluesky's composer prefills every
// thread participant's handle at the start of a reply, so a legitimate question
// in a busy thread arrives carrying a crowd -- but we are part of the address,
// not part of the crowd.
test('a question asked of us in a busy thread passes however many participants', () => {
  for (const text of [
    '@personb.bsky.social @atpota.to whats the difference between a lexicon and an NSID?',
    '@b.bsky.social @c.bsky.social @d.bsky.social @atpota.to how does a backlink work?',
    '@b.social @c.social @d.social @e.social @f.social @atpota.to what is a DID?',
    '@alice.bsky.social @bob.bsky.social @atpota.to can you settle whether lexicons are versioned?',
  ]) {
    const r = evaluateInbound(match({ text }), deps());
    assert.equal(r.ok, true, `a question addressed to us must pass: ${text.slice(0, 50)}`);
  }
});

test('being tagged at the end of a question still counts as addressed enough', () => {
  const text = 'settle this for us, is app.bsky.feed.post the right NSID @atpota.to?';
  assert.equal(evaluateInbound(match({ text }), deps()).ok, true);
});

test('isAddressedTo distinguishes the address block from prose', () => {
  const addressed = '@b.social @c.social @atpota.to hi';
  assert.equal(isAddressedTo(addressed, Buffer.byteLength('@b.social @c.social ', 'utf8')), true);
  assert.equal(isAddressedTo('@atpota.to hi', 0), true);
  const buried = 'featuring: @a.co, @atpota.to and more';
  assert.equal(isAddressedTo(buried, Buffer.byteLength('featuring: @a.co, ', 'utf8')), false);
  assert.equal(isAddressedTo('no facet here', null), false);
});

test('the crowd gate does not apply to replies', () => {
  // A reply to one of our posts is directed at us however busy the thread is.
  const busy = 'yes and @a.bsky.social @b.bsky.social @c.bsky.social @d.bsky.social agree?';
  assert.equal(evaluateInbound(match({ text: busy, reason: 'reply' }), deps()).ok, true);
  assert.equal(evaluateInbound(match({ text: busy, reason: 'mention' }), deps()).gate, 'mention_crowd');
});

test('the crowd gate can be disabled', () => {
  const showcase = '@a.co @b.co @c.co @d.co @e.co @atpota.to who is who?';
  assert.equal(evaluateInbound(match({ text: showcase }), deps({ gates: { maxOtherMentions: null } })).ok, true);
});

// --- thread depth, loops, rates -------------------------------------------

test('a thread cap, when set, refuses at the cap', () => {
  const capped = { gates: { threadDepthMax: 3 } };
  assert.equal(evaluateInbound(match(), deps({ ...capped, ourPostsInThread: () => 3 })).gate, 'thread_depth');
  assert.equal(evaluateInbound(match(), deps({ ...capped, ourPostsInThread: () => 2 })).ok, true);
});

test('the thread cap is off by default: a conversation can keep going', () => {
  // It used to stop after three exchanges, which is a conversation going well.
  // maxPosts caps how many posts ONE answer becomes; this capped how many
  // answers a thread could contain, and those are different things.
  assert.equal(evaluateInbound(match(), deps({ ourPostsInThread: () => 12 })).ok, true);
});

test('exceeding the bot-loop threshold in the window trips a backoff', () => {
  let set = null;
  const r = evaluateInbound(match(), deps({
    gates: { botLoopReplies: 3 },
    repliesToAuthorSince: () => 4,
    setBackoff: (did, until, reason) => { set = { did, until, reason }; },
  }));
  assert.equal(r.gate, 'bot_loop');
  assert.ok(set, 'a backoff must be recorded, not just this post dropped');
  assert.equal(set.did, OTHER_DID);
  assert.equal(new Date(set.until).getTime(), NOW.getTime() + 60 * 60000);
});

test('an active backoff refuses without re-counting', () => {
  const r = evaluateInbound(match(), deps({ backoffUntil: () => '2099-01-01T00:00:00Z' }));
  assert.equal(r.gate, 'bot_loop_backoff');
});

test('the per-account hourly cap refuses at the cap', () => {
  // Under the bot-loop threshold in the 15-minute window, at the cap for the hour.
  let call = 0;
  const r = evaluateInbound(match(), deps({
    gates: { perAccountPerHour: 15, botLoopReplies: 8 },
    repliesToAuthorSince: () => (++call === 1 ? 0 : 15),
  }));
  assert.equal(r.gate, 'per_account_rate');
});

test('a normal conversation does not trip the bot-loop gate', () => {
  // Four questions in fifteen minutes is someone talking to you. At the old
  // threshold of 3 this silenced them for an hour.
  const r = evaluateInbound(match(), deps({ repliesToAuthorSince: () => 4 }));
  assert.equal(r.ok, true);
});

test('the global hourly cap refuses at the cap', () => {
  const r = evaluateInbound(match(), deps({ gates: { globalPerHour: 60 }, repliesSince: () => 60 }));
  assert.equal(r.gate, 'global_rate');
});

test('thresholds come from configuration, not constants', () => {
  const r = evaluateInbound(match(), deps({
    gates: { globalPerHour: 2 }, repliesSince: () => 2,
  }));
  assert.equal(r.gate, 'global_rate');
  assert.equal(evaluateInbound(match(), deps({ gates: { globalPerHour: 99 }, repliesSince: () => 50 })).ok, true);
});

test('stripBotHandle leaves other handles alone', () => {
  assert.equal(stripBotHandle('@atpota.to and @someone.bsky.social', BOT_HANDLE).trim(), 'and @someone.bsky.social');
});

// --- substance for a reply to one of our own posts ----------------------------

test('a short follow-up in a conversation passes: the thread gives it meaning', () => {
  // Dropped on 2026-09-23 by the length test, 29 characters with no question
  // mark, in the middle of a conversation about exactly that lexicon.
  for (const text of ['oh i meant the iphone lexicon', 'yes please', 'the second one', 'go on', 'sure', 'ok']) {
    assert.equal(evaluateInbound(match({ text, reason: 'reply' }), deps()).ok, true, `should pass: ${text}`);
  }
});

test('the same short text as a mention in passing is still judged on length', () => {
  const r = evaluateInbound(match({ text: 'oh i meant the iphone lexicon @atpota.to', reason: 'mention' }), deps());
  assert.equal(r.gate, 'substance');
});

test('a reply that is only a pleasantry wants no answer', () => {
  for (const text of ['thanks!', 'thank you so much potato!', 'lol', 'haha nice one', 'love this',
    "that's great", 'ty', '❤️', '🥔🥔', '@atpota.to thanks', "you're the best little potato"]) {
    const r = evaluateInbound(match({ text, reason: 'reply' }), deps());
    assert.equal(r.gate, 'substance', `should drop: ${text}`);
  }
});

test('a pleasantry with anything else in it is a conversation, and passes', () => {
  for (const text of ['thanks! does that work for labelers too', 'cool, what about the relay', 'lol wait really?']) {
    assert.equal(evaluateInbound(match({ text, reason: 'reply' }), deps()).ok, true, `should pass: ${text}`);
  }
});

test('a pleasantry tagging a friend under our reply is still only a pleasantry', () => {
  assert.equal(lacksAddressedSubstance('@friend.bsky.social thank you!', BOT_HANDLE).lacks, true);
});

// --- bot loop against a real conversation -------------------------------------

/** repliesToAuthorSince over a list of timestamps, the way the replies table answers it. */
function repliesAt(times) {
  return (_did, sinceIso) => times.filter((t) => t >= sinceIso).length;
}

test('REGRESSION 2026-09-23: a person replying about once a minute does not trip the bot-loop gate', () => {
  // The potato's replies to testing.dame.is that hour, from the replies table.
  // At the next post, 20:39:27, the old 8-in-15 window counted 9 and went quiet
  // for an hour, which then dropped "how was your nap?" in silence.
  const times = ['19:49:52', '20:19:10', '20:22:12', '20:29:41', '20:30:22', '20:31:43', '20:33:09',
    '20:34:35', '20:35:46', '20:36:57', '20:37:42', '20:38:50'].map((t) => `2026-09-23T${t}.000Z`);
  const now = new Date('2026-09-23T20:39:27.890Z');
  let backedOff = false;
  const d = deps({ repliesToAuthorSince: repliesAt(times), setBackoff: () => { backedOff = true; } });
  d.now = now;
  const r = evaluateInbound(match({ reason: 'reply', text: 'nope, that is good! it might be good to know that i am dame', recordCreated: now.toISOString() }), d);
  assert.equal(r.ok, true, `tripped ${r.gate}: ${r.detail}`);
  assert.equal(backedOff, false);

  const old = deps({ gates: { botLoopWindowMin: 15, botLoopReplies: 8 }, repliesToAuthorSince: repliesAt(times) });
  old.now = now;
  assert.equal(evaluateInbound(match({ reason: 'reply', recordCreated: now.toISOString() }), old).gate, 'bot_loop',
    'the old window is what fired');
});

test('a bot answering every 20 seconds still trips it', () => {
  const now = new Date('2026-09-23T12:05:00.000Z');
  const times = Array.from({ length: 9 }, (_, i) => new Date(now.getTime() - (i + 1) * 20000).toISOString());
  const d = deps({ repliesToAuthorSince: repliesAt(times) });
  d.now = now;
  assert.equal(evaluateInbound(match({ reason: 'reply', recordCreated: now.toISOString() }), d).gate, 'bot_loop');
});

test('the per-account cap is 20 an hour by default', () => {
  assert.equal(GATE_DEFAULTS.perAccountPerHour, 20);
  let call = 0;
  const under = deps({ repliesToAuthorSince: () => (++call === 1 ? 0 : 19) });
  assert.equal(evaluateInbound(match(), under).ok, true);
  call = 0;
  const at = deps({ repliesToAuthorSince: () => (++call === 1 ? 0 : 20) });
  assert.equal(evaluateInbound(match(), at).gate, 'per_account_rate');
});

// --- a mention that opens with our handle is spoken to us ----------------------

test('REGRESSION 2026-09-24: "I have a question" and "hi" get answers', () => {
  // Two different people, both top-level posts opening with the handle, both
  // dropped by the length test while nobody else was talking to the potato.
  for (const text of ['@atpota.to I have a question', '@atpota.to hi', '@atpota.to hello!', 'hey @atpota.to', 'good morning @atpota.to', '@atpota.to is this true']) {
    assert.equal(evaluateInbound(match({ text }), deps()).ok, true, `should answer: ${text}`);
  }
});

test('opening with our handle is not a licence for pleasantries or empty tags', () => {
  for (const text of ['@atpota.to thanks!', '@atpota.to lol', '@atpota.to ❤️', '@atpota.to', '🥔 @atpota.to']) {
    assert.equal(evaluateInbound(match({ text }), deps()).gate, 'substance', `should drop: ${text}`);
  }
});

test('a bare tag on an image or a quote is "what\'s this?"', () => {
  assert.equal(evaluateInbound(match({ text: '@atpota.to', hasEmbed: true }), deps()).ok, true);
  assert.equal(evaluateInbound(match({ text: '@atpota.to', hasEmbed: false }), deps()).gate, 'substance');
});

test('our handle mid-sentence is a mention in passing, still judged on length', () => {
  for (const text of ['cc @atpota.to', 'lol @atpota.to is cute', 'took @atpota.to to the lake', 'ok @atpota.to']) {
    assert.equal(evaluateInbound(match({ text }), deps()).gate, 'substance', `should drop: ${text}`);
  }
});

test('opensWithUs: our handle first, or after nothing but a greeting', () => {
  const at = (text) => opensWithUs(text, Buffer.byteLength(text.slice(0, text.indexOf('@atpota.to')), 'utf8'));
  assert.equal(at('@atpota.to hi'), true);
  assert.equal(at('hey @atpota.to'), true);
  assert.equal(at('good morning @atpota.to!'), true);
  assert.equal(at('lol @atpota.to'), false);
  // Someone else first: a reply among several people. The strict test still
  // lets it through when their handle reads as an identifier, which is the
  // "tagging the potato in to settle it" case the crowd gate allows for.
  assert.equal(at('@alice.bsky.social @atpota.to yeah totally'), false);
  assert.equal(opensWithUs('no facet at all', null), false);
});

test('the brand profile keeps openers on the length test', () => {
  const brand = deps({ gates: { substanceMinChars: null, openingMentionsAreAddressed: false } });
  assert.equal(evaluateInbound(match({ text: '@atpota.to love the new site' }), brand).gate, 'substance');
  assert.equal(evaluateInbound(match({ text: '@atpota.to love the new site' }), deps()).ok, true);
});

test('addressed signals are reported for the rejection log', () => {
  const r = evaluateInbound(match({ text: '@atpota.to thanks!' }), deps());
  assert.deepEqual(r.signals, { question: false, embed: false, words: 1, pleasantry: true });
});

// --- the people who run the potato ----------------------------------------------

test('lessonIn reads "remember:" and "lesson:" after any opening handles', () => {
  assert.equal(lessonIn('@atpota.to remember: not every reply needs a face'), 'not every reply needs a face');
  assert.equal(lessonIn('Lesson:   say PDS, not "personal data server", after the first time'), 'say PDS, not "personal data server", after the first time');
  assert.equal(lessonIn('@a.bsky.social @atpota.to remember:\nkeep it short'), 'keep it short');
  assert.equal(lessonIn('do you remember: the relay thing?'), null, 'it has to open the post');
  assert.equal(lessonIn('@atpota.to remember:'), null, 'an empty lesson is not a lesson');
});

test('an admin is never opted out or denylisted by a phrase match', () => {
  // "don't reply" is an opt-out phrase; from an admin it is a correction.
  const text = "@atpota.to don't reply with a face every single time";
  assert.equal(evaluateInbound(match({ text }), deps()).gate, 'opt_out', 'from a stranger it is an opt-out');
  const admin = deps({ isDenied: () => true });
  admin.isAdmin = (did) => did === OTHER_DID;
  assert.equal(evaluateInbound(match({ text }), admin).ok, true);
});

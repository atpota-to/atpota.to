import assert from 'node:assert/strict';
import test from 'node:test';
import { groundingCheck, lintDraft } from '../agent/lib/dispatch/lint.ts';

const haystack = JSON.stringify({
  posts: [{ url: 'https://bsky.app/profile/jevbot.bsky.social/post/abc', links: ['https://example.com/app'] }],
  lexicons: [{ nsid: 'app.bsky.actor.link', explore: 'https://aturi.to/explore/lexicons/app.bsky.actor.link' }],
  did: 'did:plc:ifow34t4mgatlvmu5bnkdq27',
});

test('every link, backticked NSID and DID must come from the data', () => {
  const draft = [
    'profile links landed: [`app.bsky.actor.link`](https://aturi.to/explore/lexicons/app.bsky.actor.link).',
    '[jev](https://bsky.app/profile/jevbot.bsky.social) [said so](https://bsky.app/profile/jevbot.bsky.social/post/abc).',
    'see https://example.com/app, and did:plc:ifow34t4mgatlvmu5bnkdq27.',
    'invented: [x](https://example.com/made-up) and `com.example.fake.thing` and did:plc:notreal.',
  ].join('\n');
  assert.deepEqual(groundingCheck(draft, haystack, ['https://bsky.app/profile/jevbot.bsky.social']).sort(),
    ['com.example.fake.thing', 'did:plc:notreal', 'https://example.com/made-up'].sort());
});

test('trailing punctuation and slashes do not make a real link ungrounded', () => {
  assert.deepEqual(groundingCheck('read https://example.com/app/. then', haystack), []);
});

test('lintDraft flags em dashes, banned phrases, raw html and bare mentions', () => {
  const report = lintDraft('a seamless week — truly. <b>hi</b> thanks @jevbot.bsky.social and [@jev.example](https://bsky.app/profile/jevbot.bsky.social)',
    haystack, ['https://bsky.app/profile/jevbot.bsky.social']);
  assert.equal(report.ok, false);
  assert.equal(report.emDashes, 1);
  assert.deepEqual(report.bannedPhrases, ['seamless', 'truly']);
  assert.equal(report.rawHtml, true);
  assert.deepEqual(report.bareMentions, ['@jevbot.bsky.social']);
});

test('a clean draft passes', () => {
  const report = lintDraft('## new in the atmosphere\n\n`app.bsky.actor.link` is new, see https://example.com/app.', haystack);
  assert.equal(report.ok, true);
  assert.equal(report.words, 10);
});

test('estimates must be rounded to the precision an estimate has', async () => {
  const { unroundedEstimates } = await import('../agent/lib/dispatch/lint.ts');
  assert.deepEqual(unroundedEstimates('about 4,685 and about 4,700, about 1,158 vs about 1,200, about 498 vs about 500, about 39'),
    ['about 4,685', 'about 1,158', 'about 498']);
  assert.equal(lintDraft('spark has about 4,685 accounts', haystack).ok, false);
});

test('banned phrases are checked in prose, not in NSIDs, URLs or other words', () => {
  const nsid = '[`town.delve.feed.post`](https://aturi.to/explore/lexicons/town.delve.feed.post) grew, see https://example.com/robust-thing';
  assert.deepEqual(lintDraft(nsid, haystack).bannedPhrases, []);
  assert.deepEqual(lintDraft('we delve into it. a robustness check is fine', haystack).bannedPhrases, ['delve']);
});

test('links must label the words that carry the claim', async () => {
  const { vagueLinks } = await import('../agent/lib/dispatch/lint.ts');
  assert.equal(vagueLinks('paul said so ([post](https://x.example/1)), see [here](https://x.example/2)'), 2);
  assert.equal(vagueLinks('paul [said attie is in beta](https://x.example/1), from his [post history](https://x.example/2)'), 0);
});

test('blocked sites cannot be linked, even though they are in the data', async () => {
  const { blockedLinks } = await import('../agent/lib/dispatch/lint.ts');
  const draft = '[parked app](https://parked.example) and [real app](https://real.example) and https://parked.example/page';
  assert.deepEqual(blockedLinks(draft, ['https://parked.example']), ['https://parked.example', 'https://parked.example/page']);
  assert.equal(lintDraft(draft, 'https://parked.example https://real.example https://parked.example/page', [], ['https://parked.example']).ok, false);
});

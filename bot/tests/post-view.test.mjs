import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

execFileSync('node', ['node_modules/typescript/bin/tsc', '--ignoreConfig',
  'agent/lib/post-view.ts', '--outDir', '.eve/post-view-test', '--rootDir', 'agent',
  '--module', 'esnext', '--moduleResolution', 'bundler', '--target', 'es2022',
  '--skipLibCheck', '--types', 'node'], { cwd: new URL('..', import.meta.url) });
const { parsePostRef, summarizePost, getPostsUrl } = await import('../.eve/post-view-test/lib/post-view.js');

const DID = 'did:plc:73dpznbu4wqwtcyurwbiulov';
const URI = `at://${DID}/app.bsky.feed.post/3myg7pie6p224`;
const thumb = (n) => `https://cdn.bsky.app/img/feed_thumbnail/plain/${DID}/bafkimage${n}@jpeg`;
const post = (embed, extra = {}) => ({ posts: [{
  uri: URI, author: { did: DID, handle: 'archive.org', displayName: 'Internet Archive' },
  record: { $type: 'app.bsky.feed.post', text: "An update from Brewster Kahle on today's outage.",
    createdAt: '2026-10-21T22:39:18.499Z' },
  likeCount: 1239, repostCount: 147, replyCount: 80, quoteCount: 106,
  ...(embed ? { embed } : {}), ...extra,
}] });
const images = (...alts) => ({ $type: 'app.bsky.embed.images#view',
  images: alts.map((alt, i) => ({ thumb: thumb(i), fullsize: thumb(i), ...(alt ? { alt } : {}) })) });

test('every link form names the post; anything else is refused', () => {
  const want = { repo: 'archive.org', rkey: '3myg7pie6p224' };
  for (const link of ['https://bsky.app/profile/archive.org/post/3myg7pie6p224',
    'bsky.app/profile/Archive.org/post/3myg7pie6p224/', 'https://bsky.app/profile/archive.org/post/3myg7pie6p224?ref=x',
    'at://archive.org/app.bsky.feed.post/3myg7pie6p224']) {
    assert.deepEqual(parsePostRef(link), want, link);
  }
  assert.deepEqual(parsePostRef(URI), { repo: DID, rkey: '3myg7pie6p224' });
  assert.deepEqual(parsePostRef('https://bsky.app/profile/did%3Aplc%3A73dpznbu4wqwtcyurwbiulov/post/3myg7pie6p224'),
    { repo: DID, rkey: '3myg7pie6p224' });
  for (const bad of ['https://evil.example/profile/archive.org/post/x', 'at://archive.org/app.bsky.feed.like/x',
    'https://bsky.app/profile/archive.org', 'hello', 'https://bsky.app/profile/a..b/post/x']) {
    assert.equal(parsePostRef(bad), null, bad);
  }
  assert.equal(getPostsUrl(DID, 'abc').searchParams.get('uris'), `at://${DID}/app.bsky.feed.post/abc`);
});

test('a post with images gives each one with its alt text, and the thumbnails to look at', () => {
  const { post: p, images: look } = summarizePost(post(images('Internet Archive ops staff were heroes last night.', '')));
  assert.equal(p.text, "An update from Brewster Kahle on today's outage.");
  assert.equal(p.link, 'https://bsky.app/profile/archive.org/post/3myg7pie6p224');
  assert.deepEqual(p.counts, { likes: 1239, reposts: 147, replies: 80, quotes: 106 });
  assert.deepEqual(p.images, [{ alt: 'Internet Archive ops staff were heroes last night.', source: 'the post' }, { source: 'the post' }]);
  assert.deepEqual(look.map((i) => i.url), [thumb(0), thumb(1)]);
  assert.equal(look[0].alt, 'Internet Archive ops staff were heroes last night.');
});

test('a quote with media gives both posts, their images, and the quoted post\'s text', () => {
  const embed = { $type: 'app.bsky.embed.recordWithMedia#view', media: images('mine'),
    record: { $type: 'app.bsky.embed.record#view', record: {
      $type: 'app.bsky.embed.record#viewRecord', uri: 'at://did:plc:other/app.bsky.feed.post/q1',
      author: { did: 'did:plc:other', handle: 'other.example' }, value: { text: 'the quoted words' },
      embeds: [images('their alt')] } } };
  const { post: p, images: look } = summarizePost(post(embed));
  assert.deepEqual(p.images, [{ alt: 'mine', source: 'the post' }]);
  assert.deepEqual(p.quote, { uri: 'at://did:plc:other/app.bsky.feed.post/q1', author: 'other.example',
    text: 'the quoted words', images: [{ alt: 'their alt' }] });
  assert.deepEqual(look.map((i) => i.source), ['the post it quotes', 'the post']);
});

test('a hidden quote, a link card, a video and a feed are said in words', () => {
  assert.deepEqual(summarizePost(post({ $type: 'app.bsky.embed.record#view',
    record: { $type: 'app.bsky.embed.record#viewBlocked', uri: 'at://did:plc:x/app.bsky.feed.post/b' } })).post.quote,
  { uri: 'at://did:plc:x/app.bsky.feed.post/b', missing: 'blocked' });
  assert.deepEqual(summarizePost(post({ $type: 'app.bsky.embed.external#view',
    external: { uri: 'https://example.com', title: 'A page', description: 'about it' } })).post.card,
  { uri: 'https://example.com', title: 'A page', description: 'about it' });
  assert.deepEqual(summarizePost(post({ $type: 'app.bsky.embed.video#view', alt: 'a cat', playlist: 'x' })).post.video,
    { alt: 'a cat' });
  const feed = summarizePost(post({ $type: 'app.bsky.embed.record#view',
    record: { $type: 'app.bsky.feed.defs#generatorView', uri: 'at://did:plc:x/app.bsky.feed.generator/f' } })).post;
  assert.equal(feed.other, 'at://did:plc:x/app.bsky.feed.generator/f');
  assert.equal(feed.quote, undefined);
});

test('only appview thumbnails are offered to look at, at most eight', () => {
  const embed = { $type: 'app.bsky.embed.images#view',
    images: [{ thumb: 'https://evil.example/x.jpg', alt: 'a' }, { thumb: thumb(1), alt: 'b' }] };
  const { post: p, images: look } = summarizePost(post(embed));
  assert.equal(p.images.length, 2, 'both alt texts still count');
  assert.deepEqual(look.map((i) => i.alt), ['b']);
});

test('no post, or a malformed answer, is null', () => {
  assert.equal(summarizePost({ posts: [] }), null);
  assert.equal(summarizePost(null), null);
  assert.equal(summarizePost({ posts: [{ uri: 'nope' }] }), null);
});

test('a labelled post keeps its alt text but offers no images to look at, as for mentions', () => {
  for (const val of ['porn', 'graphic-media', '!warn']) {
    const { post: p, images: look } = summarizePost(post(images('a description'), { labels: [{ val }] }));
    assert.deepEqual(p.images, [{ alt: 'a description', source: 'the post' }], val);
    assert.deepEqual(look, [], val);
  }
  const quoted = { $type: 'app.bsky.embed.record#view', record: {
    $type: 'app.bsky.embed.record#viewRecord', uri: 'at://did:plc:other/app.bsky.feed.post/q1',
    author: { handle: 'other.example' }, value: { text: 'q' }, labels: [{ val: 'nudity' }],
    embeds: [images('their alt')] } };
  const { post: p, images: look } = summarizePost(post(quoted));
  assert.deepEqual(p.quote.images, [{ alt: 'their alt' }]);
  assert.deepEqual(look, []);
  assert.equal(summarizePost(post(images('fine'), { labels: [{ val: 'bridged' }] })).images.length, 1, 'other labels change nothing');
});

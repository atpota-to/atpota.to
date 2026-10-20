import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asJpeg, chainFromView, describeEmbed, fetchThreadContext, imagesIn, MAX_ANCESTORS, parseContext, readPostContext } from '../src/thread.js';

// Shapes follow a real app.bsky.feed.getPostThread response, read from
// public.api.bsky.app on 2026-09-23: every node carries $type, and each post's
// record.reply.parent names the post above it.

const POE = 'did:plc:6qw63oash3jfnpykvpbwnq5z';
const DAME = 'did:plc:fnhrjbkwjiw6iyxxg2o3rljw';
const uri = (did, rkey) => `at://${did}/app.bsky.feed.post/${rkey}`;

function post(did, handle, rkey, text, { parent = null, embed } = {}) {
  return {
    $type: 'app.bsky.feed.defs#threadViewPost',
    post: {
      uri: uri(did, rkey),
      cid: `bafy${rkey}`,
      author: { did, handle },
      record: {
        $type: 'app.bsky.feed.post',
        text,
        createdAt: '2026-09-23T20:39:27.000Z',
        ...(parent ? { reply: { root: { uri: uri(DAME, 'root'), cid: 'x' }, parent: { uri: parent, cid: 'x' } } } : {}),
      },
      ...(embed ? { embed } : {}),
    },
  };
}

/** Link nodes child-to-parent the way the appview nests them, on copies. */
function nest(...oldestFirst) {
  let parent = null;
  for (const node of oldestFirst) {
    const copy = { ...node };
    delete copy.parent;
    if (parent) copy.parent = parent;
    parent = copy;
  }
  return { thread: parent };
}

// The nap exchange from the thread that prompted this, 2026-09-23.
const root = post(DAME, 'testing.dame.is', 'root', 'what is in my test repo?');
const ask = post(DAME, 'testing.dame.is', 'ask', 'it might be good to know that i am @dame.is', { parent: uri(DAME, 'root') });
const nap = post(POE, 'poe.atpota.to', 'nap', 'ok i need a little lie down!', { parent: uri(DAME, 'ask') });
// The same post, but replying to one the read did not reach.
const askAfterGap = post(DAME, 'testing.dame.is', 'ask', 'it might be good to know that i am @dame.is', { parent: uri(DAME, 'between') });

test('the chain comes back oldest first, with the potato\'s own posts marked', () => {
  const chain = chainFromView(nest(root, ask, nap), POE);
  assert.deepEqual(chain.map((c) => c.entry), [
    { author: 'testing.dame.is', authorDid: DAME, you: false, text: 'what is in my test repo?' },
    { author: 'testing.dame.is', authorDid: DAME, you: false, text: 'it might be good to know that i am @dame.is' },
    { author: 'poe.atpota.to', authorDid: POE, you: true, text: 'ok i need a little lie down!' },
  ]);
});

test('every thread line carries its signed author DID, even when handles are similar', () => {
  const one = post(DAME, 'same.handle', 'one', 'first person');
  const anotherDid = 'did:plc:anotherperson';
  const two = post(anotherDid, 'same.handle', 'two', 'second person', { parent: one.post.uri });
  const chain = chainFromView(nest(one, two), POE).map((item) => item.entry);
  assert.deepEqual(chain.map(({ author, authorDid }) => [author, authorDid]), [
    ['same.handle', DAME],
    ['same.handle', anotherDid],
  ]);
});

test('a note the poster wrote by itself is in the thread, which is the point', () => {
  // The agent never drafted "i need a little lie down" -- the droplet posts
  // cooldown notices itself -- so its session has no idea it said it, and it
  // answered "was nap good?" with "nope, no naps". The thread knows.
  const chain = chainFromView(nest(root, ask, nap), POE);
  assert.ok(chain.some((c) => c.entry.you && /lie down/.test(c.entry.text)));
});

test('deleted and blocked posts stop the chain and say why', () => {
  const gone = { $type: 'app.bsky.feed.defs#notFoundPost', uri: uri(DAME, 'gone'), notFound: true };
  const hidden = { $type: 'app.bsky.feed.defs#blockedPost', uri: uri(DAME, 'hidden'), blocked: true, author: { did: DAME } };
  assert.equal(chainFromView(nest(gone, nap), POE)[0].entry.missing, 'deleted');
  const blocked = chainFromView(nest(hidden, nap), POE)[0].entry;
  assert.equal(blocked.missing, 'blocked');
  assert.equal(blocked.text, '', 'a blocked post contributes no text');
});

test('a very long post is clipped rather than refused', () => {
  const long = post(DAME, 'testing.dame.is', 'long', 'x'.repeat(5000));
  const text = chainFromView(nest(long), POE)[0].entry.text;
  assert.ok(text.length <= 800);
  assert.ok(text.endsWith('…'));
});

test('an unresolvable handle falls back to the DID', () => {
  const p = post(DAME, 'handle.invalid', 'p', 'hi');
  assert.equal(chainFromView(nest(p), POE)[0].entry.author, DAME);
});

// --- embeds -----------------------------------------------------------------

test('images are described by their alt text', () => {
  assert.equal(describeEmbed({
    $type: 'app.bsky.embed.images#view',
    images: [{ alt: 'a PDS error dialog' }, { alt: '' }],
  }), '[image: a PDS error dialog] [image, no alt text]');
});

test('a link card, a quote, and a quote with media', () => {
  assert.equal(describeEmbed({
    $type: 'app.bsky.embed.external#view',
    external: { uri: 'https://atproto.com/specs/repository', title: 'Repository spec' },
  }), '[link card: Repository spec https://atproto.com/specs/repository]');

  const quote = {
    $type: 'app.bsky.embed.record#viewRecord',
    author: { did: DAME, handle: 'dame.is' },
    value: { text: 'lexicons are just json' },
  };
  assert.equal(describeEmbed({ $type: 'app.bsky.embed.record#view', record: quote }),
    '[quoting @dame.is: lexicons are just json]');
  assert.equal(describeEmbed({
    $type: 'app.bsky.embed.recordWithMedia#view',
    media: { $type: 'app.bsky.embed.images#view', images: [{ alt: 'screenshot' }] },
    record: { record: quote },
  }), '[image: screenshot] [quoting @dame.is: lexicons are just json]');
});

test('a quoted post the potato cannot see is named as such, not read', () => {
  assert.equal(describeEmbed({
    $type: 'app.bsky.embed.record#view',
    record: { $type: 'app.bsky.embed.record#viewBlocked', uri: 'at://x', blocked: true },
  }), '[quoting a post you cannot see]');
});

test('no embed, no attachment field', () => {
  assert.equal(describeEmbed(undefined), null);
  assert.equal('attachment' in chainFromView(nest(root), POE)[0].entry, false);
});

// --- fetching -----------------------------------------------------------------

function row(over = {}) {
  return {
    id: 1,
    uri: uri(DAME, 'new'),
    upstream_uri: uri(POE, 'nap'),
    root_uri: uri(DAME, 'root'),
    ...over,
  };
}

test('a post that starts a thread reads nothing', async () => {
  const api = { getPostThread: () => assert.fail('must not fetch'), getPosts: () => assert.fail('must not fetch') };
  assert.equal(await fetchThreadContext(row({ upstream_uri: null }), { botDid: POE, api }), null);
});

test('a complete chain is one request', async () => {
  let calls = 0;
  const api = {
    getPostThread: async (u, { parentHeight }) => {
      calls++;
      assert.equal(u, uri(POE, 'nap'), 'reads from what the post replies to, not from the post');
      assert.equal(parentHeight, MAX_ANCESTORS);
      return nest(root, ask, nap);
    },
    getPosts: () => assert.fail('the root was already in the chain'),
  };
  const thread = await fetchThreadContext(row(), { botDid: POE, api });
  assert.equal(calls, 1);
  assert.equal(thread.length, 3);
  assert.equal(thread.some((e) => e.missing), false);
});

test('a chain cut short gets the root on top and a marker for the gap', async () => {
  const api = {
    getPostThread: async () => nest(askAfterGap, nap),  // stops short of the root
    getPosts: async (uris) => {
      assert.deepEqual(uris, [uri(DAME, 'root')]);
      return { posts: [root.post] };
    },
  };
  const thread = await fetchThreadContext(row(), { botDid: POE, api });
  assert.deepEqual(thread.map((e) => e.missing ?? e.text.slice(0, 12)), [
    'what is in m', 'skipped', 'it might be ', 'ok i need a ',
  ]);
});

test('when the chain reaches right up to the root, no gap marker', async () => {
  const api = {
    getPostThread: async () => nest(ask, nap),          // ask's parent IS the root
    getPosts: async () => ({ posts: [root.post] }),
  };
  const thread = await fetchThreadContext(row(), { botDid: POE, api });
  assert.equal(thread.some((e) => e.missing === 'skipped'), false);
  assert.equal(thread[0].text, 'what is in my test repo?');
});

test('a failed read returns null instead of throwing: the answer still goes out', async () => {
  const api = { getPostThread: async () => { throw new Error('getPostThread failed: 400 NotFound'); } };
  assert.equal(await fetchThreadContext(row(), { botDid: POE, api }), null);
});

test('a failed root read still sends the nearest posts, with the gap marked', async () => {
  const api = {
    getPostThread: async () => nest(askAfterGap, nap),
    getPosts: async () => { throw new Error('appview down'); },
  };
  const thread = await fetchThreadContext(row(), { botDid: POE, api });
  assert.equal(thread[0].missing, 'skipped');
  assert.equal(thread.length, 3);
});

// --- the post being answered: its embed, its links, its images ---------------

const CDN = (cid) => `https://cdn.bsky.app/img/feed_thumbnail/plain/${DAME}/${cid}@jpeg`;
const images = (...alts) => ({
  $type: 'app.bsky.embed.images#view',
  images: alts.map((alt, i) => ({ thumb: CDN(`bafk${alt || 'noalt'}${i}`), fullsize: 'x', alt })),
});
const quoteOf = (text, embeds = [], extra = {}) => ({
  $type: 'app.bsky.embed.record#viewRecord',
  uri: uri(THIRD, 'quoted'),
  author: { did: THIRD, handle: 'alice.bsky.social' },
  value: { text },
  embeds,
  ...extra,
});
const THIRD = 'did:plc:thirdparty0000000000000';

test('the post being answered gets the long form: address, description, the quote\'s own media', () => {
  const embed = {
    $type: 'app.bsky.embed.recordWithMedia#view',
    media: images('my PDS settings page'),
    record: { record: quoteOf('why does this say handle.invalid', [images('')]) },
  };
  assert.equal(describeEmbed(embed, { detailed: true }),
    `[image: my PDS settings page] [quoting @alice.bsky.social (${uri(THIRD, 'quoted')}): why does this say handle.invalid] [image, no alt text]`);
  // The thread keeps the short form.
  assert.equal(describeEmbed(embed), '[image: my PDS settings page] [quoting @alice.bsky.social: why does this say handle.invalid]');
});

test('feeds, lists, starter packs, labelers and gifs are each named', () => {
  const rec = (record) => describeEmbed({ $type: 'app.bsky.embed.record#view', record }, { detailed: true });
  const creator = { did: THIRD, handle: 'alice.bsky.social' };
  assert.equal(rec({ $type: 'app.bsky.feed.defs#generatorView', uri: 'at://f', displayName: 'Atproto Dev', creator, description: 'posts about atproto' }),
    '[feed "Atproto Dev" by @alice.bsky.social (at://f): posts about atproto]');
  assert.equal(rec({ $type: 'app.bsky.graph.defs#listView', uri: 'at://l', name: 'PDS hosts', creator }),
    '[list "PDS hosts" by @alice.bsky.social (at://l)]');
  assert.equal(rec({ $type: 'app.bsky.graph.defs#starterPackViewBasic', uri: 'at://s', record: { name: 'Lexicon nerds' }, creator }),
    '[starter pack "Lexicon nerds" by @alice.bsky.social (at://s)]');
  assert.equal(rec({ $type: 'app.bsky.labeler.defs#labelerView', uri: 'at://lab', creator }),
    '[labeler by @alice.bsky.social (at://lab)]');
  assert.equal(describeEmbed({ $type: 'app.bsky.embed.external#view', external: { uri: 'https://media.tenor.com/abc.gif', title: 'Potato Dance GIF' } }),
    '[gif: Potato Dance GIF]');
  assert.equal(describeEmbed({ $type: 'app.bsky.embed.external#view', external: { uri: 'https://atproto.com/x', title: 'Spec', description: 'the repository spec' } }, { detailed: true }),
    '[link card: Spec https://atproto.com/x. the repository spec]');
});

test('images come from the post, then its quote; withheld labels and foreign hosts send none', () => {
  const post = {
    embed: { $type: 'app.bsky.embed.recordWithMedia#view', media: images('mine'), record: { record: quoteOf('q', [images('theirs')]) } },
  };
  assert.deepEqual(imagesIn(post, 'own', 'quoted').map((i) => [i.source, i.alt]), [['own', 'mine'], ['quoted', 'theirs']]);

  const nsfw = { ...post, labels: [{ val: 'porn' }] };
  assert.deepEqual(imagesIn(nsfw, 'own', 'quoted').map((i) => i.source), ['quoted'], 'the label withholds only its own post');

  const foreign = { embed: { $type: 'app.bsky.embed.images#view', images: [{ thumb: 'https://evil.example/x.jpg', alt: '' }] } };
  assert.deepEqual(imagesIn(foreign, 'own', 'quoted'), []);
  assert.deepEqual(imagesIn(null, 'own', 'quoted'), []);
});

/** A getPostThread response anchored on the post being answered. */
function anchoredOn(anchorPost, ...aboveOldestFirst) {
  const nodes = [...aboveOldestFirst, { $type: 'app.bsky.feed.defs#threadViewPost', post: anchorPost }];
  return nest(...nodes);
}

const asked = (over = {}) => ({
  uri: uri(DAME, 'new'),
  author: { did: DAME, handle: 'testing.dame.is' },
  record: { text: '@poe.atpota.to what is this?', ...(over.record ?? {}) },
  ...over,
});

test('a top-level quote post: its embed and images, no thread, one request', async () => {
  let calls = 0;
  const api = {
    getPostThread: async (u) => {
      calls++;
      assert.equal(u, uri(DAME, 'new'), 'reads the post being answered itself');
      return anchoredOn(asked({ embed: { $type: 'app.bsky.embed.record#view', record: quoteOf('look at my repo', [images('')]) } }));
    },
    getPosts: () => assert.fail('nothing above it'),
  };
  const ctx = await readPostContext(row({ upstream_uri: null, root_uri: uri(DAME, 'new') }), { botDid: POE, api });
  assert.equal(calls, 1);
  assert.match(ctx.attachment, /^\[quoting @alice\.bsky\.social \(at:\/\/.+\): look at my repo\] \[image, no alt text\]$/);
  assert.deepEqual(ctx.images.map((i) => i.source), ['the post they quoted']);
  assert.equal('thread' in ctx, false);
  assert.equal('text' in ctx, false, 'no links, nothing to rewrite');
});

test('shortened links in the post come back written out', async () => {
  const url = 'https://github.com/bluesky-social/atproto/blob/main/README.md';
  const start = Buffer.byteLength('what is ', 'utf8');
  const shown = 'github.com/bluesky-soci...';
  const api = {
    getPostThread: async () => anchoredOn(asked({
      record: {
        text: `what is ${shown}`,
        facets: [{ index: { byteStart: start, byteEnd: start + Buffer.byteLength(shown) }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }] }],
      },
    })),
  };
  const ctx = await readPostContext(row({ upstream_uri: null }), { botDid: POE, api });
  assert.equal(ctx.text, `what is ${url}`);
});

test('a reply: the thread above, and the images of the post it replies to', async () => {
  const withPic = post(DAME, 'testing.dame.is', 'ask', 'my PDS is broken', { parent: uri(DAME, 'root'), embed: images('error dialog', 'second') });
  const api = {
    getPostThread: async () => anchoredOn(asked({ embed: images('mine') }), root, withPic),
    getPosts: () => assert.fail('the chain already reaches the root'),
  };
  const ctx = await readPostContext(row(), { botDid: POE, api });
  assert.deepEqual(ctx.thread.map((e) => e.text), ['what is in my test repo?', 'my PDS is broken']);
  assert.deepEqual(ctx.images.map((i) => `${i.source}:${i.alt}`),
    ['their post:mine', 'the post they replied to:error dialog', 'the post they replied to:second']);
});

test('never more than four images', async () => {
  const api = { getPostThread: async () => anchoredOn(asked({ embed: images('1', '2', '3', '4') }), post(DAME, 'd', 'p', 'x', { embed: images('5') })) };
  const ctx = await readPostContext(row(), { botDid: POE, api });
  assert.equal(ctx.images.length, 4);
  assert.equal(ctx.images.every((i) => i.source === 'their post'), true, 'their own come first');
});

test('a post the appview has not indexed yet is waited for, twice, briefly', async () => {
  const waits = [];
  let calls = 0;
  const api = {
    getPostThread: async () => {
      if (++calls < 3) throw new Error('getPostThread failed: 400 NotFound');
      return anchoredOn(asked({ embed: images('late') }));
    },
  };
  const ctx = await readPostContext(row({ upstream_uri: null }), { botDid: POE, api, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [700, 1500]);
  assert.equal(ctx.attachment, '[image: late]');
});

test('still not indexed: the thread is read from what it replies to instead', async () => {
  const api = {
    getPostThread: async (u) => {
      if (u === uri(DAME, 'new')) throw new Error('getPostThread failed: 400 NotFound');
      return nest(root, ask, nap);
    },
  };
  const ctx = await readPostContext(row(), { botDid: POE, api, sleep: async () => {} });
  assert.deepEqual(Object.keys(ctx), ['thread']);
  assert.equal(ctx.thread.length, 3);
});

test('an error that is not a miss is not waited on', async () => {
  const waits = [];
  const api = { getPostThread: async () => { throw new Error('fetch failed'); } };
  assert.equal(await readPostContext(row({ upstream_uri: null }), { botDid: POE, api, sleep: async (ms) => { waits.push(ms); } }), null);
  assert.deepEqual(waits, []);
});

test('a plain top-level post has nothing to add, which is kept as {} so it is not read again', async () => {
  const api = { getPostThread: async () => anchoredOn(asked()) };
  assert.deepEqual(await readPostContext(row({ upstream_uri: null }), { botDid: POE, api }), {});
});

test('a stored context parses, including the first version that was only a thread', () => {
  assert.deepEqual(parseContext('[{"author":"a","you":false,"text":"t"}]'), { thread: [{ author: 'a', you: false, text: 't' }] });
  assert.deepEqual(parseContext('{"attachment":"[gif: x]"}'), { attachment: '[gif: x]' });
  assert.equal(parseContext(null), null);
  assert.equal(parseContext('{not json'), null);
});

test('thumbnails are always asked for as JPEG, which is what the agent says it sends', () => {
  const bare = 'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:a/bafkreie5';
  assert.equal(asJpeg(bare), `${bare}@jpeg`, 'the appview gives no suffix, and the CDN answers that with WebP');
  assert.equal(asJpeg(`${bare}@webp`), `${bare}@jpeg`);
  assert.equal(asJpeg(`${bare}@jpeg`), `${bare}@jpeg`);
  const post = { embed: { $type: 'app.bsky.embed.images#view', images: [{ thumb: bare, alt: '' }] } };
  assert.equal(imagesIn(post, 'own', 'quoted')[0].url, `${bare}@jpeg`);
});

test('posts by the people who run the potato are marked in the thread', () => {
  const steer = post(DAME, 'dame.is', 'steer', 'poe, mention app passwords too', { parent: uri(DAME, 'root') });
  const chain = chainFromView(nest(root, steer), POE, [DAME]);
  assert.equal(chain[1].entry.operator, true);
  assert.equal('operator' in chainFromView(nest(root, steer), POE).at(-1).entry, false, 'nobody is an admin unless listed');
});

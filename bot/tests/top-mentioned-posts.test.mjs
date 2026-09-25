import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';

execFileSync('node', ['node_modules/typescript/bin/tsc', '--ignoreConfig',
  'agent/tools/top_mentioned_posts.ts', '--outDir', '.eve/top-mentioned-posts-test', '--rootDir', 'agent',
  '--module', 'esnext', '--moduleResolution', 'bundler', '--target', 'es2022',
  '--skipLibCheck', '--types', 'node'], { cwd: new URL('..', import.meta.url) });
const helper = await import('../.eve/top-mentioned-posts-test/lib/top-mentioned-posts.js');
const source = readFileSync(new URL('../.eve/top-mentioned-posts-test/tools/top_mentioned_posts.js', import.meta.url), 'utf8')
  .replace('from "eve/tools"', `from "data:text/javascript,${encodeURIComponent('export const defineWorkflowTool = (tool) => tool;')}"`)
  .replace('from "../lib/top-mentioned-posts"', 'from "../lib/top-mentioned-posts.js"');
writeFileSync(new URL('../.eve/top-mentioned-posts-test/tools/top_mentioned_posts.mjs', import.meta.url), source);
const tool = (await import('../.eve/top-mentioned-posts-test/tools/top_mentioned_posts.mjs')).default;

const target = 'did:plc:ifow34t4mgatlvmu5bnkdq27';
const author = 'did:plc:author';
const uri = (rkey) => `at://${author}/app.bsky.feed.post/${rkey}`;
const backlink = (rkey) => ({ did: author, collection: 'app.bsky.feed.post', rkey });
const post = (rkey, likeCount, mentioned = true) => ({ uri: uri(rkey), author: { did: author, handle: 'writer.bsky.social' },
  record: { text: `${rkey} text ` + 'x'.repeat(300), facets: mentioned ? [{ features: [
    { $type: 'app.bsky.richtext.facet#mention', did: target },
  ] }] : [] }, likeCount, extra: 'private record material' });
const postUri = 'at://did:plc:requester/app.bsky.feed.post/post1';
const caller = { authenticator: 'atpotato-droplet', principalType: 'user', principalId: 'did:plc:requester',
  attributes: { did: 'did:plc:requester', postUri, attempt: '3' } };
const ctx = { session: { id: 'session-1', auth: { initiator: caller, current: caller } } };
const claimUrl = 'https://droplet.example/internal/scan-budget/claim';
function mockNetwork(responder, claim = () => Response.json({ ok: true })) {
  process.env.DROPLET_CALLBACK_URL = 'https://droplet.example/draft';
  process.env.DROPLET_SHARED_SECRET = 'shared';
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    requests.push({ url: parsed, init });
    assert.equal(init.redirect, 'error');
    if (parsed.href === claimUrl) {
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['x-atpotato-secret'], 'shared');
      assert.deepEqual(JSON.parse(init.body), { sessionId: 'session-1', postUri, attempt: 3 });
      return claim();
    }
    assert.equal(init.headers?.['x-atpotato-secret'], undefined);
    assert.ok(['constellation.microcosm.blue', 'public.api.bsky.app'].includes(parsed.hostname));
    return responder(parsed);
  };
  return requests;
}

const firstPath = `app.bsky.feed.post:${helper.MENTION_PATHS[0]}`;
const secondPath = `app.bsky.feed.post:${helper.MENTION_PATHS[1]}`;

test('paginates both exact paths, deduplicates, verifies facets, and sorts by likes', async () => {
  const previous = globalThis.fetch;
  try {
    const requests = mockNetwork((url) => {
      if (url.pathname.endsWith('resolveHandle')) {
        assert.equal(url.searchParams.get('handle'), 'jevbot.bsky.social');
        return Response.json({ did: target });
      }
      if (url.pathname.endsWith('getBacklinks')) {
        assert.equal(url.searchParams.get('subject'), target);
        if (url.searchParams.get('source') === firstPath) {
          return Response.json(url.searchParams.get('cursor') ? { total: 3, records: [backlink('b')] } :
            { total: 3, records: [backlink('a'), backlink('b')], cursor: 'next' });
        }
        assert.equal(url.searchParams.get('source'), secondPath);
        return Response.json({ total: 2, records: [backlink('c'), backlink('not-a-mention')], cursor: null });
      }
      assert.ok(url.pathname.endsWith('getPosts'));
      assert.deepEqual(url.searchParams.getAll('uris'), [uri('a'), uri('b'), uri('c'), uri('not-a-mention')]);
      return Response.json({ posts: [post('a', 4), post('b', 40), post('c', 10), post('not-a-mention', 999, false)] });
    });
    const result = await tool.execute({ handle: 'jevbot.bsky.social', limit: 5 }, ctx);
    assert.equal(requests[0].url.href, claimUrl);
    assert.deepEqual(result.posts.map((p) => [p.uri, p.likeCount]), [[uri('b'), 40], [uri('c'), 10], [uri('a'), 4]]);
    assert.equal(result.posts[0].handle, 'writer.bsky.social');
    assert.equal(result.posts[0].text.length, 280);
    assert.equal(result.scanned, 4);
    assert.equal(result.hydrated, 3);
    assert.equal(result.discardedNonMentions, 1);
    assert.equal(result.pages, 3);
    assert.equal(result.complete, true);
    assert.deepEqual(result.total.map((p) => p.count), [3, 2]);
    assert.match(result.totalNote, /index coverage may be incomplete/);
    assert.equal(JSON.stringify(result).includes('private record material'), false);
  } finally { globalThis.fetch = previous; }
});

test('DID skips resolveHandle; partial on a Constellation 5xx still hydrates collected posts', async () => {
  const previous = globalThis.fetch;
  try {
    const requests = mockNetwork((url) => {
      if (url.pathname.endsWith('getBacklinks')) return url.searchParams.has('cursor')
        ? new Response(null, { status: 503 })
        : Response.json({ total: 10, records: [backlink('a')], cursor: 'next' });
      assert.ok(url.pathname.endsWith('getPosts'));
      return Response.json({ posts: [post('a', 8)] });
    });
    const result = await tool.execute({ handle: target, limit: 5 }, ctx);
    assert.deepEqual(result.posts.map((p) => p.uri), [uri('a')]);
    assert.equal(result.complete, false);
    assert.equal(result.partial, true);
    assert.equal(result.stopped, 'upstream_error');
    assert.equal(result.errors[0].status, 503);
    assert.equal(requests.some((r) => r.url.pathname.endsWith('resolveHandle')), false);
  } finally { globalThis.fetch = previous; }
});

test('429 preserves Retry-After and returns an incomplete result without retrying', async () => {
  const previous = globalThis.fetch;
  try {
    const requests = mockNetwork((url) => {
      if (url.pathname.endsWith('getBacklinks')) return new Response(null, { status: 429, headers: { 'retry-after': '37' } });
      throw new Error('unexpected request');
    });
    const result = await tool.execute({ handle: target, limit: 5 }, ctx);
    assert.deepEqual(result.posts, []);
    assert.equal(result.partial, true);
    assert.equal(result.stopped, 'rate_limited');
    assert.equal(result.errors[0].retryAfter, 37);
    assert.equal(requests.length, 2);
  } finally { globalThis.fetch = previous; }
});

test('limits the scan to 1000 unique URIs and hydrates in batches of at most 25', async () => {
  const previous = globalThis.fetch;
  try {
    let index = 0;
    const requests = mockNetwork((url) => {
      if (url.pathname.endsWith('getBacklinks')) {
        const records = Array.from({ length: 100 }, () => backlink(String(index++)));
        return Response.json({ total: 2000, records, cursor: String(index) });
      }
      assert.ok(url.pathname.endsWith('getPosts'));
      const uris = url.searchParams.getAll('uris');
      assert.ok(uris.length <= 25);
      return Response.json({ posts: uris.map((address) => post(address.split('/').at(-1), 1)) });
    });
    const result = await tool.execute({ handle: target, limit: 10 }, ctx);
    assert.equal(result.scanned, 1000);
    assert.equal(result.pages, 10);
    assert.equal(result.posts.length, 10);
    assert.equal(result.stopped, 'posts');
    assert.equal(result.complete, false);
    assert.equal(requests.filter((r) => r.url.pathname.endsWith('getPosts')).length, 40);
  } finally { globalThis.fetch = previous; }
});

test('hydration 5xx preserves earlier ranked posts and marks remaining URIs missing', async () => {
  const previous = globalThis.fetch;
  try {
    let hydrationCalls = 0;
    mockNetwork((url) => {
      if (url.pathname.endsWith('getBacklinks')) return url.searchParams.get('source') === firstPath
        ? Response.json({ total: 26, records: Array.from({ length: 26 }, (_, i) => backlink(String(i))) })
        : Response.json({ total: 0, records: [] });
      const uris = url.searchParams.getAll('uris');
      return ++hydrationCalls === 1
        ? Response.json({ posts: uris.map((address) => post(address.split('/').at(-1), 17)) })
        : new Response(null, { status: 503 });
    });
    const result = await tool.execute({ handle: target, limit: 5 }, ctx);
    assert.equal(result.posts.length, 5);
    assert.equal(result.scanned, 26);
    assert.equal(result.hydrated, 25);
    assert.equal(result.missingHydration, 1);
    assert.equal(result.complete, false);
    assert.equal(result.stopped, 'upstream_error');
    assert.equal(result.errors[0].status, 503);
    assert.equal(hydrationCalls, 2);
  } finally { globalThis.fetch = previous; }
});

test('page cap remains effective with duplicates across paths', async () => {
  const previous = globalThis.fetch;
  try {
    const requests = mockNetwork((url) => url.pathname.endsWith('getBacklinks')
      ? Response.json({ total: 9999, records: [backlink('same')], cursor: Math.random().toString(36).slice(2) })
      : Response.json({ posts: [post('same', 3)] }));
    const result = await tool.execute({ handle: target, limit: 5 }, ctx);
    assert.equal(result.pages, helper.MAX_PAGES);
    assert.equal(result.scanned, 1);
    assert.equal(result.stopped, 'pages');
    assert.equal(requests.filter((r) => r.url.pathname.endsWith('getBacklinks')).length, helper.MAX_PAGES);
  } finally { globalThis.fetch = previous; }
});

test('invalid input, untrusted auth, and spent or insecure budget fail before public fetch', async () => {
  const previous = globalThis.fetch;
  const previousCallback = process.env.DROPLET_CALLBACK_URL;
  try {
    for (const handle of ['@jevbot.bsky.social', 'bad..handle', 'did:plc:', 'https://bsky.app', 'a'.repeat(301)]) {
      assert.equal(tool.inputSchema.safeParse({ handle, limit: 5 }).success, false);
    }
    assert.equal(tool.inputSchema.safeParse({ handle: target, limit: 10 }).success, true);
    assert.equal(tool.inputSchema.safeParse({ handle: target, limit: 11 }).success, false);
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('unexpected network'); };
    await assert.rejects(tool.execute({ handle: target, limit: 5 },
      { session: { id: 'session-1', auth: { current: { ...caller, authenticator: 'oidc' } } } }),
    { message: 'Scan requires an authenticated Bluesky post' });
    assert.equal(calls, 0);
    const requests = mockNetwork(() => { throw new Error('public request without claim'); }, () => new Response(null, { status: 409 }));
    await assert.rejects(tool.execute({ handle: target, limit: 5 }, ctx), { message: 'Scan budget spent for this turn' });
    assert.equal(requests.length, 1);
    process.env.DROPLET_CALLBACK_URL = 'http://droplet.example';
    await assert.rejects(tool.execute({ handle: target, limit: 5 }, ctx), { message: 'Scan budget callback must use HTTPS' });
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = previous;
    if (previousCallback === undefined) delete process.env.DROPLET_CALLBACK_URL;
    else process.env.DROPLET_CALLBACK_URL = previousCallback;
  }
});

test('rejects oversize pages without leaking upstream text', async () => {
  const previous = globalThis.fetch;
  try {
    mockNetwork((url) => url.pathname.endsWith('getBacklinks')
      ? new Response('s'.repeat(helper.MAX_RESPONSE_BYTES + 1)) : Response.json({ posts: [] }));
    const result = await tool.execute({ handle: target, limit: 5 }, ctx);
    assert.equal(result.complete, false);
    assert.equal(result.stopped, 'upstream_error');
    assert.equal(result.pages, 0);
    assert.equal(JSON.stringify(result).includes('sss'), false);
  } finally { globalThis.fetch = previous; }
});

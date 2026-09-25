import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';

execFileSync('node', ['node_modules/typescript/bin/tsc', '--ignoreConfig',
  'agent/tools/top_author_posts.ts', '--outDir', '.eve/top-author-posts-test', '--rootDir', 'agent',
  '--module', 'esnext', '--moduleResolution', 'bundler', '--target', 'es2022',
  '--skipLibCheck', '--types', 'node'], { cwd: new URL('..', import.meta.url) });
const helper = await import('../.eve/top-author-posts-test/lib/top-author-posts.js');
const source = readFileSync(new URL('../.eve/top-author-posts-test/tools/top_author_posts.js', import.meta.url), 'utf8')
  .replace('from "eve/tools"', `from "data:text/javascript,${encodeURIComponent('export const defineWorkflowTool = (tool) => tool;')}"`)
  .replace('from "../lib/top-author-posts"', 'from "../lib/top-author-posts.js"');
writeFileSync(new URL('../.eve/top-author-posts-test/tools/top_author_posts.mjs', import.meta.url), source);
const tool = (await import('../.eve/top-author-posts-test/tools/top_author_posts.mjs')).default;

const target = 'did:plc:ifow34t4mgatlvmu5bnkdq27';
const uri = (rkey, did = target) => `at://${did}/app.bsky.feed.post/${rkey}`;
const entry = (rkey, likeCount, did = target) => ({ post: { uri: uri(rkey, did),
  author: { did, handle: 'jevbot.bsky.social' }, record: { $type: 'app.bsky.feed.post',
    text: `${rkey} ` + 'x'.repeat(300), hidden: 'private record material' }, likeCount },
  reply: { parent: { text: 'not exposed' } } });
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
    assert.equal(parsed.hostname, 'public.api.bsky.app');
    return responder(parsed);
  };
  return requests;
}

test('resolves handle, paginates, filters foreign reposts, deduplicates and ranks compact posts', async () => {
  const previous = globalThis.fetch;
  try {
    const requests = mockNetwork((url) => {
      if (url.pathname.endsWith('resolveHandle')) {
        assert.equal(url.searchParams.get('handle'), 'jevbot.bsky.social');
        return Response.json({ did: target });
      }
      assert.ok(url.pathname.endsWith('getAuthorFeed'));
      assert.equal(url.searchParams.get('actor'), target);
      assert.equal(url.searchParams.get('filter'), 'posts_with_replies');
      assert.equal(url.searchParams.get('limit'), '50');
      return Response.json(url.searchParams.has('cursor')
        ? { feed: [entry('b', 30), entry('c', 5)], cursor: null }
        : { feed: [entry('a', 4), entry('foreign', 999, 'did:plc:other'), entry('b', 3)], cursor: 'next' });
    });
    const result = await tool.execute({ handle: 'jevbot.bsky.social', limit: 5 }, ctx);
    assert.equal(requests[0].url.href, claimUrl);
    assert.equal(requests[2].url.searchParams.get('cursor'), null);
    assert.equal(requests[3].url.searchParams.get('cursor'), 'next');
    assert.deepEqual(result.posts.map((p) => [p.uri, p.likeCount]),
      [[uri('c'), 5], [uri('a'), 4], [uri('b'), 3]]);
    assert.equal(result.posts[0].handle, 'jevbot.bsky.social');
    assert.equal(result.posts[0].excerpt.length, 280);
    assert.equal(result.scanned, 3);
    assert.equal(result.inspected, 5);
    assert.equal(result.skipped, 1);
    assert.equal(result.duplicates, 1);
    assert.equal(result.pages, 2);
    assert.equal(result.complete, true);
    assert.equal(result.stopped, null);
    assert.equal(JSON.stringify(result).includes('private record material'), false);
    assert.equal(JSON.stringify(result).includes('not exposed'), false);
  } finally { globalThis.fetch = previous; }
});

test('bounds scan at 1000 authored posts and 20 pages', async () => {
  const previous = globalThis.fetch;
  try {
    let index = 0;
    const requests = mockNetwork((url) => {
      assert.ok(url.pathname.endsWith('getAuthorFeed'));
      assert.equal(Number(url.searchParams.get('limit')), 50);
      const feed = Array.from({ length: 50 }, () => entry(String(index), index++));
      return Response.json({ feed, cursor: String(index) });
    });
    const result = await tool.execute({ handle: target, limit: 10 }, ctx);
    assert.equal(result.scanned, 1000);
    assert.equal(result.pages, 20);
    assert.equal(result.posts.length, 10);
    assert.equal(result.posts[0].likeCount, 999);
    assert.equal(result.stopped, 'posts');
    assert.equal(result.partial, true);
    assert.equal(requests.length, 21);
  } finally { globalThis.fetch = previous; }
});

test('429 Retry-After and 5xx return partial ranked results without retrying', async () => {
  const previous = globalThis.fetch;
  try {
    for (const [status, expected] of [[429, 'rate_limited'], [503, 'upstream_error']]) {
      const requests = mockNetwork((url) => url.searchParams.has('cursor')
        ? new Response(null, { status, headers: status === 429 ? { 'retry-after': '37' } : {} })
        : Response.json({ feed: [entry('a', 8)], cursor: 'next' }));
      const result = await tool.execute({ handle: target, limit: 5 }, ctx);
      assert.deepEqual(result.posts.map((p) => p.uri), [uri('a')]);
      assert.equal(result.complete, false);
      assert.equal(result.stopped, expected);
      assert.equal(result.errors[0].status, status);
      assert.equal(result.errors[0].retryAfter, status === 429 ? 37 : null);
      assert.equal(requests.length, 3);
    }
  } finally { globalThis.fetch = previous; }
});

test('malformed page and repeated or empty cursor stop safely', async () => {
  const previous = globalThis.fetch;
  try {
    for (const next of [{ feed: 'not a feed' }, { feed: [entry('a', 2)], cursor: 'next' },
      { feed: [], cursor: 'next' }]) {
      let calls = 0;
      mockNetwork((url) => {
        calls++;
        if (next.feed === 'not a feed') return Response.json(next);
        if (calls === 1) return Response.json({ feed: [entry('a', 2)], cursor: 'next' });
        return Response.json(next);
      });
      const result = await tool.execute({ handle: target, limit: 5 }, ctx);
      assert.equal(result.partial, true);
      assert.equal(result.stopped, 'upstream_error');
      assert.equal(result.errors[0].message, 'Invalid Bluesky author page');
      assert.equal(calls, next.feed === 'not a feed' ? 1 : 2);
    }
  } finally { globalThis.fetch = previous; }
});

test('page and byte caps stop scans with duplicate entries', async () => {
  const previous = globalThis.fetch;
  try {
    let page = 0;
    mockNetwork(() => Response.json({ feed: [entry('same', 1)], cursor: String(++page) }));
    const capped = await tool.execute({ handle: target, limit: 5 }, ctx);
    assert.equal(capped.scanned, 1);
    assert.equal(capped.pages, helper.MAX_PAGES);
    assert.equal(capped.stopped, 'pages');
    mockNetwork(() => new Response('x'.repeat(helper.MAX_RESPONSE_BYTES + 1)));
    const oversized = await tool.execute({ handle: target, limit: 5 }, ctx);
    assert.equal(oversized.pages, 0);
    assert.equal(oversized.partial, true);
    assert.equal(oversized.errors[0].message, 'Bluesky response exceeds page byte limit');
    assert.equal(JSON.stringify(oversized).includes('xxxx'), false);
    let pages = 0;
    mockNetwork(() => Response.json({ feed: [entry(String(pages), 1)], cursor: String(++pages),
      padding: 'z'.repeat(1_100_000) }));
    const bytes = await tool.execute({ handle: target, limit: 5 }, ctx);
    assert.equal(bytes.stopped, 'bytes');
    assert.equal(bytes.partial, true);
    assert.ok(bytes.pages < helper.MAX_PAGES);
    assert.ok(bytes.bytes <= helper.MAX_TOTAL_BYTES);
    assert.equal(JSON.stringify(bytes).includes('zzzz'), false);
  } finally { globalThis.fetch = previous; }
});

test('untrusted caller, invalid input and denied scan budget prevent public fetch', async () => {
  const previous = globalThis.fetch;
  const previousCallback = process.env.DROPLET_CALLBACK_URL;
  try {
    for (const handle of ['@jevbot.bsky.social', 'bad..handle', 'did:plc:', 'https://bsky.app'])
      assert.equal(tool.inputSchema.safeParse({ handle }).success, false);
    assert.equal(tool.inputSchema.safeParse({ handle: target, limit: 10 }).success, true);
    assert.equal(tool.inputSchema.safeParse({ handle: target, limit: 11 }).success, false);
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('unexpected fetch'); };
    await assert.rejects(tool.execute({ handle: target, limit: 5 },
      { session: { id: 'session-1', auth: { current: { ...caller, authenticator: 'oidc' } } } }),
    { message: 'Scan requires an authenticated Bluesky post' });
    assert.equal(calls, 0);
    const requests = mockNetwork(() => { throw new Error('public fetch without claim'); },
      () => new Response(null, { status: 409 }));
    await assert.rejects(tool.execute({ handle: target, limit: 5 }, ctx), { message: 'Scan budget spent for this turn' });
    assert.equal(requests.length, 1);
    process.env.DROPLET_CALLBACK_URL = 'http://droplet.example';
    await assert.rejects(tool.execute({ handle: target, limit: 5 }, ctx),
      { message: 'Scan budget callback must use HTTPS' });
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = previous;
    if (previousCallback === undefined) delete process.env.DROPLET_CALLBACK_URL;
    else process.env.DROPLET_CALLBACK_URL = previousCallback;
  }
});

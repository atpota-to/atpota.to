import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';

execFileSync('node', ['node_modules/typescript/bin/tsc', '--ignoreConfig',
  'agent/tools/search_bluesky_posts.ts', '--outDir', '.eve/search-bluesky-posts-test', '--rootDir', 'agent',
  '--module', 'esnext', '--moduleResolution', 'bundler', '--target', 'es2022',
  '--skipLibCheck', '--types', 'node'], { cwd: new URL('..', import.meta.url) });
const source = readFileSync(new URL('../.eve/search-bluesky-posts-test/tools/search_bluesky_posts.js', import.meta.url), 'utf8')
  .replace('from "eve/tools"', `from "data:text/javascript,${encodeURIComponent('export const defineTool = (tool) => tool;')}"`);
writeFileSync(new URL('../.eve/search-bluesky-posts-test/tools/search_bluesky_posts.mjs', import.meta.url), source);
const tool = (await import('../.eve/search-bluesky-posts-test/tools/search_bluesky_posts.mjs')).default;

const postUri = 'at://did:plc:requester/app.bsky.feed.post/post1';
const signed = { authenticator: 'atpotato-droplet', principalType: 'user',
  principalId: 'did:plc:requester', attributes: { did: 'did:plc:requester', postUri, attempt: '3' } };
const dm = { authenticator: 'atpotato-droplet-dm', principalType: 'user',
  principalId: 'did:plc:operator', attributes: { operatorDid: 'did:plc:operator', dmId: 'dm-1' } };
const oidc = { authenticator: 'oidc', principalType: 'user', principalId: 'user-1' };
const context = (auth = { initiator: signed, current: signed }, id = 'session-1') =>
  ({ session: { id, auth } });
const post = { uri: 'at://did:plc:author/app.bsky.feed.post/result', text: 'found', likeCount: 12 };
const page = (cursor = 'next') => Response.json({ ok: true, posts: [post], cursor,
  hitsTotal: 42, detectedQueryLanguages: ['ja'] });
const originalEnv = { DROPLET_CALLBACK_URL: process.env.DROPLET_CALLBACK_URL,
  DROPLET_SHARED_SECRET: process.env.DROPLET_SHARED_SECRET };

test.after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function mockFetch(handler = () => page()) {
  process.env.DROPLET_CALLBACK_URL = 'https://droplet.example/draft';
  process.env.DROPLET_SHARED_SECRET = 'shared';
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    assert.equal(String(url), 'https://droplet.example/internal/bluesky-search');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['x-atpotato-secret'], 'shared');
    assert.ok(init.signal);
    return handler(init);
  };
  return requests;
}

test('signed post forwards identity, default limit and one compact page through the droplet', async () => {
  const original = globalThis.fetch;
  try {
    const requests = mockFetch();
    assert.deepEqual(await tool.execute({ query: 'cats' }, context()), {
      posts: [post], cursor: 'next', hitsTotal: 42, detectedQueryLanguages: ['ja'],
    });
    assert.equal(requests.length, 1);
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      sessionId: 'session-1', postUri, attempt: 3, query: 'cats', limit: 10,
    });
    assert.equal(requests[0].init.body.includes('jwt'), false);
  } finally { globalThis.fetch = original; }
});

test('operator DM and authenticated site callers send only the session address', async () => {
  const original = globalThis.fetch;
  const dev = process.env.EVE_DEV;
  try {
    process.env.EVE_DEV = '1';
    for (const caller of [dm, oidc, { authenticator: 'oidc', principalType: 'runtime', principalId: 'runtime-1' },
      { authenticator: 'local-dev', principalType: 'user', principalId: 'local-1' }]) {
      const requests = mockFetch();
      assert.deepEqual((await tool.execute({ authors: ['did:plc:author'] }, context({ current: caller }))).posts, [post]);
      assert.deepEqual(JSON.parse(requests[0].init.body), {
        sessionId: 'session-1', authors: ['did:plc:author'], limit: 10,
      });
    }
  } finally {
    globalThis.fetch = original;
    if (dev === undefined) delete process.env.EVE_DEV; else process.env.EVE_DEV = dev;
  }
});

test('schema maps every V2 filter, with bounds and substantive search requirements', async () => {
  const original = globalThis.fetch;
  try {
    const filters = {
      query: 'search', sort: 'top', authors: ['alice.bsky.social'], mentions: ['did:plc:mentioned'],
      domains: ['example.com'], urls: ['https://example.com/a'],
      embeddedAtUris: ['at://did:plc:author/app.bsky.feed.post/a'], hashtags: ['tag'],
      excludeAuthors: ['did:plc:excluded'], excludeMentions: ['bob.bsky.social'],
      excludeDomains: ['other.example'], excludeUrls: ['https://other.example/a'],
      excludeEmbeddedAtUris: ['at://did:plc:author/app.bsky.feed.post/b'], excludeHashtags: ['other'],
      since: '2026-01-01', until: '2026-09-01T00:00:00Z', allTime: true,
      languages: ['en'], excludeLanguages: ['fr'], hasMedia: true, hasVideo: true,
      replyParentUri: 'at://did:plc:author/app.bsky.feed.post/a',
      threadRootUri: 'at://did:plc:author/app.bsky.feed.post/b', excludeReplies: true,
      following: true, queryLanguage: 'ja', cursor: 'earlier', limit: 25,
    };
    assert.deepEqual(tool.inputSchema.parse(filters), filters);
    const requests = mockFetch(() => page(null));
    assert.deepEqual((await tool.execute(filters, context())).cursor, null);
    assert.deepEqual(JSON.parse(requests[0].init.body), { sessionId: 'session-1', postUri, attempt: 3, ...filters });
    assert.equal(tool.inputSchema.safeParse({ repliesOnly: true }).success, true);
    for (const invalid of [{}, { sort: 'top' }, { allTime: true }, { queryLanguage: 'ja' },
      { query: ' ' }, { query: 'x'.repeat(301) }, { query: 'x', limit: 26 },
      { query: 'x', cursor: 'x'.repeat(2049) }, { query: 'x', authors: Array(6).fill('alice.bsky.social') },
      { authors: [] }, { authors: ['did:plc:a'], excludeReplies: true, repliesOnly: true },
      { query: 'x', hashtags: ['#bad'] }, { query: 'x', since: '2026-02-30' },
            { query: 'x', urls: ['https://user:password@example.com'] }, { query: 'x', queryLanguage: 'en' },
      { query: 'x', unexpected: true }]) {
      assert.equal(tool.inputSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
    }
  } finally { globalThis.fetch = original; }
});

test('quota 409 and rejected or misconfigured callback fail closed', async () => {
  const original = globalThis.fetch;
  try {
    for (const response of [new Response(null, { status: 409 }), Response.json({ ok: false }),
      Response.json({ ok: true, posts: 'invalid' })]) {
      const requests = mockFetch(() => response);
      await assert.rejects(tool.execute({ query: 'x' }, context()),
        { message: response.status === 409 ? 'Bluesky search quota exhausted for this dispatch or session' : 'Invalid Bluesky search response' });
      assert.equal(requests.length, 1);
    }
    mockFetch();
    delete process.env.DROPLET_SHARED_SECRET;
    await assert.rejects(tool.execute({ query: 'x' }, context()), { message: 'Bluesky search callback not configured' });
    process.env.DROPLET_SHARED_SECRET = 'shared';
    process.env.DROPLET_CALLBACK_URL = 'http://droplet.example';
    await assert.rejects(tool.execute({ query: 'x' }, context()), { message: 'Bluesky search callback must use HTTPS' });
  } finally { globalThis.fetch = original; }
});

test('429 passes retryAfter without retry, posts, or a completeness claim', async () => {
  const original = globalThis.fetch;
  try {
    const requests = mockFetch(() => Response.json({ retryAfter: 37 }, { status: 429 }));
    assert.deepEqual(await tool.execute({ query: 'x', cursor: 'start' }, context()), {
      posts: [], cursor: 'start', retryAfter: 37, stopped: 'rate_limited',
    });
    assert.equal(requests.length, 1);
    const header = mockFetch(() => new Response(null, { status: 429, headers: { 'retry-after': '15' } }));
    assert.equal((await tool.execute({ query: 'x' }, context())).retryAfter, 15);
    assert.equal(header.length, 1);
  } finally { globalThis.fetch = original; }
});

test('untrusted auth and malformed signed or DM callers cannot fall back to site auth', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected network'); };
  try {
    for (const auth of [{}, { current: { ...signed, authenticator: 'atpotato-droplet-scan-approval' } },
      { initiator: oidc, current: { ...signed, authenticator: 'atpotato-droplet-scan-approval' } },
      { initiator: oidc, current: { ...signed, attributes: { ...signed.attributes, attempt: '0' } } },
      { current: { ...signed, attributes: { ...signed.attributes, postUri: 'at://did:plc:other/app.bsky.feed.post/a' } } },
      { current: { ...dm, attributes: { ...dm.attributes, operatorDid: 'did:plc:other' } } },
      { initiator: oidc, current: { ...dm, attributes: { ...dm.attributes, dmId: '' } } },
      { current: { ...oidc, principalType: 'service' } }, { current: { ...oidc, principalId: '' } },
      { current: { authenticator: 'local-dev', principalId: 'dev' } }]) {
      await assert.rejects(tool.execute({ query: 'x' }, context(auth)),
        { message: 'search_bluesky_posts requires an authenticated caller' });
    }
    await assert.rejects(tool.execute({ query: 'x' }, context({ current: oidc }, '')),
      { message: 'search_bluesky_posts requires an authenticated caller' });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('callback timeout rejects without retrying', async () => {
  const original = globalThis.fetch;
  // AbortSignal.timeout uses an unref'ed timer; keep the isolated test process alive until it fires.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const requests = mockFetch((init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }));
    await assert.rejects(tool.execute({ query: 'x' }, context()), { name: 'TimeoutError' });
    assert.equal(requests.length, 1);
  } finally { clearInterval(keepAlive); globalThis.fetch = original; }
});

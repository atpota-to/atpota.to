import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { db } from '../src/db.js';
import { startCallbackServer, validateBlueskySearch } from '../src/callback.js';

const did = 'did:plc:searchtest';
const uri = (key) => `at://${did}/app.bsky.feed.post/${key}`;
const base = { sessionId: 'search-session', mentions: ['jevbot.bsky.social'], allTime: true, sort: 'top', limit: 3 };
const realFetch = globalThis.fetch;
let upstream;
let calls = [];
globalThis.fetch = async (url, opts) => {
  if (!String(url).startsWith(config.pdsUrl)) return realFetch(url, opts);
  calls.push({ url: new URL(url), opts });
  if (String(url).endsWith('com.atproto.server.createSession')) {
    return Response.json({ did: config.botDid, handle: config.botHandle, accessJwt: 'test-jwt', refreshJwt: 'refresh' });
  }
  return upstream(url, opts);
};
const post = (key = 'sample') => ({
  uri: uri(key), author: { did, handle: 'author.bsky.social', avatar: 'private' },
  record: { text: 'hello', createdAt: '2026-09-25T12:00:00Z', embed: { private: true } },
  likeCount: 4, repostCount: 2, replyCount: 1, quoteCount: 0, embed: { private: true },
});
function seed(key, status = 'sent_to_agent', attempt = 1) {
  db.prepare(`INSERT INTO queue (did, rkey, uri, cid, author_did, text, reason, thread_root,
    root_uri, root_cid, parent_uri, parent_cid, status, source, matched_at, attempts)
    VALUES (?, ?, ?, 'cid', ?, 'question', 'mention', ?, ?, 'cid', ?, 'cid', ?, 'jetstream', ?, ?)`)
    .run(did, key, uri(key), did, uri(key), uri(key), uri(key), status, new Date().toISOString(), attempt);
}
async function serve() {
  const server = startCallbackServer({ stats: { callbackUnauthorized: 0 } });
  await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/internal/bluesky-search` };
}
async function request(url, body, secret = config.sharedSecret) {
  const response = await realFetch(url, { method: 'POST', headers: {
    'x-atpotato-secret': secret, 'content-type': 'application/json',
  }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const ok = () => Response.json({ posts: [post()], cursor: 'next-page', hitsTotal: 15 });

test('validates exact allowlist and types without spending a page', async () => {
  seed('validation');
  upstream = ok;
  const { server, url } = await serve();
  try {
    assert.equal((await request(url, base, 'wrong')).status, 401);
    assert.equal((await realFetch(url, { method: 'POST', body: JSON.stringify(base) })).status, 401);
    const invalid = [null, [], { ...base, sessionId: '' }, { ...base, sessionId: 'x'.repeat(501) },
      { sessionId: 'search-session', sort: 'top' }, { ...base, bogus: true },
      { ...base, mentions: [] }, { ...base, mentions: Array(6).fill('handle') },
      { ...base, mentions: [123] }, { ...base, allTime: 'true' },
      { ...base, limit: 26 }, { ...base, limit: '3' }, { ...base, sort: 'oldest' },
      { ...base, queryLanguage: 'en' }, { ...base, since: 'yesterday' },
            { ...base, since: '2026-02-30' },
      { ...base, since: '2026-09-26T00:00:00Z', until: '2026-09-25T00:00:00Z' },
      { ...base, replyParentUri: 'nope' }, { ...base, embeddedAtUris: ['nope'] },
      { ...base, urls: ['file:///etc/passwd'] },
      { ...base, excludeReplies: true, repliesOnly: true },
      { ...base, postUri: uri('validation') }, { ...base, attempt: 1 },
      { ...base, postUri: uri('validation'), attempt: 0 },
    ];
    for (const body of invalid) assert.equal((await request(url, body)).status, 400, JSON.stringify(body));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bluesky_search_budget_claims').get().n, 0);
    assert.equal((await request(url, { sessionId: 'search-session', excludeAuthors: ['a'] })).status, 400);
    assert.equal((await request(url, { sessionId: 'search-session', hasVideo: true, since: '2026-09-01' })).status, 200);
    assert.equal((await request(url, { sessionId: 'search-session', hashtags: ['你好-世界'], cursor: 'x'.repeat(600) })).status, 200);
    assert.equal((await request(url, { ...base, postUri: uri('validation'), attempt: 1 })).status, 200);
  } finally { await new Promise((r) => server.close(r)); }
});

test('proxy repeats array keys, keeps credentials local, and emits compact ranked posts', async () => {
  calls = [];
  upstream = ok;
  const { server, url } = await serve();
  try {
    const result = await request(url, { ...base, sessionId: 'params', authors: ['one.test', 'two.test'],
      languages: ['en', 'ja'], cursor: 'page-1' });
    assert.deepEqual(result, { status: 200, body: {
      ok: true, posts: [{ uri: uri('sample'), author: { did, handle: 'author.bsky.social' },
        text: 'hello', likeCount: 4, repostCount: 2, replyCount: 1, quoteCount: 0,
        createdAt: '2026-09-25T12:00:00Z', link: `https://bsky.app/profile/${encodeURIComponent(did)}/post/sample` }],
      cursor: 'next-page', hitsTotal: 15, searchRanked: true, truncated: false,
    } });
    const search = calls.find((call) => call.url.pathname.endsWith('searchPostsV2'));
    assert.deepEqual(search.url.searchParams.getAll('authors'), ['one.test', 'two.test']);
    assert.deepEqual(search.url.searchParams.getAll('languages'), ['en', 'ja']);
    assert.equal(search.url.searchParams.get('allTime'), 'true');
    assert.equal(search.url.searchParams.get('sort'), 'top');
    assert.equal(search.url.searchParams.get('cursor'), 'page-1');
    assert.equal(search.opts.headers.authorization, 'Bearer test-jwt');
    assert.equal(search.opts.headers['x-atpotato-secret'], undefined);
    assert.equal(search.url.searchParams.has('sessionId'), false);
  } finally { await new Promise((r) => server.close(r)); }
});

test('session budget is atomic across calls, failures, and server restarts', async () => {
  upstream = ok;
  let { server, url } = await serve();
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => request(url, { ...base, sessionId: 'parallel-session' })));
    assert.equal(results.filter((r) => r.status === 200).length, 3);
    assert.equal(results.filter((r) => r.status === 409).length, 5);
    assert.equal(db.prepare('SELECT pages_claimed FROM bluesky_search_session_budget_claims WHERE session_id = ?')
      .get('parallel-session').pages_claimed, 3);
  } finally { await new Promise((r) => server.close(r)); }
  ({ server, url } = await serve());
  try {
    assert.equal((await request(url, { ...base, sessionId: 'parallel-session' })).status, 409);
  } finally { await new Promise((r) => server.close(r)); }
});

test('post budget checks queue status and attempt, shared across sessions', async () => {
  seed('bound');
  seed('inactive', 'matched');
  upstream = ok;
  const { server, url } = await serve();
  try {
    const body = { ...base, sessionId: 'post-worker', postUri: uri('bound'), attempt: 1 };
    assert.equal((await request(url, { ...body, postUri: uri('inactive') })).status, 409);
    assert.equal((await request(url, { ...body, attempt: 2 })).status, 409);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => request(url, { ...body, sessionId: `worker-${i}` })));
    assert.equal(results.filter((r) => r.status === 200).length, 3);
    assert.equal(results.filter((r) => r.status === 409).length, 3);
    db.prepare("UPDATE queue SET status = 'drafted' WHERE uri = ?").run(uri('bound'));
    assert.equal((await request(url, body)).status, 409);
    db.prepare("UPDATE queue SET attempts = 2, status = 'sent_to_agent' WHERE uri = ?").run(uri('bound'));
    assert.equal((await request(url, { ...body, attempt: 1 })).status, 409);
    assert.equal((await request(url, { ...body, attempt: 2 })).status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bluesky_search_session_budget_claims WHERE session_id = ?')
      .get(body.sessionId).n, 0);
  } finally { await new Promise((r) => server.close(r)); }
});

test('429 retry-after, upstream errors, oversized and malformed replies are safe', async () => {
  const { server, url } = await serve();
  try {
    const scenario = [
      [() => new Response('secret upstream detail', { status: 429, headers: { 'retry-after': '42' } }), 429, { error: 'UpstreamRateLimited', retryAfter: 42 }],
      [() => new Response('secret upstream detail', { status: 503 }), 502, { error: 'UpstreamUnavailable' }],
      [() => new Response('x'.repeat(512 * 1024 + 1)), 502, { error: 'UpstreamUnavailable' }],
      [() => Response.json({ posts: [{ ...post(), author: {} }] }), 502, { error: 'UpstreamUnavailable' }],
    ];
    for (let i = 0; i < scenario.length; i++) {
      const [reply, status, body] = scenario[i];
      upstream = reply;
      assert.deepEqual(await request(url, { ...base, sessionId: `failure-${i}` }), { status, body });
      assert.equal(db.prepare('SELECT pages_claimed FROM bluesky_search_session_budget_claims WHERE session_id = ?')
        .get(`failure-${i}`).pages_claimed, 1);
    }
  } finally { await new Promise((r) => server.close(r)); }
});

test('validation does not forward session or routing fields', () => {
  assert.deepEqual(validateBlueskySearch({ ...base, postUri: uri('bound'), attempt: 2 }).params, {
    mentions: ['jevbot.bsky.social'], allTime: true, sort: 'top', limit: 3,
  });
});

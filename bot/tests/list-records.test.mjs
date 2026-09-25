import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';

execFileSync('node', ['node_modules/typescript/bin/tsc', '--ignoreConfig',
  'agent/tools/list_records.ts', '--outDir', '.eve/list-records-test', '--rootDir', 'agent',
  '--module', 'esnext', '--moduleResolution', 'bundler', '--target', 'es2022',
  '--skipLibCheck', '--types', 'node'], { cwd: new URL('..', import.meta.url) });
const source = readFileSync(new URL('../.eve/list-records-test/tools/list_records.js', import.meta.url), 'utf8')
  .replace('from "eve/tools"', `from "data:text/javascript,${encodeURIComponent('export const defineTool = (tool) => tool;')}"`);
writeFileSync(new URL('../.eve/list-records-test/tools/list_records.mjs', import.meta.url), source);
const tool = (await import('../.eve/list-records-test/tools/list_records.mjs')).default;

const postUri = 'at://did:plc:requester/app.bsky.feed.post/post1';
const caller = { authenticator: 'atpotato-droplet', principalType: 'user',
  principalId: 'did:plc:requester', attributes: { did: 'did:plc:requester', postUri, attempt: '3' } };
const ctx = { session: { id: 'session-1', auth: { initiator: caller, current: caller } } };
const input = { identifier: 'did:plc:test', collection: 'app.example.item' };
const record = { uri: 'at://did:plc:test/app.example.item/a',
  value: { $type: 'app.example.item', text: 'full value', nested: { deep: ['retained'] } } };
const page = (records = [record], cursor = undefined) => Response.json({ result: {
  structuredContent: { ok: true, records, ...(cursor ? { cursor } : {}) },
} });

function mockFetch(aturi, claim = () => Response.json({ ok: true })) {
  process.env.DROPLET_CALLBACK_URL = 'https://droplet.example/draft';
  process.env.DROPLET_SHARED_SECRET = 'shared';
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url) === 'https://droplet.example/internal/list-records-budget/claim') return claim(init);
    assert.equal(String(url), 'https://aturi.to/api/mcp');
    assert.equal(init.headers['x-atpotato-secret'], undefined);
    return aturi(init);
  };
  return requests;
}

test('claims before fetching; returns full values, cursor and explicit partial/end status', async () => {
  const original = globalThis.fetch;
  try {
    let calls = 0;
    const requests = mockFetch((init) => {
      const args = JSON.parse(init.body).params.arguments;
      assert.deepEqual(args, { identifier: input.identifier, collection: input.collection,
        limit: 50, reverse: false, ...(calls ? { cursor: 'next' } : {}) });
      return calls++ ? page() : page([record], 'next');
    });
    const first = await tool.execute(input, ctx);
    assert.deepEqual(first, { records: [record], cursor: 'next', complete: false, partial: true,
      retryAfter: null, stopped: 'page' });
    const second = await tool.execute({ ...input, cursor: first.cursor }, ctx);
    assert.deepEqual(second, { records: [record], cursor: null, complete: true, partial: false,
      retryAfter: null, stopped: 'end' });
    assert.deepEqual(requests.map((r) => r.url), [
      'https://droplet.example/internal/list-records-budget/claim', 'https://aturi.to/api/mcp',
      'https://droplet.example/internal/list-records-budget/claim', 'https://aturi.to/api/mcp',
    ]);
    for (const request of requests.filter((r) => r.url.includes('budget/claim'))) {
      assert.equal(request.init.headers['x-atpotato-secret'], 'shared');
      assert.equal(request.init.method, 'POST');
      assert.deepEqual(JSON.parse(request.init.body), { sessionId: 'session-1', postUri, attempt: 3, limit: 50 });
    }
  } finally { globalThis.fetch = original; }
});

test('claims up to 10 pages / 1,000 requested records per Bluesky attempt, then stops without approval', async () => {
  const original = globalThis.fetch;
  try {
    let claims = 0;
    let reserved = 0;
    let pages = 0;
    const requests = mockFetch((init) => {
      const args = JSON.parse(init.body).params.arguments;
      assert.deepEqual(args, { ...input, limit: 100, reverse: false,
        ...(pages ? { cursor: `next-${pages}` } : {}) });
      return page([record], `next-${++pages}`);
    }, (init) => {
      const claim = JSON.parse(init.body);
      assert.deepEqual(claim, { sessionId: 'session-1', postUri, attempt: 3, limit: 100 });
      claims++;
      if (claims > 10 || reserved + claim.limit > 1_000) return new Response(null, { status: 409 });
      reserved += claim.limit;
      return Response.json({ ok: true });
    });
    let cursor;
    for (let i = 0; i < 10; i++) {
      const result = await tool.execute({ ...input, limit: 100, ...(cursor ? { cursor } : {}) }, ctx);
      assert.equal(result.stopped, 'page');
      assert.equal(result.complete, false);
      assert.equal(result.partial, true);
      assert.equal(result.cursor, `next-${i + 1}`);
      cursor = result.cursor;
    }
    assert.equal(reserved, 1_000);
    await assert.rejects(tool.execute({ ...input, limit: 100, cursor }, ctx),
      { message: 'list_records budget exhausted for this dispatch or session' });
    assert.equal(claims, 11);
    assert.equal(pages, 10);
    assert.equal(requests.filter((r) => r.url === 'https://aturi.to/api/mcp').length, 10);
    assert.ok(requests.every((r) => r.url === 'https://aturi.to/api/mcp' ||
      r.url === 'https://droplet.example/internal/list-records-budget/claim'));
  } finally { globalThis.fetch = original; }
});

test('page claim ceiling also applies when fewer than 1,000 records were requested', async () => {
  const original = globalThis.fetch;
  try {
    let claims = 0;
    const requests = mockFetch(() => page([record], `next-${claims}`), () =>
      ++claims <= 10 ? Response.json({ ok: true }) : new Response(null, { status: 409 }));
    let cursor;
    for (let i = 0; i < 10; i++) {
      cursor = (await tool.execute({ ...input, limit: 25, ...(cursor ? { cursor } : {}) }, ctx)).cursor;
    }
    await assert.rejects(tool.execute({ ...input, limit: 25, cursor }, ctx),
      { message: 'list_records budget exhausted for this dispatch or session' });
    assert.equal(requests.filter((r) => r.url === 'https://aturi.to/api/mcp').length, 10);
    assert.equal(requests.filter((r) => r.url.includes('budget/claim'))
      .reduce((sum, r) => sum + JSON.parse(r.init.body).limit, 0), 275);
  } finally { globalThis.fetch = original; }
});

test('signed initiator retains queue-bound claim when current auth is scan approval', async () => {
  const original = globalThis.fetch;
  try {
    const requests = mockFetch(() => page());
    await tool.execute(input, { session: { id: 'session-1', auth: { initiator: caller,
      current: { authenticator: 'atpotato-droplet-scan-approval', principalType: 'user',
        principalId: 'did:plc:admin' } } } });
    assert.deepEqual(JSON.parse(requests[0].init.body), { sessionId: 'session-1', postUri, attempt: 3, limit: 50 });
  } finally { globalThis.fetch = original; }
});

test('passes limit, cursor and reverse only after reserving the requested limit', async () => {
  const original = globalThis.fetch;
  try {
    const requests = mockFetch((init) => {
      assert.deepEqual(JSON.parse(init.body).params.arguments, { ...input,
        cursor: 'older', limit: 100, reverse: true });
      return page();
    });
    await tool.execute({ ...input, cursor: 'older', limit: 100, reverse: true }, ctx);
    assert.equal(JSON.parse(requests[0].init.body).limit, 100);
    assert.equal(requests.length, 2);
    assert.equal(tool.inputSchema.safeParse({ ...input, limit: 101 }).success, false);
    assert.equal(tool.inputSchema.safeParse({ ...input, limit: 0 }).success, false);
  } finally { globalThis.fetch = original; }
});

test('operator DMs and website auth reserve by session before returning full records', async () => {
  const original = globalThis.fetch;
  const originalDev = process.env.EVE_DEV;
  try {
    process.env.EVE_DEV = '1';
    const dm = { authenticator: 'atpotato-droplet-dm', principalType: 'user',
      principalId: 'did:plc:operator', attributes: { operatorDid: 'did:plc:operator', dmId: 'dm-1' } };
    for (const website of [dm,
      { authenticator: 'oidc', principalType: 'user', principalId: 'user-1' },
      { authenticator: 'oidc', principalType: 'runtime', principalId: 'runtime-1' },
      { authenticator: 'local-dev', principalType: 'user', principalId: 'local-1' }]) {
      const requests = mockFetch(() => page());
      const result = await tool.execute({ ...input, limit: 100 },
        { session: { id: 'session-1', auth: { current: website } } });
      assert.deepEqual(result.records, [record]);
      assert.deepEqual(requests.map((r) => r.url), [
        'https://droplet.example/internal/list-records-budget/claim', 'https://aturi.to/api/mcp',
      ]);
      assert.deepEqual(JSON.parse(requests[0].init.body), { sessionId: 'session-1', limit: 100 });
      assert.equal(requests[0].init.headers['x-atpotato-secret'], 'shared');
    }
  } finally {
    globalThis.fetch = original;
    if (originalDev === undefined) delete process.env.EVE_DEV;
    else process.env.EVE_DEV = originalDev;
  }
});

test('untrusted or malformed auth cannot reach network or fall back to website auth', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected network'); };
  try {
    const oidc = { authenticator: 'oidc', principalType: 'user', principalId: 'user-1' };
    const dm = { authenticator: 'atpotato-droplet-dm', principalType: 'user',
      principalId: 'did:plc:operator', attributes: { operatorDid: 'did:plc:operator', dmId: 'dm-1' } };
    for (const auth of [{}, { current: { ...caller, authenticator: 'atpotato-droplet-scan-approval' } },
      { initiator: oidc, current: { ...caller, authenticator: 'atpotato-droplet-scan-approval' } },
      { initiator: oidc, current: { ...caller, attributes: { ...caller.attributes, attempt: '0' } } },
      { current: { ...caller, attributes: { ...caller.attributes, postUri: 'at://did:plc:other/app.bsky.feed.post/a' } } },
      { current: { ...caller, attributes: { ...caller.attributes, attempt: '0' } } },
      { initiator: oidc, current: { ...dm, attributes: { ...dm.attributes, operatorDid: 'did:plc:other' } } },
      { current: { ...dm, attributes: { ...dm.attributes, dmId: '' } } },
      { current: { ...dm, attributes: { ...dm.attributes, dmId: 'x'.repeat(301) } } },
      { current: { ...dm, principalId: 'not-a-did' } },
      { current: { ...oidc, principalType: 'service' } },
      { current: { ...oidc, principalId: '' } }]) {
      await assert.rejects(tool.execute(input, { session: { id: 'session-1', auth } }),
        { message: 'list_records requires an authenticated caller' });
    }
    await assert.rejects(tool.execute(input, { session: { id: '', auth: { current: oidc } } }),
      { message: 'list_records requires an authenticated caller' });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('session budget rejection prevents Aturi fetches for DMs and website callers', async () => {
  const original = globalThis.fetch;
  try {
    for (const caller of [
      { authenticator: 'atpotato-droplet-dm', principalType: 'user',
        principalId: 'did:plc:operator', attributes: { operatorDid: 'did:plc:operator', dmId: 'dm-1' } },
      { authenticator: 'oidc', principalType: 'user', principalId: 'user-1' },
    ]) {
      const requests = mockFetch(() => { throw new Error('Aturi called'); },
        () => new Response(null, { status: 409 }));
      await assert.rejects(tool.execute(input, { session: { id: 'session-1', auth: { current: caller } } }),
        { message: 'list_records budget exhausted for this dispatch or session' });
      assert.deepEqual(JSON.parse(requests[0].init.body), { sessionId: 'session-1', limit: 50 });
      assert.equal(requests.length, 1);
    }
  } finally { globalThis.fetch = original; }
});

test('local-dev auth requires a local server flag', async () => {
  const original = globalThis.fetch;
  const env = { EVE_DEV: process.env.EVE_DEV, VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV };
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected network'); };
  const local = { session: { id: 'session-1', auth: { current: {
    authenticator: 'local-dev', principalType: 'user', principalId: 'local-1',
  } } } };
  try {
    delete process.env.EVE_DEV;
    process.env.VERCEL = '1';
    process.env.VERCEL_ENV = 'production';
    await assert.rejects(tool.execute(input, local), { message: 'list_records requires an authenticated caller' });
    delete process.env.VERCEL;
    process.env.VERCEL_ENV = 'development';
    await assert.rejects(tool.execute(input, local), { message: 'list_records requires an authenticated caller' });
    assert.equal(calls, 0);
    process.env.VERCEL = '1';
    const requests = mockFetch(() => page());
    assert.deepEqual((await tool.execute(input, local)).records, [record]);
    assert.deepEqual(JSON.parse(requests[0].init.body), { sessionId: 'session-1', limit: 50 });
  } finally {
    globalThis.fetch = original;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('409, non-200, malformed approval, missing secret and HTTP callback never fetch Aturi', async () => {
  const original = globalThis.fetch;
  try {
    for (const response of [new Response(null, { status: 409 }),
      Response.json({ ok: true }, { status: 201 }), Response.json({ ok: false })]) {
      const requests = mockFetch(() => { throw new Error('Aturi called'); }, () => response);
      await assert.rejects(tool.execute(input, ctx),
        { message: response.status === 409 ? 'list_records budget exhausted for this dispatch or session' : 'list_records budget claim not accepted' });
      assert.equal(requests.length, 1);
    }
    delete process.env.DROPLET_SHARED_SECRET;
    await assert.rejects(tool.execute(input, ctx), { message: 'list_records budget callback not configured' });
    process.env.DROPLET_SHARED_SECRET = 'shared';
    process.env.DROPLET_CALLBACK_URL = 'http://droplet.example';
    await assert.rejects(tool.execute(input, ctx), { message: 'list_records budget callback must use HTTPS' });
  } finally { globalThis.fetch = original; }
});

test('429 returns retryAfter without retrying or returning records', async () => {
  const original = globalThis.fetch;
  try {
    const requests = mockFetch(() => new Response(null, { status: 429, headers: { 'retry-after': '42' } }));
    assert.deepEqual(await tool.execute({ ...input, cursor: 'start' }, ctx), {
      records: [], cursor: 'start', complete: false, partial: true, retryAfter: 42, stopped: 'rate_limited',
    });
    assert.equal(requests.length, 2);
  } finally { globalThis.fetch = original; }
});

test('rejects malformed structuredContent, records, excess records, and stuck cursors', async () => {
  const original = globalThis.fetch;
  try {
    for (const [response, message] of [
      [Response.json({ result: { content: [] } }), 'Invalid Aturi list_records page'],
      [page([{ uri: record.uri, value: { secret: 'do not leak' } }, null]), 'Invalid Aturi record'],
      [page(Array.from({ length: 51 }, () => record)), 'Invalid Aturi list_records page'],
      [page([], 'next'), 'Aturi cursor did not advance'],
      [page([record], 'start'), 'Aturi cursor did not advance'],
    ]) {
      mockFetch(() => response);
      await assert.rejects(tool.execute({ ...input, cursor: 'start' }, ctx), { message });
    }
  } finally { globalThis.fetch = original; }
});

test('bounds streamed Aturi response to 64 KiB', async () => {
  const original = globalThis.fetch;
  try {
    mockFetch(() => new Response(new Uint8Array(65_537)));
    await assert.rejects(tool.execute(input, ctx), { message: 'Aturi response exceeds 64 KiB; try a smaller limit' });
  } finally { globalThis.fetch = original; }
});

test('accepts a bounded SSE MCP result', async () => {
  const original = globalThis.fetch;
  try {
    mockFetch(() => new Response(`event: message\ndata: ${JSON.stringify({ result: { structuredContent: {
      ok: true, records: [record], cursor: 'next',
    } } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
    assert.deepEqual((await tool.execute(input, ctx)).records, [record]);
  } finally { globalThis.fetch = original; }
});

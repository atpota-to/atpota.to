import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';

execFileSync('node', ['node_modules/typescript/bin/tsc', '--ignoreConfig',
  'agent/tools/scan_collection.ts', '--outDir', '.eve/collection-scan-test', '--rootDir', 'agent',
  '--module', 'esnext', '--moduleResolution', 'bundler', '--target', 'es2022',
  '--skipLibCheck', '--types', 'node'], { cwd: new URL('..', import.meta.url) });
const { initialScan, scanBatch, scanResult } = await import('../.eve/collection-scan-test/lib/collection-scan.js');
const toolSource = readFileSync(new URL('../.eve/collection-scan-test/tools/scan_collection.js', import.meta.url), 'utf8')
  .replace('from "eve/tools"', `from "data:text/javascript,${encodeURIComponent('export const defineWorkflowTool = (tool) => tool;')}"`)
  .replace('from "../lib/collection-scan"', 'from "../lib/collection-scan.js"');
writeFileSync(new URL('../.eve/collection-scan-test/tools/scan_collection.mjs', import.meta.url), toolSource);
const scanTool = (await import('../.eve/collection-scan-test/tools/scan_collection.mjs')).default;

function pages(...values) {
  let calls = 0;
  const fetchPage = async (_cursor, limit) => {
    const index = calls++;
    return { records: values[index].slice(0, limit).map(([uri, value]) => ({ uri, value })),
      cursor: index < values.length - 1 ? `cursor-${index}` : undefined, bytes: 100 };
  };
  return { fetchPage, calls: () => calls };
}
const record = (name, createdAt) => [`at://did:plc:test/app.example.item/${name}`, createdAt === undefined ? {} : { createdAt }];
const options = { timestampField: 'createdAt', maxRecords: 1000, maxPages: 10 };
const postUri = 'at://did:plc:requester/app.bsky.feed.post/post1';
const caller = { authenticator: 'atpotato-droplet', principalType: 'user',
  principalId: 'did:plc:requester', attributes: { did: 'did:plc:requester', postUri, attempt: '3' } };
const ctx = { session: { id: 'session-1', auth: { initiator: caller, current: caller } },
  ask: async () => { throw new Error('unexpected approval'); } };
const input = { identifier: 'did:plc:test', collection: 'app.example.item', timestampField: 'createdAt' };

function withClaim(fetchAturi) {
  process.env.DROPLET_CALLBACK_URL = 'https://droplet.example/draft';
  process.env.DROPLET_SHARED_SECRET = 'shared';
  return async (url, init) => {
    if (String(url) === 'https://droplet.example/internal/scan-budget/claim') {
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['x-atpotato-secret'], 'shared');
      assert.deepEqual(JSON.parse(init.body), { sessionId: 'session-1', postUri, attempt: 3 });
      return Response.json({ ok: true });
    }
    assert.equal(String(url), 'https://aturi.to/api/mcp');
    assert.equal(init.headers['x-atpotato-secret'], undefined);
    return fetchAturi(url, init);
  };
}

test('complete when pagination ends; unknown dates are counted and samples are bounded', async () => {
  const fixture = pages([record('a', '2026-01-01T00:00:00Z'), record('b')]);
  const state = await scanBatch(initialScan(), fixture.fetchPage, options);
  assert.equal(state.scanned, 2);
  assert.equal(state.unknownTimestamp, 1);
  assert.equal(state.matching, 2);
  assert.deepEqual(state.timestampFields.createdAt, { present: 1, valid: 1 });
  assert.equal(scanResult(state).complete, true);
  assert.equal(fixture.calls(), 1);
  assert.equal(JSON.stringify(scanResult(state)).includes('value'), false);
});

test('stops at the default page boundary and continues only when caller approves', async () => {
  const fixture = pages(...Array.from({ length: 12 }, (_, i) => [record(String(i), '2026-01-01T00:00:00Z')]));
  const first = await scanBatch(initialScan(), fixture.fetchPage, options);
  assert.equal(first.pages, 10);
  assert.equal(first.stopped, 'pages');
  assert.equal(scanResult(first).complete, false);
  assert.equal(fixture.calls(), 10);
  const approved = true;
  const final = approved ? await scanBatch(first, fixture.fetchPage, { ...options, maxRecords: 10000 }) : first;
  assert.equal(final.scanned, 12);
  assert.equal(final.sample.length, 10);
  assert.equal(scanResult(final).complete, true);
  assert.equal(fixture.calls(), 12);
});

test('record cap leaves a partial scan and never fetches an extra page', async () => {
  const fixture = pages([record('a')], [record('b')]);
  const state = await scanBatch(initialScan(), fixture.fetchPage, { ...options, maxRecords: 1 });
  assert.equal(state.stopped, 'records');
  assert.equal(state.exhausted, false);
  assert.equal(fixture.calls(), 1);
});

test('since scans every page even when older records come before newer ones', async () => {
  const fixture = pages([record('old', '2020-01-01T00:00:00Z'), record('unknown')],
    [record('new', '2026-01-01T00:00:00Z')]);
  const state = await scanBatch(initialScan(), fixture.fetchPage,
    { ...options, since: '2025-01-01T00:00:00Z' });
  assert.equal(state.matching, 1);
  assert.equal(state.beforeSince, 1);
  assert.equal(state.unknownTimestamp, 1);
  assert.equal(state.sample[0].uri.endsWith('/new'), true);
  assert.equal(fixture.calls(), 2);
});

test('a 429 preserves partial counts and stops without another fetch', async () => {
  let calls = 0;
  const state = await scanBatch(initialScan(), async () => {
    if (++calls === 1) return { records: [{ uri: record('first')[0], value: { createdAt: '2026-01-01T00:00:00Z' } }], cursor: 'next', bytes: 120 };
    const { RateLimitError } = await import('../.eve/collection-scan-test/lib/collection-scan.js');
    throw new RateLimitError(25);
  }, options);
  assert.equal(calls, 2);
  assert.equal(state.scanned, 1);
  assert.equal(state.pages, 1);
  assert.equal(state.cursor, 'next');
  assert.equal(state.bytes, 120);
  assert.deepEqual({ stopped: scanResult(state).stopped, complete: scanResult(state).complete,
    retryAfter: scanResult(state).retryAfter }, { stopped: 'rate_limited', complete: false, retryAfter: 25 });
});

test('HTTP 429 returns a partial result with Retry-After and never requests approval', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  let asked = 0;
  globalThis.fetch = withClaim(async () => {
    calls++;
    if (calls === 2) return new Response(null, { status: 429, headers: { 'retry-after': '42' } });
    return Response.json({ result: { structuredContent: { ok: true, records: [
      { uri: record('first')[0], value: { createdAt: '2026-01-01T00:00:00Z', privateContent: 'do not leak' } },
    ], cursor: 'next' } } });
  });
  try {
    const result = await scanTool.execute(input, { ...ctx, ask: async () => { asked++; throw new Error('approval requested'); } });
    assert.equal(calls, 2);
    assert.equal(asked, 0);
    assert.equal(result.scanned, 1);
    assert.equal(result.complete, false);
    assert.equal(result.stopped, 'rate_limited');
    assert.equal(result.retryAfter, 42);
    assert.equal(JSON.stringify(result).includes('privateContent'), false);
    assert.equal(JSON.stringify(result).includes('do not leak'), false);
  } finally { globalThis.fetch = previousFetch; }
});

test('rejects malformed upstream pages without including source content in the error', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = withClaim(async () => Response.json({ result: { structuredContent: {
    ok: true, records: [{ uri: record('first')[0], value: { secret: 'do not leak' } }, null],
  } } }));
  try {
    await assert.rejects(scanTool.execute(input, ctx),
    { message: 'Invalid Aturi record' });
  } finally { globalThis.fetch = previousFetch; }
});

test('missing or untrusted caller never claims or scans', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('network must not be called'); };
  try {
    for (const auth of [
      {},
      { current: { ...caller, authenticator: 'atpotato-droplet-scan-approval' } },
      { current: { ...caller, principalId: 'did:plc:other' } },
      { current: { ...caller, attributes: { ...caller.attributes, attempt: '0' } } },
      { current: { ...caller, attributes: { ...caller.attributes, postUri: 'at://did:plc:other/app.bsky.feed.post/x' } } },
    ]) {
      await assert.rejects(scanTool.execute(input, { ...ctx, session: { id: 'session-1', auth } }),
        { message: 'Scan requires an authenticated Bluesky post' });
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('denied, spent, or unavailable claim prevents all Aturi requests', async () => {
  const previousFetch = globalThis.fetch;
  process.env.DROPLET_CALLBACK_URL = 'https://droplet.example/draft';
  process.env.DROPLET_SHARED_SECRET = 'shared';
  let claims = 0;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://droplet.example/internal/scan-budget/claim');
    claims++;
    return new Response(null, { status: 409 });
  };
  try {
    await assert.rejects(scanTool.execute(input, ctx), { message: 'Scan budget spent for this turn' });
    assert.equal(claims, 1);
    globalThis.fetch = async (url) => {
      assert.equal(String(url), 'https://droplet.example/internal/scan-budget/claim');
      return Response.json({ ok: false });
    };
    await assert.rejects(scanTool.execute(input, ctx), { message: 'Scan budget claim not accepted' });
    delete process.env.DROPLET_SHARED_SECRET;
    await assert.rejects(scanTool.execute(input, ctx), { message: 'Scan budget callback not configured' });
  } finally { globalThis.fetch = previousFetch; }
});

test('granted claim scans once and is not repeated after approval', async () => {
  const previousFetch = globalThis.fetch;
  let claims = 0;
  let scans = 0;
  globalThis.fetch = withClaim(async () => {
    scans++;
    return Response.json({ result: { structuredContent: { ok: true,
      records: [{ uri: record(String(scans))[0], value: {} }],
      ...(scans <= 10 ? { cursor: `cursor-${scans}` } : {}),
    } } });
  });
  const claimFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    if (String(args[0]).includes('/internal/scan-budget/claim')) claims++;
    return claimFetch(...args);
  };
  let asked = 0;
  const resumed = { ...ctx, session: { ...ctx.session, auth: { initiator: caller, current: {
    authenticator: 'atpotato-droplet-scan-approval', principalType: 'user',
    principalId: 'did:plc:admin', attributes: { postUri: 'at://did:plc:admin/app.bsky.feed.post/other', attempt: '99' },
  } } }, ask: async () => { asked++; return { optionId: 'approve' }; } };
  try {
    const result = await scanTool.execute(input, resumed);
    assert.equal(claims, 1);
    assert.equal(scans, 11);
    assert.equal(asked, 1);
    assert.equal(result.scanned, 11);
    assert.equal(result.complete, true);
  } finally { globalThis.fetch = previousFetch; }
});

test('time and byte limits report incomplete even before the first fetch', async () => {
  const fixture = pages([record('a')]);
  const state = await scanBatch({ ...initialScan(), bytes: 24_000_000 }, fixture.fetchPage, options);
  assert.equal(scanResult(state).complete, false);
  assert.equal(state.stopped, 'bytes');
  assert.equal(fixture.calls(), 0);
});

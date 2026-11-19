// Tangled's knots: asked once a week, kept, and never counted as hosts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askHost, createKnotCheck, isKnotVersion, RECHECK_MS, RETRY_MS } from '../src/knots.js';

test('a knot says so in its version; a PDS, whatever software, does not', () => {
  assert.equal(isKnotVersion('knot 2.0.0'), true);
  assert.equal(isKnotVersion('Knot 1.20.0'), true);
  for (const v of ['0.5.29', 'tranquil 0.7.1', 'cirrus 0.13.0', 'cocoon v0.11.0', 'knotless 1.0', '', null]) assert.equal(isKnotVersion(v), false, String(v));
});

/** Hosts that answer /xrpc/_health with these versions; anything else doesn't answer. */
function hosts(versions) {
  const asked = [];
  const fetchImpl = async (url) => {
    const host = new URL(url).hostname;
    asked.push(host);
    return host in versions ? Response.json({ version: versions[host] }) : new Response('nope', { status: 502 });
  };
  return { fetchImpl, asked };
}
const census = (...names) => names.map((hostname) => ({ hostname, status: 'active', accounts: 1, seq: 1 }));

test('askHost: what a host says it is, or null', async () => {
  const { fetchImpl } = hosts({ 'knot1.tangled.sh': 'knot 2.0.0', 'eurosky.social': '0.5.29' });
  assert.deepEqual(await askHost(fetchImpl, 'knot1.tangled.sh'), { knot: true, version: 'knot 2.0.0' });
  assert.deepEqual(await askHost(fetchImpl, 'eurosky.social'), { knot: false, version: '0.5.29' });
  assert.equal(await askHost(fetchImpl, 'down.example'), null);
});

test('reads what it knew, asks independent hosts that are due, writes the answers, and asks again a week on', async () => {
  let t = Date.parse('2026-10-31T04:00:00Z');
  const { fetchImpl, asked } = hosts({ 'knot1.tangled.sh': 'knot 2.0.0', 'eurosky.social': '0.5.29', 'git.oppi.li': 'knot 1.2.0' });
  const written = [];
  const stored = [{ hostname: 'git.oppi.li', knot: true, checked_at: new Date(t - 86_400_000).toISOString() }];
  const k = createKnotCheck({ fetchImpl, now: () => t, upsert: async (table, conflict, rows) => written.push(...rows.map((r) => ({ table, ...r }))), getAll: async () => stored });
  assert.equal(k.ready, false);
  await k.check([...census('knot1.tangled.sh', 'eurosky.social', 'git.oppi.li', 'a.host.bsky.network', 'down.example'), { hostname: 'idle.example', status: 'idle', accounts: 1 }]);
  assert.equal(k.ready, true);
  // git.oppi.li was asked yesterday; Bluesky's and idle hosts aren't asked
  assert.deepEqual(asked.sort(), ['down.example', 'eurosky.social', 'knot1.tangled.sh']);
  assert.deepEqual(written.map((r) => [r.table, r.hostname, r.knot, r.version]).sort(), [['atmosphere_host_kind', 'eurosky.social', false, '0.5.29'], ['atmosphere_host_kind', 'knot1.tangled.sh', true, 'knot 2.0.0']]);
  assert.deepEqual([k.isKnot('knot1.tangled.sh'), k.isKnot('git.oppi.li'), k.isKnot('eurosky.social'), k.isKnot('down.example')], [true, true, false, false]);
  // nothing's due straight after; the one that didn't answer is asked a day on, the rest a week on
  asked.length = 0;
  await k.check(census('knot1.tangled.sh', 'eurosky.social', 'down.example'));
  assert.deepEqual(asked, []);
  t += RETRY_MS + 1;
  await k.check(census('knot1.tangled.sh', 'eurosky.social', 'down.example'));
  assert.deepEqual(asked, ['down.example']);
  t += RECHECK_MS;
  asked.length = 0;
  await k.check(census('knot1.tangled.sh', 'eurosky.social', 'git.oppi.li'));
  assert.deepEqual(asked.sort(), ['eurosky.social', 'git.oppi.li', 'knot1.tangled.sh']);
});

test('asks nobody until it has read what it knew, and at most perCensus at a time', async () => {
  const { fetchImpl, asked } = hosts({});
  let fail = true;
  const k = createKnotCheck({ fetchImpl, getAll: async () => { if (fail) throw new Error('down'); return []; }, perCensus: 2, log: { info() {}, warn() {} } });
  await k.check(census('a.example', 'b.example', 'c.example'));
  assert.deepEqual(asked, []);
  assert.equal(k.ready, false);
  fail = false;
  await k.check(census('a.example', 'b.example', 'c.example'));
  assert.equal(asked.length, 2);
  // without Supabase it's ready straight away and keeps the answers itself
  assert.equal(createKnotCheck({ fetchImpl }).ready, true);
});

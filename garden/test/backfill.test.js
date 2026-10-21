// The reconcile against a fake network (relay, PLC, did:web, PDSes) and a fake index.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackfill, didDocumentUrl, pdsOf, RETRY_FAILED_MS } from '../src/backfill.js';
import { CHUNK } from '../src/indexer.js';
import { PATCH, SPROUT, TEND } from '../src/records.js';
import { createStore } from '../src/state.js';

const quiet = { info() {}, warn() {}, error() {} };
const RELAY = 'https://relay.test';
const PLC = 'https://plc.test';
const CID = 'bafyreiabcdefghijklmnopqrstuvwxyz234567';
const ALICE = 'did:plc:alice';
const BOB = 'did:plc:bob';
const CAROL = 'did:web:carol.example%3A8443';
const GONE = 'did:plc:gone';
const T0 = Date.parse('2026-10-20T12:00:00Z');

const rkey = (n) => `3m4${String(n).padStart(10, 'a')}`;
const record = (collection, n) =>
  collection === PATCH
    ? { $type: PATCH, name: `patch ${n}`, cols: 8, rows: 4, createdAt: '2026-10-01T00:00:00Z' }
    : collection === SPROUT
      ? { $type: SPROUT, patch: { uri: `at://${ALICE}/${PATCH}/self`, cid: CID }, kind: 'seed', plot: n, createdAt: '2026-10-02T00:00:00Z' }
      : { $type: TEND, subject: { uri: `at://${ALICE}/${SPROUT}/${rkey(1)}`, cid: CID }, action: 'water', createdAt: '2026-10-03T00:00:00Z' };
const entry = (did, collection, n) => ({ uri: `at://${did}/${collection}/${rkey(n)}`, cid: CID, value: record(collection, n) });
const plcDoc = (did, pds) => ({ id: did, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pds }] });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * repos: { [did]: { doc?, docStatus?, pds, records: { [collection]: entries[] }, fail?: { [collection]: Response } } }
 * relay: { [collection]: [[dids page 1], [dids page 2], ...] }
 */
function world({ repos = {}, relay = {}, index = [], relayDown = false }) {
  const requests = [];
  const fetch = async (url) => {
    requests.push(url);
    const u = new URL(url);
    if (u.origin === RELAY) {
      if (relayDown) return json({ error: 'InternalServerError' }, 502);
      const pages = relay[u.searchParams.get('collection')] ?? [[]];
      const i = Number(u.searchParams.get('cursor') ?? 0);
      return json({ repos: pages[i].map((did) => ({ did, head: 'x', rev: 'y' })), ...(i + 1 < pages.length ? { cursor: String(i + 1) } : {}) });
    }
    if (u.origin === PLC) {
      const did = decodeURIComponent(u.pathname.slice(1));
      const r = repos[did];
      if (!r || r.docStatus) return json({ message: 'DID not registered' }, r?.docStatus ?? 404);
      return json(r.doc ?? plcDoc(did, r.pds));
    }
    if (u.pathname === '/.well-known/did.json') {
      const did = Object.keys(repos).find((d) => d.startsWith('did:web:') && u.host === d.slice(8).replace(/%3A/gi, ':'));
      return did ? json(repos[did].doc ?? plcDoc(did, repos[did].pds)) : json({}, 404);
    }
    if (u.pathname === '/xrpc/com.atproto.repo.listRecords') {
      const did = u.searchParams.get('repo');
      const collection = u.searchParams.get('collection');
      const r = repos[did];
      if (!r || `https://${u.host}` !== r.pds) return json({ error: 'RepoNotFound' }, 400);
      if (r.fail?.[collection]) return r.fail[collection].clone();
      const all = r.records?.[collection] ?? [];
      const start = Number(u.searchParams.get('cursor') ?? 0);
      const limit = Number(u.searchParams.get('limit'));
      const page = all.slice(start, start + limit);
      return json({ records: page, ...(start + limit < all.length ? { cursor: String(start + limit) } : {}) });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const rows = new Map(index.map((r) => [r.uri, r]));
  const calls = [];
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === 'garden_repos') return [...new Set([...rows.values()].map((r) => r.did))].sort();
    if (name === 'garden_repo_uris') return [...rows.values()].filter((r) => r.did === args.p_did).map((r) => ({ uri: r.uri, collection: r.collection }));
    if (name === 'garden_apply') {
      for (const uri of args.p_deletes) rows.delete(uri);
      for (const r of args.p_upserts) rows.set(r.uri, r);
      return args.p_deletes.length + args.p_upserts.length;
    }
    throw new Error(`unexpected rpc ${name}`);
  };
  return { fetch, rpc, rows, calls, requests };
}

function backfillOn(w, { touchedSince, now = () => T0 } = {}) {
  const status = [];
  const store = createStore(null, quiet);
  const backfill = createBackfill({
    rpc: w.rpc,
    writeStatus: async (v) => status.push(v),
    store,
    log: quiet,
    relayUrl: RELAY,
    plcUrl: PLC,
    touchedSince,
    fetch: w.fetch,
    now,
    setRepeat: () => 1,
    clearRepeat: () => {},
  });
  return { backfill, status, store };
}

const held = (did, collection, n) => ({ uri: `at://${did}/${collection}/${rkey(n)}`, did, collection });

test('finds repos from the relay (every page, each collection) and from the index', async () => {
  const w = world({
    relay: { [SPROUT]: [[ALICE], [BOB]], [PATCH]: [[ALICE]], [TEND]: [[]] },
    repos: {
      [ALICE]: { pds: 'https://pds.alice.example', records: { [PATCH]: [entry(ALICE, PATCH, 1)], [SPROUT]: [entry(ALICE, SPROUT, 1)] } },
      [BOB]: { pds: 'https://pds.bob.example', records: { [SPROUT]: [entry(BOB, SPROUT, 2)] } },
      [CAROL]: { pds: 'https://pds.carol.example', records: { [TEND]: [entry(CAROL, TEND, 3)] } },
    },
    index: [held(CAROL, TEND, 3)],
  });
  const { backfill, status, store } = backfillOn(w);
  const result = await backfill.run('test');
  assert.deepEqual(result, { repos: 3, listed: true, complete: 3, incomplete: 0, upserts: 4, deletes: 0, seconds: 0 });
  assert.equal(w.requests.filter((u) => u.includes('listReposByCollection')).length, 4, 'two pages of sprouts, one each of the rest');
  assert.ok(w.requests.some((u) => u.includes('collection=to.atpota.garden.sprout') && u.includes('cursor=1')));
  assert.deepEqual([...w.rows.keys()].sort(), [entry(ALICE, PATCH, 1).uri, entry(ALICE, SPROUT, 1).uri, entry(BOB, SPROUT, 2).uri, entry(CAROL, TEND, 3).uri].sort());
  const row = w.rows.get(entry(ALICE, SPROUT, 1).uri);
  assert.equal(row.first_seen_at, null, 'a backfill never claims a first-seen time');
  assert.equal(row.ref_uri, `at://${ALICE}/${PATCH}/self`);
  assert.deepEqual(status, [{ backfilled_at: '2026-10-20T12:00:00.000Z' }]);
  assert.equal(store.backfilledAt, '2026-10-20T12:00:00.000Z');
});

test('resolves did:plc from PLC and did:web from its host (port and all)', async () => {
  assert.equal(didDocumentUrl(ALICE, PLC), `${PLC}/${ALICE}`);
  assert.equal(didDocumentUrl(CAROL, PLC), 'https://carol.example:8443/.well-known/did.json');
  assert.throws(() => didDocumentUrl('did:web:localhost', PLC));
  assert.throws(() => didDocumentUrl('did:web:example.com:user:alice', PLC));
  assert.throws(() => didDocumentUrl('did:key:z6Mk', PLC));
  assert.equal(pdsOf(plcDoc(ALICE, 'https://pds.example/')), 'https://pds.example');
  assert.equal(pdsOf({ service: [{ id: 'did:plc:x#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example' }] }), 'https://pds.example');
  assert.equal(pdsOf(plcDoc(ALICE, 'http://pds.example')), null, 'https only');
  assert.equal(pdsOf(plcDoc(ALICE, 'https://127.0.0.1:8787')), null, 'never the droplet itself');
  assert.equal(pdsOf({ service: [{ id: '#bsky_appview', serviceEndpoint: 'https://api.example' }] }), null);

  const w = world({ relay: { [TEND]: [[CAROL]] }, repos: { [CAROL]: { pds: 'https://pds.carol.example', records: { [TEND]: [entry(CAROL, TEND, 1)] } } } });
  await backfillOn(w).backfill.run();
  assert.ok(w.requests.includes('https://carol.example:8443/.well-known/did.json'));
  assert.ok(w.rows.has(entry(CAROL, TEND, 1).uri));
});

test('a PDS lookup is cached for an hour', async () => {
  const w = world({ relay: { [SPROUT]: [[ALICE]] }, repos: { [ALICE]: { pds: 'https://pds.alice.example' } } });
  let t = T0;
  const { backfill } = backfillOn(w, { now: () => t });
  await backfill.run();
  await backfill.run();
  assert.equal(w.requests.filter((u) => u.startsWith(PLC)).length, 1);
  t += 3600_000;
  await backfill.run();
  assert.equal(w.requests.filter((u) => u.startsWith(PLC)).length, 2);
});

test('an account PLC answers 404 or 410 for is gone: complete, empty, its records deleted', async () => {
  for (const docStatus of [404, 410]) {
    const w = world({ repos: { [GONE]: { docStatus } }, index: [held(GONE, SPROUT, 1), held(GONE, TEND, 2)] });
    const result = await backfillOn(w).backfill.run();
    assert.equal(result.complete, 1);
    assert.equal(result.deletes, 2);
    assert.equal(w.rows.size, 0);
  }
});

test('RepoDeactivated (and the like) is complete and empty', async () => {
  const deactivated = json({ error: 'RepoDeactivated', message: 'deactivated' }, 400);
  const w = world({
    repos: { [BOB]: { pds: 'https://pds.bob.example', fail: { [PATCH]: deactivated, [SPROUT]: deactivated, [TEND]: deactivated } } },
    index: [held(BOB, SPROUT, 1)],
  });
  const result = await backfillOn(w).backfill.run();
  assert.equal(result.complete, 1);
  assert.equal(w.rows.size, 0);
});

test('any other failure: what was listed is kept, nothing is deleted for that repo', async () => {
  const w = world({
    relay: { [SPROUT]: [[ALICE, BOB]] },
    repos: {
      [ALICE]: { pds: 'https://pds.alice.example', records: { [SPROUT]: [entry(ALICE, SPROUT, 5)] }, fail: { [TEND]: json({ error: 'InternalServerError' }, 500) } },
      [BOB]: { pds: 'https://pds.bob.example', records: {} },
    },
    index: [held(ALICE, SPROUT, 1), held(ALICE, TEND, 2), held(BOB, SPROUT, 3)],
  });
  const result = await backfillOn(w).backfill.run();
  assert.equal(result.incomplete, 1);
  assert.equal(result.complete, 1);
  assert.ok(w.rows.has(held(ALICE, SPROUT, 1).uri), 'not deleted: the listing was incomplete');
  assert.ok(w.rows.has(held(ALICE, TEND, 2).uri));
  assert.ok(w.rows.has(entry(ALICE, SPROUT, 5).uri), 'what was listed is upserted');
  assert.equal(w.rows.has(held(BOB, SPROUT, 3).uri), false, 'the complete repo is reconciled');
});

test('a listing with records from another repo, or a PDS that cannot be resolved, is incomplete', async () => {
  const w = world({
    relay: { [SPROUT]: [[ALICE, 'did:plc:nopds']] },
    repos: {
      [ALICE]: { pds: 'https://pds.alice.example', records: { [SPROUT]: [{ ...entry(BOB, SPROUT, 1) }] } },
      'did:plc:nopds': { pds: 'https://pds.example', doc: { id: 'did:plc:nopds', service: [] } },
    },
    index: [held(ALICE, SPROUT, 9), held('did:plc:nopds', SPROUT, 8)],
  });
  const result = await backfillOn(w).backfill.run();
  assert.equal(result.incomplete, 2);
  assert.equal(w.rows.size, 2);
});

test('records the repo lists that the index would not keep leave the index', async () => {
  const junk = { ...entry(ALICE, SPROUT, 1), value: { ...record(SPROUT, 1), plot: 'seven' } };
  const w = world({ repos: { [ALICE]: { pds: 'https://pds.alice.example', records: { [SPROUT]: [junk] } } }, index: [held(ALICE, SPROUT, 1)] });
  await backfillOn(w).backfill.run();
  assert.equal(w.rows.size, 0);
});

test('applies in chunks of at most 500', async () => {
  const many = Array.from({ length: CHUNK + 120 }, (_, i) => entry(ALICE, TEND, i));
  const w = world({ relay: { [TEND]: [[ALICE]] }, repos: { [ALICE]: { pds: 'https://pds.alice.example', records: { [TEND]: many } } } });
  const result = await backfillOn(w).backfill.run();
  assert.equal(result.upserts, CHUNK + 120);
  const applies = w.calls.filter((c) => c.name === 'garden_apply');
  assert.deepEqual(applies.map((c) => c.args.p_upserts.length + c.args.p_deletes.length), [CHUNK, 120]);
  assert.equal(w.requests.filter((u) => u.includes('listRecords')).length, 3 + 6, 'tends a hundred at a time, plus the empty collections');
});

test('reads the index before listing, and leaves alone what the stream touched meanwhile', async () => {
  const w = world({
    repos: { [ALICE]: { pds: 'https://pds.alice.example', records: { [SPROUT]: [entry(ALICE, SPROUT, 1), entry(ALICE, SPROUT, 2)] } } },
    index: [held(ALICE, SPROUT, 3), held(ALICE, SPROUT, 4)],
  });
  const touched = new Set([entry(ALICE, SPROUT, 2).uri, held(ALICE, SPROUT, 4).uri]);
  const { backfill } = backfillOn(w, { touchedSince: (uri) => touched.has(uri) });
  await backfill.run();
  const order = w.calls.map((c) => c.name);
  assert.ok(order.indexOf('garden_repo_uris') < order.indexOf('garden_apply'));
  const apply = w.calls.find((c) => c.name === 'garden_apply').args;
  assert.deepEqual(apply.p_upserts.map((r) => r.uri), [entry(ALICE, SPROUT, 1).uri]);
  assert.deepEqual(apply.p_deletes, [held(ALICE, SPROUT, 3).uri]);
});

test('a relay that cannot list: the known repos are reconciled, but the pass does not count', async () => {
  const w = world({ relayDown: true, repos: { [ALICE]: { pds: 'https://pds.alice.example', records: { [SPROUT]: [entry(ALICE, SPROUT, 1)] } } }, index: [held(ALICE, SPROUT, 1)] });
  const { backfill, status, store } = backfillOn(w);
  const result = await backfill.run();
  assert.equal(result.listed, false);
  assert.equal(result.complete, 1);
  assert.deepEqual(status, []);
  assert.equal(store.backfilledAt, null);
});

test('runs when never run or due, one at a time, with at most one more queued', async () => {
  const w = world({ relay: {}, repos: {} });
  let t = T0;
  const { backfill, store } = backfillOn(w, { now: () => t });
  const passes = () => w.calls.filter((c) => c.name === 'garden_repos').length;
  backfill.check();
  assert.equal(backfill.running, true);
  backfill.check();
  backfill.request('gap 1');
  backfill.request('gap 2');
  backfill.request('gap 3');
  while (backfill.running) await new Promise((r) => setImmediate(r));
  assert.equal(passes(), 2, 'the first, and one queued behind it');
  assert.equal(store.backfilledAt, new Date(T0).toISOString());
  backfill.check();
  assert.equal(backfill.running, false, 'not due yet');
  t += 6 * 3600_000;
  backfill.check();
  assert.equal(backfill.running, true);
  while (backfill.running) await new Promise((r) => setImmediate(r));
  assert.equal(passes(), 3);
});

test('a pass that could not read the index is retried later, not every minute', async () => {
  const w = world({});
  let t = T0;
  let broken = true;
  const rpc = w.rpc;
  const { backfill } = backfillOn({ ...w, rpc: async (n, a) => (broken ? Promise.reject(Object.assign(new Error('down'), { status: 0 })) : rpc(n, a)) }, { now: () => t });
  assert.equal(await backfill.run(), null);
  t += 60_000;
  backfill.check();
  assert.equal(backfill.running, false);
  broken = false;
  t += RETRY_FAILED_MS;
  backfill.check();
  assert.equal(backfill.running, true);
});

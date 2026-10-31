// Today's identity weather, live from the PLC directory's log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlcWatch } from '../src/plc-watch.js';

const BSKY = 'amanita.us-east.host.bsky.network';
const raw = (did, createdAt, host, { prev = 'x', handle = 'someone.bsky.social', type = 'plc_operation' } = {}) => ({
  did,
  cid: `${did}-${createdAt}`,
  createdAt,
  nullified: false,
  operation: { type, prev, alsoKnownAs: [`at://${handle}`], services: host ? { atproto_pds: { endpoint: `https://${host}` } } : {} },
});

function directory(ops, audits = {}) {
  const asked = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/export') {
      const after = u.searchParams.get('after');
      const page = ops.filter((e) => e.createdAt >= after).slice(0, 1000);
      return new Response(page.map((e) => JSON.stringify(e)).join('\n'));
    }
    const did = decodeURIComponent(u.pathname.split('/')[1]);
    asked.push(did);
    return audits[did] ? Response.json(audits[did]) : new Response('not found', { status: 404 });
  };
  return { fetchImpl, asked };
}

const census = { hosts: [{ hostname: BSKY }, { hostname: 'blacksky.app' }] };

test('reads today from midnight, reads a mover\'s history once, and writes today\'s row', async () => {
  const ops = [
    raw('did:plc:new', '2026-10-22T01:00:00.000Z', 'blacksky.app', { prev: null, handle: 'me.example' }),
    raw('did:plc:fresh', '2026-10-22T02:00:00.000Z', BSKY, { prev: null }),
    raw('did:plc:junk', '2026-10-22T02:00:01.000Z', 'pds.test', { prev: null }),
    raw('did:plc:mover', '2026-10-22T03:00:00.000Z', 'blacksky.app'),
  ];
  const { fetchImpl, asked } = directory(ops, {
    'did:plc:mover': [raw('did:plc:mover', '2025-01-01T00:00:00.000Z', BSKY, { prev: null }), raw('did:plc:mover', '2026-10-22T03:00:00.000Z', 'blacksky.app')],
  });
  const rows = [];
  const arrivals = [];
  const entries = [];
  const upsert = async (table, conflict, r) => (table === 'atmosphere_plc_day' ? rows : arrivals).push(...r.map((x) => ({ table, conflict, ...x })));
  const w = createPlcWatch({ census, fetchImpl, upsert, now: () => Date.parse('2026-10-22T12:00:00Z'), onEntry: (e, relay) => entries.push([e.did, e.host, relay.has('blacksky.app')]) });
  await w.poll();
  assert.deepEqual(asked, ['did:plc:mover']);
  // each operation is handed on, with the hosts the relay lists (host-activity.js keeps its directory with them)
  assert.equal(entries.length, 4);
  assert.deepEqual(entries.find(([did]) => did === 'did:plc:mover'), ['did:plc:mover', 'blacksky.app', true]);
  assert.deepEqual(rows.at(-1), { table: 'atmosphere_plc_day', conflict: 'day', day: '2026-10-22', ops: 4, created_bluesky: 1, created_independent: 1, created_unlisted: 1, created_custom_handle: 1, created_bulk: 0, created_unnamed: 0, moved_out: 1, moved_in: 0, moved_between: 0, deleted: 0, destinations: [{ hostname: 'blacksky.app', accounts: 1 }], bulk_hosts: [] });
  // and who arrived on blacksky: one signing up, one moving in
  assert.deepEqual(arrivals.at(-1), { table: 'atmosphere_host_arrival_day', conflict: 'day,hostname', day: '2026-10-22', hostname: 'blacksky.app', signed_up: 1, bulk: 0, unnamed: 0, moved_in: 1 });
  // nothing new: the same row again, no second history read
  await w.poll();
  assert.deepEqual(asked, ['did:plc:mover']);
  assert.equal(rows.at(-1).ops, 4);
});

test('counts a run made in bulk once it is over and the host has gone quiet', async () => {
  const at = (s) => new Date(Date.parse('2026-10-22T01:00:00.000Z') + s * 1000).toISOString();
  const ops = [
    // forty on blacksky exactly a second apart
    ...Array.from({ length: 40 }, (_, i) => raw(`did:plc:x${i}`, at(i), 'blacksky.app', { prev: null })),
    // and Bluesky's hosts signing people up every 30 seconds for the quarter of an hour after
    ...Array.from({ length: 30 }, (_, i) => raw(`did:plc:b${i}`, at(40 + i * 30), BSKY, { prev: null })),
  ];
  const { fetchImpl } = directory(ops);
  const rows = [];
  const arrivals = [];
  const w = createPlcWatch({ census, fetchImpl, upsert: async (table, conflict, r) => (table === 'atmosphere_plc_day' ? rows : arrivals).push(...r), now: () => Date.parse('2026-10-22T01:20:00Z') });
  await w.poll();
  assert.equal(rows.at(-1).created_independent, 40);
  assert.equal(rows.at(-1).created_bulk, 40);
  assert.deepEqual(rows.at(-1).bulk_hosts, [{ hostname: 'blacksky.app', accounts: 40, bursts: 1, seconds: 39 }]);
  // none of them people arriving
  assert.deepEqual(arrivals.at(-1), { day: '2026-10-22', hostname: 'blacksky.app', signed_up: 0, bulk: 40, unnamed: 0, moved_in: 0 });
});

test('finishes the day at midnight and starts the next', async () => {
  const ops = [
    raw('did:plc:a', '2026-10-22T23:59:00.000Z', BSKY, { prev: null }),
    raw('did:plc:b', '2026-10-23T00:01:00.000Z', 'blacksky.app', { prev: null }),
  ];
  const { fetchImpl } = directory(ops);
  const rows = [];
  const w = createPlcWatch({ census, fetchImpl, upsert: async (table, conflict, r) => table === 'atmosphere_plc_day' && rows.push(...r), now: () => Date.parse('2026-10-22T23:58:00Z') });
  await w.poll();
  assert.deepEqual(rows.map((r) => [r.day, r.created_bluesky, r.created_independent]), [
    ['2026-10-22', 1, 0],
    ['2026-10-23', 0, 1],
  ]);
  assert.equal(w.day, '2026-10-23');
});

test('waits for a census, and a failure only logs', async () => {
  const warned = [];
  const w = createPlcWatch({ census: { hosts: null }, fetchImpl: async () => new Response('x'), upsert: async () => assert.fail('no write without a census'), now: () => 0 });
  await w.poll();
  assert.equal(w.day, null);
  const broken = createPlcWatch({ census, fetchImpl: async () => new Response('[]'), upsert: async () => { throw new Error('down'); }, log: { info() {}, warn: (m) => warned.push(m) }, now: () => Date.parse('2026-10-22T12:00:00Z') });
  await broken.poll();
  assert.deepEqual(warned, ['could not count plc']);
});

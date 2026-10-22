// The hosts' history from the PLC directory's log: walking back from today's census.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backfill, daysOf, hostsBefore, hostsOnDay, parseArgs, PlcHistory, readExport } from '../src/backfill-hosts.js';
import { handleOfOp, hostOfOp, isCustomHandle, sideOf, slimEntry } from '../src/plc.js';

const BSKY = 'amanita.us-east.host.bsky.network';
const relayHosts = new Set([BSKY, 'blacksky.app', 'eurosky.social', 'quiet.example']);
const raw = (did, createdAt, host, { prev = 'x', handle = `${did.slice(8)}.bsky.social`, type = 'plc_operation' } = {}) => ({
  did,
  cid: `${did}-${createdAt}`,
  createdAt,
  nullified: false,
  operation: { type, prev, alsoKnownAs: [`at://${handle}`], services: host ? { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: `https://${host}` } } : {} },
});
const op = (...a) => slimEntry(raw(...a));
const audit = (entries) => entries.map(slimEntry);

test('plc: slimmed entries keep what the backfill needs', () => {
  assert.deepEqual(op('did:plc:a', '2026-10-20T00:00:00Z', 'Blacksky.app', { prev: null, handle: 'me.example' }), { did: 'did:plc:a', cid: 'did:plc:a-2026-10-20T00:00:00Z', at: '2026-10-20T00:00:00Z', genesis: true, deleted: false, nullified: false, host: 'blacksky.app', handle: 'me.example' });
  assert.equal(op('did:plc:a', '2026-10-20T00:00:00Z', null, { type: 'plc_tombstone' }).deleted, true);
  assert.equal(slimEntry({ did: 'did:plc:a' }), null);
});

test('plc: hosts, handles and sides', () => {
  assert.equal(hostOfOp({ services: { atproto_pds: { endpoint: 'https://Blacksky.App:443' } } }), 'blacksky.app');
  assert.equal(hostOfOp({ type: 'plc_tombstone' }), null);
  assert.equal(hostOfOp({ service: 'https://bsky.social' }), 'bsky.social');
  assert.equal(hostOfOp({ services: { atproto_pds: { endpoint: 'not a url' } } }), null);
  assert.equal(handleOfOp({ alsoKnownAs: ['at://Dame.is'] }), 'dame.is');
  assert.equal(isCustomHandle('dame.is'), true);
  assert.equal(isCustomHandle('someone.bsky.social'), false);
  // handles a host hands out aren't the account's own domain
  assert.equal(isCustomHandle('me.blacksky.app', 'blacksky.app'), false);
  assert.equal(isCustomHandle('alice.mastodon.social.ap.brid.gy', 'atproto.brid.gy'), false);
  assert.equal(isCustomHandle('me.example.com', 'pds.example.com'), false);
  assert.equal(isCustomHandle('dame.is', 'blacksky.app'), true);
  assert.equal(sideOf(BSKY, relayHosts), 'bluesky');
  assert.equal(sideOf('blacksky.app', relayHosts), 'independent');
  assert.equal(sideOf('pds.test', relayHosts), 'unlisted');
});

test('parseArgs: two weeks back by default, never today, at most 60 days', () => {
  const now = Date.parse('2026-10-22T14:00:00Z');
  assert.equal(parseArgs([], now).from, '2026-10-08');
  assert.equal(parseArgs(['--from', '2026-10-20', '--dry-run'], now).dryRun, true);
  assert.throws(() => parseArgs(['--from', '2026-10-22'], now), /before today/);
  assert.throws(() => parseArgs(['--from', '2026-07-01'], now), /at most/);
  assert.throws(() => parseArgs(['--from', 'last week'], now), /must be a day/);
  assert.deepEqual(daysOf('2026-10-19', '2026-10-22'), ['2026-10-19', '2026-10-20', '2026-10-21']);
});

/** Three days (the 19th to the 21st) plus today, the 22nd. */
function scenario() {
  const h = new PlcHistory({ from: '2026-10-19', days: 3, relayHosts });
  // created on blacksky on the 20th
  h.add(op('did:plc:new', '2026-10-20T10:00:00Z', 'blacksky.app', { prev: null, handle: 'me.example' }));
  // on Bluesky's before the window, moved to eurosky on the 20th (its start comes from its audit)
  h.add(op('did:plc:mover', '2026-10-20T12:00:00Z', 'eurosky.social'));
  // created on Bluesky's on the 19th, moved to blacksky today
  h.add(op('did:plc:early', '2026-10-19T08:00:00Z', BSKY, { prev: null }));
  h.add(op('did:plc:early', '2026-10-22T09:00:00Z', 'blacksky.app'));
  // a handle change on Bluesky's: no audit, taken to have been there all along
  h.add(op('did:plc:renamed', '2026-10-21T08:00:00Z', BSKY, { handle: 'renamed.example' }));
  // bulk sign-ups somewhere the relay doesn't list: counted, never kept
  h.add(op('did:plc:junk1', '2026-10-21T08:00:00Z', 'pds.test', { prev: null }));
  h.add(op('did:plc:junk2', '2026-10-21T08:00:01Z', 'pds.test', { prev: null }));
  // deleted on the 21st
  h.add(op('did:plc:gone', '2026-10-21T09:00:00Z', null, { type: 'plc_tombstone' }));
  return h;
}

test('PlcHistory: counts each day\'s identity weather', () => {
  const h = scenario();
  assert.equal(h.dids.has('did:plc:junk1'), false);
  // the mover named an independent host and the deleted one left somewhere: both read their history; the renamed one doesn't
  assert.deepEqual(h.needsAudit().sort(), ['did:plc:gone', 'did:plc:mover']);
  h.fromAudit('did:plc:mover', audit([
    { createdAt: '2026-01-01T00:00:00Z', operation: { prev: null, services: { atproto_pds: { endpoint: `https://${BSKY}` } } } },
    { createdAt: '2026-10-20T12:00:00Z', operation: { prev: 'a', services: { atproto_pds: { endpoint: 'https://eurosky.social' } } } },
  ].map((e) => ({ did: 'did:plc:mover', cid: e.createdAt, ...e }))));
  h.settle();
  assert.deepEqual(h.signals[0], { ops: 1, created_bluesky: 1, created_independent: 0, created_unlisted: 0, created_custom_handle: 0, moved_out: 0, moved_in: 0, moved_between: 0, deleted: 0 });
  assert.deepEqual(h.signals[1], { ops: 2, created_bluesky: 0, created_independent: 1, created_unlisted: 0, created_custom_handle: 1, moved_out: 1, moved_in: 0, moved_between: 0, deleted: 0 });
  assert.equal(h.signals[2].created_unlisted, 2);
  assert.equal(h.signals[2].deleted, 1);
  // today's move is in the walk back, not in any day's signals
  assert.equal(h.signals.reduce((n, s) => n + s.moved_out, 0), 1);
});

test('PlcHistory: a deleted account was on its old host until it went', () => {
  const h = scenario();
  h.fromAudit('did:plc:gone', audit([
    { createdAt: '2025-01-01T00:00:00Z', operation: { prev: null, services: { atproto_pds: { endpoint: 'https://eurosky.social' } } } },
    { createdAt: '2026-10-21T09:00:00Z', operation: { type: 'plc_tombstone', prev: 'a' } },
  ].map((e) => ({ did: 'did:plc:gone', cid: e.createdAt, ...e }))));
  h.settle();
  const delta = h.deltas();
  assert.equal(delta[1][h.hostIndex.get('eurosky.social')], 1);
  assert.equal(delta[2][h.hostIndex.get('eurosky.social')], 0);
});

test('PlcHistory: walks each day back from now', () => {
  const h = scenario();
  h.fromAudit('did:plc:mover', audit([
    { createdAt: '2026-01-01T00:00:00Z', operation: { prev: null, services: { atproto_pds: { endpoint: `https://${BSKY}` } } } },
    { createdAt: '2026-10-20T12:00:00Z', operation: { prev: 'a', services: { atproto_pds: { endpoint: 'https://eurosky.social' } } } },
  ].map((e) => ({ did: 'did:plc:mover', cid: e.createdAt, ...e }))));
  h.settle();
  const delta = h.deltas();
  const at = (d, host) => delta[d][h.hostIndex.get(host)] ?? 0;
  // the 19th: new and mover not there yet; early on Bluesky's, not blacksky
  assert.equal(at(0, 'blacksky.app'), -2);
  assert.equal(at(0, 'eurosky.social'), -1);
  assert.equal(at(0, BSKY), 2);
  // the 21st: new and mover are where they are now; early still on Bluesky's
  assert.equal(at(2, 'blacksky.app'), -1);
  assert.equal(at(2, 'eurosky.social'), 0);
  assert.equal(at(2, BSKY), 1);

  const census = [
    { hostname: BSKY, status: 'active', accounts: 100, seq: 1 },
    { hostname: 'blacksky.app', status: 'active', accounts: 2, seq: 1 },
    { hostname: 'eurosky.social', status: 'active', accounts: 1, seq: 1 },
    { hostname: 'quiet.example', status: 'active', accounts: 0, seq: 1 },
    { hostname: 'offline.example', status: 'offline', accounts: 5, seq: 1 },
  ];
  // on the 19th, all of blacksky's and eurosky's accounts were still to come: they weren't there yet
  assert.deepEqual(hostsOnDay(census, h, delta[0]).map((x) => [x.hostname, x.accounts]), [[BSKY, 102], ['quiet.example', 0]]);
  assert.deepEqual(hostsOnDay(census, h, delta[2]).map((x) => [x.hostname, x.accounts]), [[BSKY, 101], ['blacksky.app', 1], ['eurosky.social', 1], ['quiet.example', 0]]);
});

test('readExport: pages on, drops repeats at a page edge, stops at now, and resumes from its cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-'));
  const cacheFile = path.join(dir, 'export.ndjson');
  const all = Array.from({ length: 2500 }, (_, i) => raw(`did:plc:a${i}`, new Date(Date.parse('2026-10-20T00:00:00Z') + Math.floor(i / 2) * 1000).toISOString(), BSKY, { prev: null }));
  const fetchImpl = async (url) => {
    const after = decodeURIComponent(new URL(url).searchParams.get('after'));
    // like the directory: strictly after, but pages of 1000 may end mid-instant, so the caller asks from the last instant again
    const from = all.findIndex((e) => e.createdAt >= after);
    const page = all.slice(from < 0 ? all.length : from, (from < 0 ? all.length : from) + 1000);
    return new Response(page.map((e) => JSON.stringify(e)).join('\n'));
  };
  const seen = [];
  await readExport({ fetchImpl, from: '2026-10-20', untilMs: Date.parse('2026-10-20T00:15:00Z'), cacheFile, onEntry: (e) => seen.push(e.cid), log: () => {} });
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(seen.length, 1802); // 00:00:00 to 00:15:00, two a second
  const again = [];
  await readExport({ fetchImpl, from: '2026-10-20', untilMs: Date.parse('2026-10-20T00:15:00Z'), cacheFile, onEntry: (e) => again.push(e.cid), log: () => {} });
  assert.equal(again.length, 1802);
});

test('backfill: a dry run reads, audits and prints, and writes nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-'));
  const now = Date.parse('2026-10-22T14:00:00Z');
  const ops = [raw('did:plc:new', '2026-10-21T10:00:00Z', 'blacksky.app', { prev: null })];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/xrpc/com.atproto.sync.listHosts') return Response.json({ hosts: [{ hostname: 'blacksky.app', status: 'active', accountCount: 3, seq: 1 }, { hostname: BSKY, status: 'active', accountCount: 10, seq: 1 }] });
    if (u.pathname === '/export') return new Response(ops.map((e) => JSON.stringify(e)).join('\n'));
    throw new Error(`unexpected ${url}`);
  };
  const lines = [];
  const { days } = await backfill({ args: { ...parseArgs(['--from', '2026-10-20', '--dry-run', '--cache', dir], now) }, fetchImpl, nowMs: now, log: (l) => lines.push(l) });
  assert.deepEqual(days, ['2026-10-20', '2026-10-21']);
  const row = lines.find((l) => l.startsWith('2026-10-20'));
  // blacksky had 2 accounts on the 20th, before the new one came
  assert.match(row, /^2026-10-20\s+2\s+1\s+2\s/);
  assert.ok(lines.some((l) => l.startsWith('dry run')));
});

test('hostsOnDay: a host with accounts from before stays, and one the station saw active counts while idle', () => {
  const h = scenario();
  h.settle();
  const delta = h.deltas();
  const census = [
    { hostname: 'blacksky.app', status: 'active', accounts: 2, seq: 1 },
    { hostname: 'eurosky.social', status: 'idle', accounts: 1, seq: 1 },
  ];
  // the 19th: blacksky's two accounts both arrived later, so it would be left out
  assert.deepEqual(hostsOnDay(census, h, delta[0]).map((x) => x.hostname), []);
  // unless it had one from before the window; and eurosky, idle now, counts if the station saw it active
  assert.deepEqual(
    hostsOnDay(census, h, delta[0], { floors: new Map([['blacksky.app', 1]]), seenActive: new Set(['eurosky.social']) }).map((x) => [x.hostname, x.accounts]),
    [['blacksky.app', 1], ['eurosky.social', 1]],
  );
});

test('hostsBefore: asks a host the walk back would leave out for its accounts, and keeps it if one is from before', async () => {
  const h = scenario();
  // the mover came to eurosky in the window, from Bluesky's hosts
  h.fromAudit('did:plc:mover', audit([
    { createdAt: '2026-01-01T00:00:00Z', operation: { prev: null, services: { atproto_pds: { endpoint: `https://${BSKY}` } } } },
    { createdAt: '2026-10-20T12:00:00Z', operation: { prev: 'a', services: { atproto_pds: { endpoint: 'https://eurosky.social' } } } },
  ].map((e) => ({ did: 'did:plc:mover', cid: e.createdAt, ...e }))));
  h.settle();
  const deltas = h.deltas();
  const census = [
    { hostname: 'blacksky.app', status: 'active', accounts: 2, seq: 1 },
    { hostname: 'eurosky.social', status: 'active', accounts: 1, seq: 1 },
  ];
  const asked = [];
  const fetchImpl = async (url) => {
    const host = new URL(url).hostname;
    asked.push(host);
    // blacksky lists the new account and one nobody touched in the window: that one was there before
    if (host === 'blacksky.app') return Response.json({ repos: [{ did: 'did:plc:new' }, { did: 'did:plc:old' }] });
    // eurosky lists only the account that moved in: it wasn't there before
    return Response.json({ repos: [{ did: 'did:plc:mover' }] });
  };
  const floors = await hostsBefore({ fetchImpl, census, history: h, deltas, log: () => {} });
  assert.deepEqual(asked.sort(), ['blacksky.app', 'eurosky.social']);
  assert.deepEqual([...floors], [['blacksky.app', 1]]);
  // one that won't answer is left to the walk back
  assert.equal((await hostsBefore({ fetchImpl: async () => { throw new Error('down'); }, census, history: h, deltas, log: () => {} })).size, 0);
});

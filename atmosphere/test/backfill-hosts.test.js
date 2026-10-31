// The hosts' history from the PLC directory's log: walking back from today's census.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { arrivalRows, backfill, bulkRun, daysOf, floodStart, hostsBefore, hostsOnDay, parseArgs, plateauOf, PlcHistory, plcRow, readExport } from '../src/backfill-hosts.js';
import { handleOfOp, hostOfOp, isCustomHandle, sideOf, slimEntry } from '../src/plc.js';

const BSKY = 'amanita.us-east.host.bsky.network';
const relayHosts = new Set([BSKY, 'blacksky.app', 'eurosky.social', 'quiet.example']);
const raw = (did, createdAt, host, { prev = 'x', handle = `${did.slice(8)}.bsky.social`, type = 'plc_operation' } = {}) => ({
  did,
  cid: `${did}-${createdAt}`,
  createdAt,
  nullified: false,
  operation: { type, prev, alsoKnownAs: handle === null ? [] : [`at://${handle}`], services: host ? { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: `https://${host}` } } : {} },
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
    { createdAt: '2026-01-01T00:00:00Z', operation: { prev: null, alsoKnownAs: ['at://mover.bsky.social'], services: { atproto_pds: { endpoint: `https://${BSKY}` } } } },
    { createdAt: '2026-10-20T12:00:00Z', operation: { prev: 'a', alsoKnownAs: ['at://mover.bsky.social'], services: { atproto_pds: { endpoint: 'https://eurosky.social' } } } },
  ].map((e) => ({ did: 'did:plc:mover', cid: e.createdAt, ...e }))));
  h.settle();
  assert.deepEqual(h.signals[0], { ops: 1, created_bluesky: 1, created_independent: 0, created_unlisted: 0, created_custom_handle: 0, created_bulk: 0, created_unnamed: 0, moved_out: 0, moved_in: 0, moved_between: 0, deleted: 0, destinations: {}, bulk_hosts: {}, arrivals: {} });
  // the mover went to eurosky: that's where the wind blew
  assert.deepEqual(h.signals[1], {
    ops: 2, created_bluesky: 0, created_independent: 1, created_unlisted: 0, created_custom_handle: 1, created_bulk: 0, created_unnamed: 0, moved_out: 1, moved_in: 0, moved_between: 0, deleted: 0,
    destinations: { 'eurosky.social': 1 }, bulk_hosts: {},
    arrivals: { 'blacksky.app': { created: 1, unnamed: 0, moved_in: 0 }, 'eurosky.social': { created: 0, unnamed: 0, moved_in: 1 } },
  });
  assert.deepEqual(arrivalRows('2026-10-20', h.signals[1]), [
    { day: '2026-10-20', hostname: 'blacksky.app', signed_up: 1, bulk: 0, unnamed: 0, moved_in: 0 },
    { day: '2026-10-20', hostname: 'eurosky.social', signed_up: 0, bulk: 0, unnamed: 0, moved_in: 1 },
  ]);
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

test('plcRow: a day\'s row names its ten busiest destinations', () => {
  const destinations = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`h${String(i).padStart(2, '0')}.example`, i + 1]));
  const row = plcRow('2026-10-22', { ops: 1, moved_out: 3, destinations });
  assert.equal(row.destinations.length, 10);
  assert.deepEqual(row.destinations[0], { hostname: 'h11.example', accounts: 12 });
  assert.equal(row.day, '2026-10-22');
  assert.deepEqual(plcRow('2026-10-22', { ops: 0 }).destinations, []);
  assert.equal('arrivals' in plcRow('2026-10-22', { ops: 0, arrivals: { 'blacksky.app': { created: 1, unnamed: 0, moved_in: 0 } } }), false);
});

test('arrivals: people signing up and moving in, apart from identities with no handle and accounts made in bulk', () => {
  const h = new PlcHistory({ from: '2026-10-28', days: 1, relayHosts: new Set([...relayHosts, 'knot1.tangled.sh', 'goodmkt.id']) });
  // a git server's repositories: identities with no handle, made in a run a second apart
  for (let i = 0; i < 30; i++) h.add(op(`did:plc:repo${i}`, at('03:00:00', i), 'knot1.tangled.sh', { prev: null, handle: null }));
  // forty accounts a second apart, a script's
  for (let i = 0; i < 40; i++) h.add(op(`did:plc:made${i}`, at('04:00:00', i), 'goodmkt.id', { prev: null, handle: `made${i}.goodmkt.id` }));
  // and a person signing up there later
  h.add(op('did:plc:person', at('09:00:00', 0), 'goodmkt.id', { prev: null, handle: 'person.goodmkt.id' }));
  // someone moving to eurosky, and a repository moving there: its history says where from
  h.add(op('did:plc:mover', at('10:00:00', 0), 'eurosky.social'));
  h.add(op('did:plc:repomove', at('10:00:01', 0), 'eurosky.social', { handle: null }));
  for (const did of ['did:plc:mover', 'did:plc:repomove']) {
    h.fromAudit(did, audit([
      { createdAt: '2026-01-01T00:00:00Z', operation: { prev: null, alsoKnownAs: did === 'did:plc:mover' ? ['at://mover.example'] : [], services: { atproto_pds: { endpoint: `https://${BSKY}` } } } },
      { createdAt: at('10:00:00', 0), operation: { prev: 'a', alsoKnownAs: did === 'did:plc:mover' ? ['at://mover.example'] : [], services: { atproto_pds: { endpoint: 'https://eurosky.social' } } } },
    ].map((e) => ({ did, cid: e.createdAt, ...e }))));
  }
  // and Bluesky's hosts signing people up for the quarter of an hour after (the log's clock)
  for (let i = 0; i < 30; i++) h.add(op(`did:plc:b${i}`, at('10:01:00', i * 30), BSKY, { prev: null }));
  h.endRuns();
  const s = h.signalsOf(0);
  // the repositories aren't sign-ups anyone made, so they're never a run either
  assert.equal(s.created_unnamed, 30);
  assert.equal(s.created_bulk, 40);
  assert.deepEqual(arrivalRows('2026-10-28', s), [
    { day: '2026-10-28', hostname: 'eurosky.social', signed_up: 0, bulk: 0, unnamed: 1, moved_in: 1 },
    { day: '2026-10-28', hostname: 'goodmkt.id', signed_up: 1, bulk: 40, unnamed: 0, moved_in: 0 },
    { day: '2026-10-28', hostname: 'knot1.tangled.sh', signed_up: 0, bulk: 0, unnamed: 30, moved_in: 0 },
  ]);
});

// ---------- made in bulk ----------

const S = (hms) => `2026-10-28T${hms}.000Z`;
const at = (base, seconds) => new Date(Date.parse(S(base)) + Math.round(seconds * 1000)).toISOString();
const hosts = new Set([BSKY, 'goodmkt.id', 'pds.1095.me', 'pds.svpn.com', 'pds.oso.social', 'eurosky.social']);
const ms = (base, seconds) => Date.parse(S(base)) + Math.round(seconds * 1000);

/** A seeded stream of random numbers, so the crowds below are the same every run. */
function rand(seed) {
  let x = seed;
  return () => ((x = (x * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
}
const exp = (r, mean) => -Math.log(1 - r()) * mean;

/** One day's history from sign-ups ([host, iso]), with Bluesky's hosts signing someone up every 20 seconds all day (the log's clock). */
function day(signUps) {
  const h = new PlcHistory({ from: '2026-10-28', days: 1, relayHosts: hosts });
  const ops = [];
  for (let i = 0; i < 4320; i++) ops.push(raw(`did:plc:bsky${i}`, at('00:00:00', i * 20), BSKY, { prev: null }));
  signUps.forEach(([host, when], i) => ops.push(raw(`did:plc:${host}${i}`, when, host, { prev: null })));
  ops.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  for (const e of ops) h.add(slimEntry(e));
  return h;
}
/** Sign-ups on a host at these seconds after `base`. */
const on = (host, base, seconds) => seconds.map((x) => [host, at(base, x)]);
const cumulative = (gaps) => gaps.reduce((t, g) => [...t, t[t.length - 1] + g], [0]);

test('bulk: clockwork and a flat plateau, each switched on and off, then quiet', () => {
  const r = rand(1);
  const h = day([
    // forty exactly a second apart
    ...on('pds.1095.me', '07:25:34', cumulative(Array(39).fill(1))),
    // one account, then 4,500 at a steady three and a half a second, uneven second to second but flat minute to minute
    ...on('goodmkt.id', '05:55:00', [0, ...cumulative(Array.from({ length: 4498 }, () => 0.02 + r() * 0.53)).map((x) => 41.7 + x)]),
  ]);
  const s = h.signalsOf(0);
  assert.equal(s.created_independent, 4540);
  assert.equal(s.created_bulk, 4540);
  assert.deepEqual(plcRow('2026-10-28', s).bulk_hosts.map((b) => [b.hostname, b.accounts, b.bursts]), [['goodmkt.id', 4500, 1], ['pds.1095.me', 40, 1]]);
  assert.deepEqual(bulkRun(on('x', '07:00:00', cumulative(Array(39).fill(1))).map(([, w]) => Date.parse(w))), { clockwork: true, plateau: false });
});

test('bulk: a crowd builds up and trails off, so it never counts, however big', () => {
  const r = rand(2);
  // 3,000 people after an announcement: it takes them a minute or so to sign up, and the news fades over an hour
  const times = [];
  while (times.length < 3000) {
    const t = exp(r, 3600);
    if (r() < 1 - Math.exp(-t / 60)) times.push(t);
  }
  times.sort((a, b) => a - b);
  const h = day(on('eurosky.social', '09:00:00', times));
  assert.equal(h.signalsOf(0).created_independent, 3000);
  assert.equal(h.signalsOf(0).created_bulk, 0);
});

test('bulk: a steady run the host keeps signing people up after is a crowd behind a busy server', () => {
  // a flat run at one a second, but people keep coming in the ten minutes after
  const h = day([
    ...on('pds.oso.social', '12:00:00', cumulative(Array(299).fill(1))),
    ...on('pds.oso.social', '12:00:00', [370, 420, 470, 520, 580, 640]),
  ]);
  assert.equal(h.signalsOf(0).created_bulk, 0);
  // and one that ramps up into its flat stretch isn't switched on
  const ramp = [...cumulative([50, 40, 30, 25, 20, 15, 12, 10, 8, 6, 5, 4, 3, 2]), ...cumulative(Array(280).fill(1)).map((x) => 230 + x)];
  assert.equal(bulkRun(ramp.map((x) => ms('12:00:00', x))), null);
});

test('bulk: five runs or more that open with a flood are a script; one is sign-ups opening on time', () => {
  // blocks of 45: ten in under two seconds, then thirty-five over the next half minute, again and again
  const block = [...cumulative(Array(9).fill(0.2)), ...cumulative(Array(34).fill(0.9)).map((x) => 2.7 + x)];
  const blocks = (host, n) => Array.from({ length: n }, (_, i) => on(host, '06:00:00', block.map((x) => x + i * 300))).flat();
  assert.equal(day(blocks('pds.svpn.com', 6)).signalsOf(0).created_bulk, 270);
  assert.equal(day(blocks('pds.svpn.com', 4)).signalsOf(0).created_bulk, 0);
  assert.equal(floodStart(block.map((x) => ms('06:00:00', x))), true);
});

test('bulk: a run is judged once it is over and the host has had ten minutes to go quiet', () => {
  const h = new PlcHistory({ from: '2026-10-28', days: 1, relayHosts: hosts });
  const add = (host, iso, i) => h.add(op(`did:plc:${host}${iso}${i}`, iso, host, { prev: null }));
  cumulative(Array(39).fill(1)).forEach((x, i) => add('pds.1095.me', at('07:00:00', x), i));
  // still going as far as the log knows: not judged
  assert.equal(h.signalsOf(0).created_bulk, 0);
  // two minutes on, it's over and waiting: counted as it stands
  add(BSKY, at('07:02:39', 0), 0);
  assert.equal(h.signalsOf(0).created_bulk, 40);
  // a stray sign-up inside the ten minutes is fine; six more aren't quiet
  [100, 160, 220, 280, 340, 400].forEach((x, i) => add('pds.1095.me', at('07:00:39', x), i + 100));
  assert.equal(h.signalsOf(0).created_bulk, 0);
  add(BSKY, at('07:30:00', 0), 1);
  assert.equal(h.signals[0].created_bulk, 0);
  // a gap of over a minute splits runs, and a short one is never judged
  assert.equal(day(on('goodmkt.id', '06:00:00', [...cumulative(Array(9).fill(1)), ...cumulative(Array(9).fill(1)).map((x) => x + 200)])).signalsOf(0).created_bulk, 0);
  assert.equal(plateauOf(Array.from({ length: 100 }, (_, i) => i * 1000)), null);
});

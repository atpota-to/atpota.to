import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActivityDay, ALL_INDEPENDENT, createHostActivity, didKey, HostDirectory, hostsToRead, readDirectory, readHostAccounts } from '../src/host-activity.js';
import { registerOf } from '../src/hll.js';
import { toBytea } from '../src/rollup.js';

const DAY = '2026-10-22';
const NOON = Date.parse(`${DAY}T12:00:00Z`);
const commit = (did, ms = NOON) => ({ kind: 'commit', did, time_us: ms * 1000, commit: { operation: 'create', collection: 'app.bsky.feed.like' } });

/** A host answering listRepos from a list of DIDs, `per` to a page. */
function hostsAnswering(byHost, per = 2) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const dids = byHost[u.hostname];
    if (!dids) return new Response('nope', { status: 502 });
    const from = Number(u.searchParams.get('cursor') ?? 0);
    const page = dids.slice(from, from + per);
    const body = { repos: page.map((did) => ({ did, active: !did.endsWith('gone') })) };
    if (from + per < dids.length) body.cursor = String(from + per);
    return Response.json(body);
  };
  return { fetchImpl, calls };
}

test('didKey: a stable whole number, 53 bits at most, different for different DIDs', () => {
  const a = didKey('did:plc:abc');
  assert.equal(a, didKey('did:plc:abc'));
  assert.ok(Number.isSafeInteger(a) && a >= 0);
  assert.notEqual(a, didKey('did:plc:abd'));
});

test('the directory places, moves and forgets accounts, and survives a round trip through JSON', () => {
  const d = new HostDirectory();
  d.place('did:plc:a', 'eurosky.social');
  d.place('did:plc:b', 'blacksky.app');
  d.place('did:plc:a', 'blacksky.app');
  d.place('did:plc:b', null);
  assert.equal(d.hostOf('did:plc:a'), 'blacksky.app');
  assert.equal(d.hostOf('did:plc:b'), null);
  assert.equal(d.size, 1);
  d.readAt = NOON;
  const back = HostDirectory.fromJSON(JSON.parse(JSON.stringify(d)));
  assert.equal(back.hostOf('did:plc:a'), 'blacksky.app');
  assert.equal(back.readAt, NOON);
  // no DID in what's saved
  assert.equal(JSON.stringify(d).includes('did:plc'), false);
  assert.equal(HostDirectory.fromJSON({ nope: true }), null);
});

test('reads every page of a host\'s accounts, skipping deactivated ones, and stops at a failure', async () => {
  const { fetchImpl, calls } = hostsAnswering({ 'eurosky.social': ['did:plc:1', 'did:plc:2', 'did:plc:3', 'did:plc:gone'] });
  const seen = [];
  assert.equal(await readHostAccounts(fetchImpl, 'eurosky.social', { onDid: (d) => seen.push(d) }), 3);
  assert.deepEqual(seen, ['did:plc:1', 'did:plc:2', 'did:plc:3']);
  assert.equal(calls.length, 2);
  assert.equal(await readHostAccounts(fetchImpl, 'down.example', { onDid: () => {} }), 0);
});

test('reads only active independent hosts with accounts', async () => {
  const census = [
    { hostname: 'eurosky.social', status: 'active', accounts: 3 },
    { hostname: 'idle.example', status: 'idle', accounts: 3 },
    { hostname: 'empty.example', status: 'active', accounts: 0 },
    { hostname: 'morel.us-east.host.bsky.network', status: 'active', accounts: 900_000 },
  ];
  assert.deepEqual(hostsToRead(census).map((h) => h.hostname), ['eurosky.social']);
  const { fetchImpl } = hostsAnswering({ 'eurosky.social': ['did:plc:1', 'did:plc:2'] });
  const d = await readDirectory({ fetchImpl, census, now: () => NOON });
  assert.equal(d.size, 2);
  assert.equal(d.readAt, NOON);
});

test('a day\'s sketches: one a host and one for them all, merged with what was written before', () => {
  const day = new ActivityDay(DAY);
  day.add('eurosky.social', registerOf('did:plc:1'));
  day.add('eurosky.social', registerOf('did:plc:1'));
  day.add('blacksky.app', registerOf('did:plc:2'));
  const rows = day.rows();
  assert.deepEqual(rows.map((r) => [r.hostname, r.dids]), [[ALL_INDEPENDENT, 2], ['eurosky.social', 1], ['blacksky.app', 1]]);
  // an earlier run wrote did:plc:3 on eurosky.social: merged, not replaced
  const before = new ActivityDay(DAY);
  before.add('eurosky.social', registerOf('did:plc:3'));
  day.merge(before.rows());
  assert.deepEqual(day.rows().map((r) => [r.hostname, r.dids]), [[ALL_INDEPENDENT, 3], ['eurosky.social', 2], ['blacksky.app', 1]]);
});

function station({ directory, rows = [], now = () => NOON } = {}) {
  const written = [];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-')), 'host-directory.json');
  if (directory) fs.writeFileSync(file, JSON.stringify(directory));
  const read = async () => {
    const d = new HostDirectory();
    d.place('did:plc:new', 'eurosky.social');
    d.readAt = now();
    return d;
  };
  const a = createHostActivity({ upsert: async (table, conflict, r) => written.push({ table, conflict, rows: r }), getAll: async () => rows, file, now, read });
  return { a, written, file };
}

test('counts commits by accounts on independent hosts, and writes today after a census, read back first', async () => {
  const d = new HostDirectory();
  d.place('did:plc:1', 'eurosky.social');
  d.readAt = NOON - 3600_000;
  const earlier = new ActivityDay(DAY);
  earlier.add('blacksky.app', registerOf('did:plc:9'));
  const { a, written } = station({ directory: d, rows: earlier.rows() });
  a.see(commit('did:plc:1'));
  a.see(commit('did:plc:bsky')); // on Bluesky's hosts: not counted here
  a.see({ kind: 'identity', did: 'did:plc:1' });
  await a.onCensus([]);
  assert.equal(a.reading, null, 'a fresh directory is not read again');
  const rows = written.at(-1).rows;
  assert.equal(written.at(-1).table, 'atmosphere_host_active_day');
  assert.deepEqual(rows.map((r) => [r.hostname, r.dids]).sort(), [[ALL_INDEPENDENT, 2], ['blacksky.app', 1], ['eurosky.social', 1]]);
  assert.match(rows[0].sketch, /^\\x02/);
});

test('reads the directory when it has none, carrying over the moves made meanwhile', async () => {
  const { a, file } = station();
  const relay = new Set(['blacksky.app', 'eurosky.social']);
  await a.onCensus([{ hostname: 'eurosky.social', status: 'active', accounts: 1 }]);
  // while it reads: one account moves to blacksky.app, one to Bluesky, one to a host the relay doesn't list
  a.onPlcEntry({ did: 'did:plc:mover', host: 'blacksky.app' }, relay);
  a.onPlcEntry({ did: 'did:plc:new', host: 'morel.us-east.host.bsky.network' }, relay);
  a.onPlcEntry({ did: 'did:plc:odd', host: 'test.example' }, relay);
  await a.reading;
  assert.equal(a.directory.hostOf('did:plc:mover'), 'blacksky.app');
  assert.equal(a.directory.hostOf('did:plc:new'), null, 'it moved to Bluesky while the directory was being read');
  assert.equal(a.directory.hostOf('did:plc:odd'), null);
  // saved as read, for the next start
  assert.equal(HostDirectory.fromJSON(JSON.parse(fs.readFileSync(file, 'utf8'))).readAt, NOON);
  a.onPlcEntry({ did: 'did:plc:mover', deleted: true, host: null }, relay);
  assert.equal(a.directory.hostOf('did:plc:mover'), null);
});

test('at midnight, writes the day before one last time, then the new one', async () => {
  const d = new HostDirectory();
  d.place('did:plc:1', 'eurosky.social');
  d.readAt = NOON;
  let t = Date.parse(`${DAY}T23:59:00Z`);
  const { a, written } = station({ directory: d, now: () => t });
  a.see(commit('did:plc:1', t));
  await a.onCensus([]);
  t = Date.parse('2026-10-23T00:01:00Z');
  a.see(commit('did:plc:1', t));
  await a.onCensus([]);
  const days = written.slice(1).map((w) => w.rows[0].day);
  assert.deepEqual(days, [DAY, '2026-10-23']);
});

test('leaves today alone when it cannot read back what was written', async () => {
  const d = new HostDirectory();
  d.place('did:plc:1', 'eurosky.social');
  d.readAt = NOON;
  const written = [];
  const a = createHostActivity({ upsert: async (...w) => written.push(w), getAll: async () => { throw new Error('down'); }, now: () => NOON, read: async () => d });
  a.see(commit('did:plc:1'));
  await a.onCensus([]);
  assert.equal(written.length, 0);
});

test('a sketch row as Supabase holds it', () => {
  assert.match(toBytea(Buffer.from([2, 12])), /^\\x020c$/);
});

test('moves made while the directory is being read are carried over into it', async () => {
  let open;
  const gate = new Promise((r) => (open = r));
  const read = async () => {
    await gate;
    const d = new HostDirectory();
    d.place('did:plc:stays', 'eurosky.social');
    d.place('did:plc:leaves', 'eurosky.social');
    d.readAt = NOON;
    return d;
  };
  const a = createHostActivity({ upsert: async () => {}, getAll: async () => [], now: () => NOON, read });
  await a.onCensus([]);
  assert.ok(a.reading, 'still reading');
  const relay = new Set(['eurosky.social', 'blacksky.app']);
  a.onPlcEntry({ did: 'did:plc:arrives', host: 'blacksky.app' }, relay);
  a.onPlcEntry({ did: 'did:plc:leaves', host: 'morel.us-east.host.bsky.network' }, relay);
  open();
  await a.reading;
  assert.equal(a.directory.hostOf('did:plc:stays'), 'eurosky.social');
  assert.equal(a.directory.hostOf('did:plc:arrives'), 'blacksky.app');
  assert.equal(a.directory.hostOf('did:plc:leaves'), null);
});

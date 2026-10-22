// The census of PDS hosts: paging the relay's list, what moved, and the reading's `hosts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchHosts, HostCensus, hostOf, isBlueskyHost, isHostname, STALE_MS, summarizeHosts, WRITING_MS } from '../src/hosts.js';

const host = (hostname, accounts, status = 'active', seq = 1) => ({ hostname, accounts, status, seq });

test('bluesky hosts are the mushrooms', () => {
  assert.equal(isBlueskyHost('amanita.us-east.host.bsky.network'), true);
  assert.equal(isBlueskyHost('blacksky.app'), false);
  assert.equal(isBlueskyHost('host.bsky.network.evil.example'), false);
});

test('only plain hostnames are repeated', () => {
  assert.equal(isHostname('pds.sprk.so'), true);
  assert.equal(isHostname('localhost'), false);
  assert.equal(isHostname('pds.example.com:2583'), false);
  assert.equal(isHostname('<b>x</b>.com'), false);
});

test('hostOf checks each entry', () => {
  assert.deepEqual(hostOf({ hostname: 'Eurosky.Social', status: 'active', accountCount: 38029, seq: 7 }), { hostname: 'eurosky.social', status: 'active', accounts: 38029, seq: 7 });
  assert.deepEqual(hostOf({ hostname: 'x.dev' }), { hostname: 'x.dev', status: 'unknown', accounts: 0, seq: null });
  assert.equal(hostOf(null), null);
  assert.equal(hostOf({ accountCount: 3 }), null);
});

test('summarizeHosts: counts, accounts, hosting diversity, top hosts', () => {
  const hosts = [
    host('amanita.us-east.host.bsky.network', 9000),
    host('porcini.us-east.host.bsky.network', 9000),
    host('blacksky.app', 1000),
    host('eurosky.social', 1000),
    host('gone.example', 500, 'offline'),
    host('empty.example', 0),
    host('localhost', 5),
  ];
  const s = summarizeHosts(hosts, { measuredAt: '2026-10-22T00:00:00.000Z' });
  assert.equal(s.listed, 7);
  assert.equal(s.active, 6);
  assert.equal(s.bluesky, 2);
  assert.equal(s.independent, 4);
  assert.equal(s.writing, null);
  assert.deepEqual(s.accounts, { bluesky: 18000, independent: 2005 });
  // 2005 of 20005 accounts, spread over about two hosts
  assert.equal(s.diversity.share, 10.02);
  assert.ok(s.diversity.spread > 2 && s.diversity.spread < 2.1);
  assert.equal(s.diversity.index, Math.round(s.diversity.share * Math.sqrt(s.diversity.spread) * 100) / 100);
  assert.deepEqual(s.top, [
    { hostname: 'blacksky.app', accounts: 1000 },
    { hostname: 'eurosky.social', accounts: 1000 },
  ]);
});

test('summarizeHosts: nobody independent is 0, not NaN', () => {
  const s = summarizeHosts([host('a.host.bsky.network', 10)], {});
  assert.deepEqual(s.diversity, { index: 0, share: 0, spread: 0 });
  assert.deepEqual(summarizeHosts([], {}).diversity, { index: 0, share: 0, spread: 0 });
});

test('HostCensus: writing is the hosts whose seq moved, within the last hour', () => {
  const c = new HostCensus();
  const t0 = Date.parse('2026-10-22T00:00:00Z');
  assert.equal(c.summary(t0), null);
  c.record([host('a.host.bsky.network', 10, 'active', 1), host('quiet.example', 5, 'active', 1), host('busy.example', 5, 'active', 1)], t0);
  // one census: nothing has had a chance to move yet
  assert.equal(c.summary(t0).writing, null);
  c.record([host('a.host.bsky.network', 10, 'active', 2), host('quiet.example', 5, 'active', 1), host('busy.example', 5, 'active', 9)], t0 + 600_000);
  assert.deepEqual(c.summary(t0 + 600_000).writing, { bluesky: 1, independent: 1, minutes: 10 });
  // an hour and more later, with nothing moving since, busy.example has gone quiet
  c.record([host('a.host.bsky.network', 10, 'active', 3), host('quiet.example', 5, 'active', 1), host('busy.example', 5, 'active', 9)], t0 + 600_000 + WRITING_MS);
  assert.deepEqual(c.summary(t0 + 600_000 + WRITING_MS).writing, { bluesky: 1, independent: 0, minutes: 60 });
  // a census nobody refreshed goes stale
  assert.equal(c.summary(t0 + 600_000 + WRITING_MS + STALE_MS + 1), null);
});

test('fetchHosts pages through the list', async () => {
  const pages = { '': { cursor: '2', hosts: [{ hostname: 'a.example', accountCount: 1, status: 'active', seq: 1 }, { hostname: 'b.example', accountCount: 2, status: 'idle', seq: 1 }] }, 2: { cursor: '3', hosts: [{ hostname: 'c.example', accountCount: 3, status: 'active', seq: 1 }] }, 3: { hosts: [] } };
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url.searchParams.get('cursor') ?? '');
    return new Response(JSON.stringify(pages[url.searchParams.get('cursor') ?? '']));
  };
  const hosts = await fetchHosts(fetchImpl, 'https://relay.example');
  assert.deepEqual(asked, ['', '2', '3']);
  assert.deepEqual(hosts.map((h) => h.hostname), ['a.example', 'b.example', 'c.example']);
});

test('fetchHosts: a failed page fails the census', async () => {
  let n = 0;
  const fetchImpl = async () => (n++ === 0 ? new Response(JSON.stringify({ cursor: '2', hosts: [{ hostname: 'a.example' }] })) : new Response('no', { status: 502 }));
  await assert.rejects(fetchHosts(fetchImpl, 'https://relay.example'), /502/);
});

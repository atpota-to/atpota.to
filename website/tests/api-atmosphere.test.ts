import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api/atmosphere.js';
import {
  accountOf,
  addEvent,
  appDomain,
  CACHE_LIVE,
  CACHE_OK,
  CONNECT_TIMEOUT_MS,
  conditionFor,
  fromStation,
  STATION_URL,
  diversityIndex,
  diversityLevel,
  diversityOf,
  emptyTally,
  eventOf,
  isBluesky,
  isNsid,
  MAX_COLLECTIONS,
  NOBODY,
  spreadOf,
  summarize,
  createAtmosphereHandlers,
  JETSTREAMS,
  jetstreamUrl,
  metricOf,
  sample,
  SAMPLE_MS,
  type SocketLike,
} from '../server/atmosphere.js';

// /api/atmosphere with a scripted fake Jetstream: each socket opens, then emits the
// messages it was given, spread over the sample window.

const commit = (collection: string, operation = 'create', did = 'did:plc:x') => JSON.stringify({ did, kind: 'commit', commit: { operation, collection } });

class FakeSocket implements SocketLike {
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  closed = false;
  close() {
    this.closed = true;
  }
}

type Script = { fail?: 'error' | 'never-open'; messages?: string[] };

function opener(scripts: Script[]) {
  const urls: string[] = [];
  const sockets: FakeSocket[] = [];
  const open = (url: string) => {
    urls.push(url);
    const socket = new FakeSocket();
    sockets.push(socket);
    const script = scripts[urls.length - 1] ?? {};
    setTimeout(() => {
      if (script.fail === 'error') return socket.onerror?.({});
      if (script.fail === 'never-open') return;
      socket.onopen?.({});
      (script.messages ?? []).forEach((data, i) => setTimeout(() => socket.onmessage?.({ data }), 10 + i));
    }, 5);
    return socket;
  };
  return { open, urls, sockets };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('reading the firehose', () => {
  it('asks Jetstream for the whole firehose', () => {
    const url = new URL(jetstreamUrl(JETSTREAMS[0]));
    expect(url.searchParams.getAll('wantedCollections')).toEqual([]);
  });

  it('sorts every message into new records (by collection), edits, deletions, identity and account events', () => {
    expect(eventOf(commit('sh.tangled.repo'))).toEqual({ kind: 'create', collection: 'sh.tangled.repo' });
    expect(eventOf(commit('app.bsky.feed.post', 'update'))).toEqual({ kind: 'update' });
    expect(eventOf(commit('app.bsky.feed.post', 'delete'))).toEqual({ kind: 'delete' });
    expect(eventOf(JSON.stringify({ kind: 'identity' }))).toEqual({ kind: 'identity' });
    expect(eventOf(JSON.stringify({ kind: 'account' }))).toEqual({ kind: 'account' });
    // a collection name that isn't an NSID is not repeated anywhere
    expect(eventOf(commit('<img src=x onerror=alert(1)>'))).toBeNull();
    expect(eventOf(commit('nodots'))).toBeNull();
    expect(eventOf('nope')).toBeNull();
  });

  it('tells bluesky from everyone else, and names apps by domain', () => {
    expect(isBluesky('app.bsky.feed.like')).toBe(true);
    expect(isBluesky('chat.bsky.actor.declaration')).toBe(true);
    expect(isBluesky('app.bskyish.thing')).toBe(false);
    expect(appDomain('sh.tangled.repo.pull')).toBe('tangled.sh');
    expect(appDomain('fyi.unravel.frontpage.post')).toBe('unravel.fyi');
    expect(isNsid('com.whtwnd.blog.entry')).toBe(true);
    expect(isNsid('a.b')).toBe(false);
  });

  it('reads the diversity index like the UV index', () => {
    expect(diversityLevel(0)).toBe('low');
    expect(diversityLevel(2.99)).toBe('low');
    expect(diversityLevel(3)).toBe('moderate');
    expect(diversityLevel(6)).toBe('high');
    expect(diversityLevel(8)).toBe('very high');
    expect(diversityLevel(11)).toBe('extreme');
  });

  it('sums a sample up: the split, the index, the busiest apps and collections', () => {
    const tally = emptyTally();
    const add = (collection: string, n: number) => {
      for (let i = 0; i < n; i++) addEvent(tally, { kind: 'create', collection });
    };
    add('app.bsky.feed.like', 150);
    add('app.bsky.feed.post', 40);
    add('sh.tangled.repo', 4);
    add('sh.tangled.feed.star', 6);
    add('com.whtwnd.blog.entry', 2);
    addEvent(tally, { kind: 'delete' });
    addEvent(tally, { kind: 'identity' });
    const r = summarize(tally, 2, '2026-10-20T00:00:00.000Z', { active: 40, elsewhere: 3, apps: [2, 1] });
    expect(r.records).toEqual({ perSecond: 101, bluesky: 95, elsewhere: 6 });
    expect(r.diversity).toEqual({ index: 10.31, level: 'very high', share: 7.5, spread: 1.89, apps: 2, collections: 5 });
    expect(r.apps).toEqual([
      { domain: 'tangled.sh', count: 10, perSecond: 5, collections: ['sh.tangled.feed.star', 'sh.tangled.repo'] },
      { domain: 'whtwnd.com', count: 2, perSecond: 1, collections: ['com.whtwnd.blog.entry'] },
    ]);
    expect(r.bluesky.map((b) => b.nsid)).toEqual(['app.bsky.feed.like', 'app.bsky.feed.post']);
    expect(r.perSecond).toEqual({ posts: 20, likes: 75, reposts: 0, follows: 0 });
    expect(r.events).toEqual({ creates: 101, updates: 0, deletes: 0.5, identity: 0.5, account: 0 });
  });

  it('keeps counting, without names, past MAX_COLLECTIONS collections', () => {
    const tally = emptyTally();
    for (let i = 0; i <= MAX_COLLECTIONS; i++) addEvent(tally, { kind: 'create', collection: `com.spam${i}.thing` });
    expect(tally.creates.size).toBe(MAX_COLLECTIONS);
    expect(tally.unnamed).toBe(1);
    expect(summarize(tally, 1, '').records.elsewhere).toBe(MAX_COLLECTIONS + 1);
  });

  it('an empty sample has an index of 0', () => {
    expect(summarize(emptyTally(), 1, '').diversity).toEqual({ index: 0, level: 'low', share: 0, spread: 0, apps: 0, collections: 0 });
  });

  it('spread: how many apps a crowd is spread across, as an effective number', () => {
    expect(spreadOf([10, 10, 10, 10])).toBe(4);
    expect(spreadOf([7])).toBe(1);
    expect(spreadOf([])).toBe(0);
    expect(spreadOf([0, 0])).toBe(0);
    // one app with nearly everyone is nearly one app, however many others have an account
    const crowded = spreadOf([990, ...Array(10).fill(1)]);
    expect(crowded).toBeGreaterThan(1);
    expect(crowded).toBeLessThan(1.1);
  });

  it('works the diversity index out from accounts and their spread, not from records', () => {
    expect(diversityOf(NOBODY)).toEqual({ index: 0, share: 0, spread: 0 });
    // half a percent of 10,000 accounts, evenly across ten apps, or all in one
    const even = { active: 10_000, elsewhere: 50, apps: Array(10).fill(5) };
    expect(diversityOf(even)).toEqual({ index: 1.58, share: 0.5, spread: 10 });
    expect(diversityOf({ active: 10_000, elsewhere: 50, apps: [50] })).toEqual({ index: 0.5, share: 0.5, spread: 1 });
    // one more account, in an app of its own, however many records it writes
    expect(diversityOf({ active: 10_001, elsewhere: 51, apps: [...even.apps, 1] })).toEqual({ index: 1.65, share: 0.51, spread: 10.53 });
    // sketches can count a few more elsewhere than active
    expect(diversityOf({ active: 3, elsewhere: 4, apps: [4] }).share).toBe(100);
    expect(diversityIndex(0.5, 10)).toBe(1.58);
  });

  it('knows whose a commit is, by the station\'s rules', () => {
    expect(accountOf(commit('app.bsky.feed.like'))).toEqual({ did: 'did:plc:x', app: null });
    expect(accountOf(commit('sh.tangled.repo', 'delete'))).toEqual({ did: 'did:plc:x', app: 'tangled.sh' });
    expect(accountOf(commit('sh.tangled.repo', 'create', 'not a did'))).toBeNull();
    expect(accountOf(commit('nodots'))).toBeNull();
    expect(accountOf(JSON.stringify({ did: 'did:plc:x', kind: 'identity' }))).toBeNull();
    expect(accountOf('nope')).toBeNull();
  });

  it('counts only new records in the collections it watches', () => {
    expect(metricOf(commit('app.bsky.feed.post'))).toBe('posts');
    expect(metricOf(commit('app.bsky.feed.like'))).toBe('likes');
    expect(metricOf(commit('app.bsky.feed.repost'))).toBe('reposts');
    expect(metricOf(commit('app.bsky.graph.follow'))).toBe('follows');
    expect(metricOf(commit('app.bsky.feed.like', 'delete'))).toBeNull();
    expect(metricOf(commit('app.bsky.graph.block'))).toBeNull();
    expect(metricOf(JSON.stringify({ kind: 'identity' }))).toBeNull();
    expect(metricOf('not json')).toBeNull();
    expect(metricOf(42)).toBeNull();
  });

  it('names the weather from new records a second, every app', () => {
    expect(conditionFor(120)).toBe('calm');
    expect(conditionFor(300)).toBe('light');
    expect(conditionFor(458)).toBe('breezy');
    expect(conditionFor(500)).toBe('gusty');
    expect(conditionFor(800)).toBe('stormy');
  });

  it('turns a few seconds of messages into rates per second', async () => {
    vi.useFakeTimers();
    let t = 0;
    const net = opener([{ messages: [...Array(6).fill(commit('app.bsky.feed.post')), ...Array(30).fill(commit('app.bsky.feed.like')), commit('app.bsky.graph.follow')] }]);
    const reading = sample(net.open, 'wss://x', () => t, 2000);
    await vi.advanceTimersByTimeAsync(5);
    t = 0;
    await vi.advanceTimersByTimeAsync(1995);
    t = 2000;
    await vi.advanceTimersByTimeAsync(10);
    const r = await reading;
    expect(r.perSecond).toEqual({ posts: 3, likes: 15, reposts: 0, follows: 0.5 });
    expect(r.condition).toBe('calm');
    expect(net.sockets[0]!.closed).toBe(true);
  });

  it('works its diversity index out from the accounts it heard, however much one of them wrote', async () => {
    vi.useFakeTimers();
    let t = 0;
    const messages = [
      ...Array.from({ length: 96 }, (_, i) => commit('app.bsky.feed.like', 'create', `did:plc:b${i}`)),
      ...Array(500).fill(commit('org.titlegraph.title', 'create', 'did:plc:bot')),
      commit('sh.tangled.repo', 'create', 'did:plc:t1'),
      commit('sh.tangled.repo', 'create', 'did:plc:t2'),
      commit('blue.mado.note', 'update', 'did:plc:m1'),
      // also on bluesky: one more account elsewhere, not one more active
      commit('blue.mado.note', 'create', 'did:plc:b0'),
    ];
    const reading = sample(opener([{ messages }]).open, 'wss://x', () => t, 2000);
    await vi.advanceTimersByTimeAsync(5);
    t = 2000;
    await vi.advanceTimersByTimeAsync(2000);
    const r = await reading;
    // 100 accounts, 5 of them elsewhere, across titlegraph.org (1), tangled.sh (2) and mado.blue (2)
    expect(r.diversity).toMatchObject({ share: 5, spread: 2.87, index: 8.47 });
    expect(r.records.elsewhere).toBeGreaterThan(r.records.bluesky);
    expect(r.accounts).toBeUndefined();
  });

  // Until 2026-10-21 the connect timeout kept running after the socket opened, and with the
  // real timings (a 5 s sample, a 4 s connect timeout) it always fired first: every sample
  // in production failed as "jetstream did not connect". The tests above use shorter samples.
  it('samples for the full SAMPLE_MS once connected, with the real timings', async () => {
    expect(SAMPLE_MS).toBeGreaterThan(CONNECT_TIMEOUT_MS);
    vi.useFakeTimers();
    let t = 0;
    const net = opener([{ messages: [commit('app.bsky.feed.post'), commit('app.bsky.feed.like')] }]);
    const reading = sample(net.open, 'wss://x', () => t);
    const settled = reading.then(
      (r) => r,
      (e: Error) => e,
    );
    await vi.advanceTimersByTimeAsync(5);
    t = SAMPLE_MS;
    await vi.advanceTimersByTimeAsync(SAMPLE_MS + 10);
    const r = await settled;
    expect(r).not.toBeInstanceOf(Error);
    expect((r as Awaited<typeof reading>).seconds).toBe(SAMPLE_MS / 1000);
  });

  it('refuses a silent stream, an error, or a socket that never opens', async () => {
    vi.useFakeTimers();
    for (const script of [{ messages: [] }, { fail: 'error' as const }, { fail: 'never-open' as const }]) {
      const net = opener([script]);
      const reading = sample(net.open, 'wss://x', () => 0, 1000, 3000);
      const settled = reading.then(
        () => 'resolved',
        () => 'rejected',
      );
      await vi.advanceTimersByTimeAsync(4000);
      expect(await settled).toBe('rejected');
    }
  });
});

describe('/api/atmosphere', () => {
  it('answers with the reading, cached for a minute at the CDN', async () => {
    vi.useFakeTimers();
    const net = opener([{ messages: [commit('app.bsky.feed.post'), commit('app.bsky.feed.like')] }]);
    const h = createAtmosphereHandlers({ open: net.open, now: () => 0, sampleMs: 1000, log: () => undefined });
    const pending = h.GET(new Request('https://atpota.to/api/atmosphere'));
    await vi.advanceTimersByTimeAsync(1100);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CACHE_OK);
    const body = (await res.json()) as { perSecond: Record<string, number>; condition: string };
    expect(Object.keys(body.perSecond).sort()).toEqual(['follows', 'likes', 'posts', 'reposts']);
    expect(body.condition).toBe('calm');
  });

  it('falls back to the second Jetstream, and says 503 when both fail', async () => {
    vi.useFakeTimers();
    const net = opener([{ fail: 'error' }, { messages: [commit('app.bsky.feed.post')] }]);
    const h = createAtmosphereHandlers({ open: net.open, now: () => 0, sampleMs: 1000, log: () => undefined });
    const ok = h.GET(new Request('https://atpota.to/api/atmosphere'));
    await vi.advanceTimersByTimeAsync(1200);
    expect((await ok).status).toBe(200);
    expect(net.urls.map((u) => u.split('?')[0])).toEqual([...JETSTREAMS]);

    const down = opener([{ fail: 'error' }, { fail: 'error' }]);
    const h2 = createAtmosphereHandlers({ open: down.open, now: () => 0, sampleMs: 1000, log: () => undefined });
    const bad = h2.GET(new Request('https://atpota.to/api/atmosphere'));
    await vi.advanceTimersByTimeAsync(100);
    const res = await bad;
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('only takes GET and HEAD', async () => {
    const res = await api.POST(new Request('https://atpota.to/api/atmosphere', { method: 'POST' }));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });
});

// The weather station's rolling 60 seconds (atmosphere/SPEC.md), as the station sends it.
const STATION = {
  measuredAt: '2026-10-20T16:18:00.000Z',
  seconds: 60,
  perSecond: { posts: 51, likes: 308, reposts: 52.2, follows: 24.1 },
  condition: 'stormy',
  records: { perSecond: 444, bluesky: 436, elsewhere: 8 },
  diversity: { index: 1.8, level: 'low', share: 0.52, spread: 12, apps: 12, collections: 40 },
  apps: [{ domain: 'tangled.sh', perSecond: 4, count: 240, collections: ['sh.tangled.repo'] }],
  bluesky: [{ nsid: 'app.bsky.feed.like', perSecond: 308, count: 18480 }],
  events: { creates: 444, updates: 3.6, deletes: 13.5, identity: 0.5, account: 0.2 },
  window: { from: '2026-10-20T16:17:00.000Z', to: '2026-10-20T16:18:00.000Z' },
  series: [{ t: 1792512960, creates: 451, bluesky: 449, elsewhere: 2, posts: 48 }, null],
};

describe('reading the weather station', () => {
  it('takes a station reading, rebuilt from the fields it knows', () => {
    const r = fromStation({ ...STATION, extra: 'ignored' })!;
    expect(r.source).toBe('station');
    expect(r.seconds).toBe(60);
    expect(r.condition).toBe('breezy'); // 444 records a second
    expect(r.series).toEqual(STATION.series);
    expect(r.window).toEqual(STATION.window);
    expect('extra' in r).toBe(false);
  });

  it('works out the words itself, and drops names that do not check out', () => {
    const r = fromStation({
      ...STATION,
      condition: 'hail',
      records: { perSecond: 640, bluesky: 630, elsewhere: 10 },
      diversity: { ...STATION.diversity, index: 1, share: 3, spread: 9, level: 'nonsense' },
      apps: [{ domain: '<b>x</b>', perSecond: 1, count: 1, collections: [] }, { domain: 'ok.app', perSecond: 1, count: 1, collections: ['<i>', 'app.ok.thing'] }],
      bluesky: [{ nsid: 'sh.tangled.repo', perSecond: 1, count: 1 }],
    })!;
    expect(r.condition).toBe('stormy');
    expect(r.diversity).toEqual({ index: 9, level: 'very high', share: 3, spread: 9, apps: 12, collections: 40 });
    expect(r.apps).toEqual([{ domain: 'ok.app', perSecond: 1, count: 1, collections: ['app.ok.thing'] }]);
    expect(r.bluesky).toEqual([]);
  });

  it('passes the station\'s active accounts through, checked, and does without them when they are off', () => {
    const accounts = {
      active: 21000,
      bluesky: 20800,
      elsewhere: 610,
      index: 2.9,
      apps: [
        { domain: 'tangled.sh', accounts: 120, collections: ['sh.tangled.feed.star', '<b>'] },
        { domain: '<script>', accounts: 9, collections: [] },
        { domain: 'whtwnd.com', accounts: -1, collections: [] },
      ],
    };
    expect(fromStation({ ...STATION, accounts })!.accounts).toEqual({
      active: 21000,
      bluesky: 20800,
      elsewhere: 610,
      index: 2.9,
      apps: [{ domain: 'tangled.sh', accounts: 120, collections: ['sh.tangled.feed.star'] }],
    });
    expect(fromStation(STATION)!.accounts).toBeUndefined();
    expect(fromStation({ ...STATION, accounts: { ...accounts, active: 'lots' } })!.accounts).toBeUndefined();
    expect(fromStation({ ...STATION, accounts: { ...accounts, apps: null } })!.accounts).toBeUndefined();
  });

  it('passes the station\'s census of hosts through, checked, working the index out itself', () => {
    const hosts = {
      measuredAt: '2026-10-22T13:20:00.000Z',
      listed: 6442,
      active: 1887,
      bluesky: 90,
      independent: 1797,
      writing: { bluesky: 90, independent: 640, minutes: 60 },
      accounts: { bluesky: 23767508, independent: 363866 },
      diversity: { index: 99, share: 1.51, spread: 24.54 },
      top: [
        { hostname: 'blacksky.app', accounts: 42366 },
        { hostname: '<b>x</b>.com', accounts: 9 },
        { hostname: 'localhost', accounts: 9 },
        { hostname: 'eurosky.social', accounts: -1 },
      ],
      extra: 'ignored',
    };
    expect(fromStation({ ...STATION, hosts })!.hosts).toEqual({
      measuredAt: '2026-10-22T13:20:00.000Z',
      listed: 6442,
      active: 1887,
      bluesky: 90,
      independent: 1797,
      writing: { bluesky: 90, independent: 640, minutes: 60 },
      accounts: { bluesky: 23767508, independent: 363866 },
      diversity: { index: 7.48, share: 1.51, spread: 24.54 },
      top: [{ hostname: 'blacksky.app', accounts: 42366 }],
    });
    expect(fromStation({ ...STATION, hosts: { ...hosts, writing: null } })!.hosts!.writing).toBeNull();
    // the census's extras, each kept only when it checks out
    const extras = fromStation({
      ...STATION,
      hosts: {
        ...hosts,
        statuses: { active: 1888, idle: 310, offline: 4174, throttled: 0, banned: 70, other: 0 },
        sizes: [8, 764, 737, 204, 58, 18, 9],
        tlds: [{ tld: 'com', hosts: 257, accounts: 7455 }, { tld: '<b>', hosts: 1, accounts: 1 }],
      },
    })!.hosts!;
    expect(extras.statuses).toEqual({ active: 1888, idle: 310, offline: 4174, throttled: 0, banned: 70, other: 0 });
    expect(extras.sizes).toEqual([8, 764, 737, 204, 58, 18, 9]);
    expect(extras.tlds).toEqual([{ tld: 'com', hosts: 257, accounts: 7455 }]);
    const off = fromStation({ ...STATION, hosts: { ...hosts, statuses: { active: 'many' }, sizes: [1, 2] } })!.hosts!;
    expect(off.statuses).toBeUndefined();
    expect(off.sizes).toBeUndefined();
    expect(fromStation(STATION)!.hosts).toBeUndefined();
    expect(fromStation({ ...STATION, hosts: { ...hosts, active: 'lots' } })!.hosts).toBeUndefined();
    expect(fromStation({ ...STATION, hosts: { ...hosts, top: null } })!.hosts).toBeUndefined();
  });

  it('works the index out from an older station\'s accounts, which sends no share or spread', () => {
    const accounts = { active: 21000, bluesky: 20800, elsewhere: 210, index: 1, apps: [30, 30, 30, 30].map((n, i) => ({ domain: `app${i}.test`, accounts: n, collections: [] })) };
    const older = { ...STATION, diversity: { index: 0.6, level: 'low', apps: 12, collections: 40 } };
    expect(fromStation({ ...older, accounts })!.diversity).toEqual({ index: 2, level: 'low', share: 1, spread: 4, apps: 12, collections: 40 });
    expect(fromStation(older)).toBeNull();
  });

  it('refuses a reading missing its numbers', () => {
    expect(fromStation(null)).toBeNull();
    expect(fromStation({ ...STATION, seconds: 0 })).toBeNull();
    expect(fromStation({ ...STATION, records: { perSecond: -1, bluesky: 0, elsewhere: 0 } })).toBeNull();
    expect(fromStation({ ...STATION, apps: 'nope' })).toBeNull();
  });

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('asks the station with the secret, and caches its answer for 5 seconds at the CDN', async () => {
    const calls: Array<{ url: string; secret: string | null }> = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, secret: new Headers(init?.headers).get('x-atpotato-weather-secret') });
      return json(STATION);
    }) as typeof globalThis.fetch;
    const net = opener([]);
    const h = createAtmosphereHandlers({ open: net.open, fetch, env: () => ({ ATMOSPHERE_STATION_SECRET: 's3cret' }), log: () => undefined });
    const res = await h.GET(new Request('https://atpota.to/api/atmosphere'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CACHE_LIVE);
    expect(((await res.json()) as { source: string }).source).toBe('station');
    expect(calls).toEqual([{ url: STATION_URL, secret: 's3cret' }]);
    expect(net.urls).toEqual([]); // no sampling of our own
    await h.GET(new Request('https://atpota.to/api/atmosphere'));
    expect(calls).toHaveLength(1); // reused for a moment
  });

  it('samples by itself when the station is down, and leaves the station alone for a while', async () => {
    vi.useFakeTimers();
    let t = 0;
    let asked = 0;
    const fetch = (async () => {
      asked += 1;
      return json({ error: 'unavailable' }, 503);
    }) as typeof globalThis.fetch;
    const net = opener([{ messages: [commit('app.bsky.feed.post')] }, { messages: [commit('app.bsky.feed.post')] }]);
    const h = createAtmosphereHandlers({ open: net.open, fetch, now: () => t, sampleMs: 1000, env: () => ({ ATMOSPHERE_STATION_SECRET: 's' }), log: () => undefined });
    const first = h.GET(new Request('https://atpota.to/api/atmosphere'));
    await vi.advanceTimersByTimeAsync(1100);
    const res = await first;
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CACHE_OK);
    expect(((await res.json()) as { source: string }).source).toBe('sample');
    t = 10_000;
    const again = h.GET(new Request('https://atpota.to/api/atmosphere'));
    await vi.advanceTimersByTimeAsync(1100);
    await again;
    expect(asked).toBe(1);
  });

  it('without a secret, never calls the station', async () => {
    vi.useFakeTimers();
    let asked = 0;
    const fetch = (async () => {
      asked += 1;
      return json(STATION);
    }) as typeof globalThis.fetch;
    const net = opener([{ messages: [commit('app.bsky.feed.post')] }]);
    const h = createAtmosphereHandlers({ open: net.open, fetch, now: () => 0, sampleMs: 1000, env: () => ({}), log: () => undefined });
    const pending = h.GET(new Request('https://atpota.to/api/atmosphere'));
    await vi.advanceTimersByTimeAsync(1100);
    expect((await pending).status).toBe(200);
    expect(asked).toBe(0);
  });
});

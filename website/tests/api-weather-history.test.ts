import { describe, expect, it } from 'vitest';
import * as api from '../api/weather-history.js';
import { burstHours, byMonth, createHistoryHandlers, PARTIAL_CACHE, queryUrl, RANGES, SUPABASE_URL, sumPoints, toApp, toPoint, trendArgs, type App, type Burst, type Point } from '../server/weather-history.js';
import * as hosts from '../server/weather-hosts.js';

// /api/weather-history against a scripted Supabase.

const NOW = Date.parse('2026-10-20T17:00:00.000Z');
const row = (minute: string, extra: Record<string, unknown> = {}) => ({
  minute,
  seconds_covered: 60,
  creates: 600,
  bluesky: 594,
  elsewhere: 6,
  posts: 60,
  likes: 400,
  reposts: 60,
  follows: 30,
  updates: 3,
  deletes: 20,
  identity: 1,
  account: 1,
  ...extra,
});

const TRENDS = {
  seconds: 3600,
  prevSeconds: '3000',
  apps: [
    { domain: 'tangled.sh', creates: '420', prevCreates: 300, collections: ['sh.tangled.repo', '<b>no</b>'] },
    { domain: '<script>', creates: 1, prevCreates: 0, collections: [] },
  ],
};
const OVER_TIME = [{ t: '2026-10-20T16:59:00+00:00', apps: 14 }, { t: 'nope', apps: 1 }];

const HOSTS = {
  since: '2026-10-22',
  points: [
    { t: '2026-10-20T16:50:00+00:00', listed: 6442, active: 1887, bluesky: 90, independent: 1797, writing: 702, accountsBluesky: 23767508, accountsIndependent: '363866', share: '1.51', spread: 24.54 },
    { t: '2026-10-20T16:40:00+00:00', listed: 6442, active: 1887, bluesky: 90, independent: 1797, writing: null, accountsBluesky: 23767508, accountsIndependent: 363866, share: 1.51, spread: 24.54, estimated: true },
    { t: 'nope', active: 1 },
  ],
  newHosts: 2,
  new: [{ hostname: 'fresh.example', accounts: 40, people: 31, first: '2026-10-23' }, { hostname: '<b>x</b>.com', accounts: 9, people: 9, first: '2026-10-23' }],
  growing: [{ hostname: 'blacksky.app', accounts: 42500, prevAccounts: 42366, people: 120 }, { hostname: 'localhost', accounts: 9, prevAccounts: 1, people: 8 }, { hostname: 'goodmkt.id', accounts: 11022, prevAccounts: 20 }],
  daily: [
    { day: '2026-10-22', active: 1880, change: null, joined: null, left: null, estimated: true },
    { day: '2026-10-23', active: '1885', change: -2, joined: 4, left: 6, estimated: false },
    { day: 'tomorrow', active: 1 },
  ],
  identities: [
    { day: '2026-10-22', ops: 170066, created_bluesky: 9946, created_independent: 4383, created_unlisted: '150845', created_custom_handle: 122, moved_out: 19, moved_in: 0, moved_between: 1, deleted: 1, destinations: [{ hostname: 'eurosky.social', accounts: 4 }, { hostname: 'Not A Host', accounts: 1 }, { hostname: 'blacksky.app', accounts: -1 }], created_bulk: 4000, bulk_hosts: [{ hostname: 'goodmkt.id', accounts: 4000, bursts: 2, seconds: 1929 }, { hostname: 'Not A Host', accounts: 5000, bursts: 1, seconds: 1 }, { hostname: 'pds.1095.me', accounts: 74 }] },
    { day: '2026-10-23', ops: 'lots' },
  ],
  activeDaily: [{ day: '2026-10-22', independent: 41000, all: 1082706 }, { day: '2026-10-23', independent: 900, all: null }, { day: 'x', independent: 1 }],
  liveliest: { day: '2026-10-22', soFar: false, hosts: [{ hostname: 'blacksky.app', active: 9000, accounts: 42900 }, { hostname: '<b>', active: 1, accounts: 1 }] },
};

type Rpc = Record<string, () => Response>;

function supabase(answer: () => Response, rpcs: Rpc = {}) {
  const urls: string[] = [];
  const bodies: Record<string, unknown> = {};
  const answers: Rpc = { atmosphere_app_trends: () => Response.json(TRENDS), atmosphere_apps_over_time: () => Response.json(OVER_TIME), atmosphere_host_trends: () => Response.json(HOSTS), ...rpcs };
  const fetch = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    const rpc = /\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    if (rpc) {
      bodies[rpc] = JSON.parse(String(init?.body));
      return (answers[rpc] ?? (() => new Response('no such function', { status: 404 })))();
    }
    return answer();
  }) as typeof globalThis.fetch;
  return { urls, bodies, fetch };
}

describe('weather history', () => {
  it('asks the right table for each range, oldest first', () => {
    const hour = new URL(queryUrl(SUPABASE_URL, 'hour', NOW));
    expect(hour.pathname).toBe('/rest/v1/atmosphere_minute');
    expect(hour.searchParams.get('minute')).toBe('gte.2026-10-20T16:00:00.000Z');
    expect(hour.searchParams.get('order')).toBe('minute.asc');
    expect(new URL(queryUrl(SUPABASE_URL, 'day', NOW)).pathname).toBe('/rest/v1/atmosphere_hour');
    const week = new URL(queryUrl(SUPABASE_URL, 'week', NOW));
    expect(week.pathname).toBe('/rest/v1/atmosphere_hour');
    expect(week.searchParams.get('hour')).toBe('gte.2026-10-13T17:00:00.000Z');
    expect(new URL(queryUrl(SUPABASE_URL, 'month', NOW)).searchParams.get('day')).toBe('gte.2026-09-20T17:00:00.000Z');
    expect(Object.keys(RANGES)).toEqual(['hour', 'day', 'week', 'month', 'year']);
  });

  it('reads rows, including sums that arrive as strings, and refuses odd ones', () => {
    expect(toPoint(row('2026-10-20T16:59:00+00:00', { creates: '600' }), 'minute')).toMatchObject({ t: '2026-10-20T16:59:00.000Z', seconds: 60, creates: 600 });
    expect(toPoint(row('nope'), 'minute')).toBeNull();
    expect(toPoint(row('2026-10-20T16:59:00Z', { seconds_covered: 0 }), 'minute')).toBeNull();
    expect(toPoint(row('2026-10-20T16:59:00Z', { elsewhere: -1 }), 'minute')).toBeNull();
    expect(toPoint('x', 'minute')).toBeNull();
  });

  it('adds days up into months', () => {
    const p = (t: string) => toPoint({ ...row(t), day: t }, 'day')!;
    const months = byMonth([p('2026-09-30T00:00:00Z'), p('2026-10-01T00:00:00Z'), p('2026-10-02T00:00:00Z')]);
    expect(months.map((m) => [m.t, m.seconds, m.creates])).toEqual([
      ['2026-09-01T00:00:00.000Z', 60, 600],
      ['2026-10-01T00:00:00.000Z', 120, 1200],
    ]);
    expect(sumPoints([] as Point[], 'x')).toMatchObject({ seconds: 0, creates: 0 });
  });

  it('answers with points and their total, cached by range', async () => {
    const db = supabase(() => Response.json([row('2026-10-20T16:58:00+00:00'), row('2026-10-20T16:59:00+00:00'), { junk: true }]));
    const h = createHistoryHandlers({ fetch: db.fetch, now: () => NOW, env: () => ({}), log: () => undefined });
    const res = await h.GET(new Request('https://atpota.to/api/weather-history?range=hour'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(RANGES.hour.cache);
    const body = (await res.json()) as { range: string; points: Point[]; total: Point };
    expect(body.range).toBe('hour');
    expect(body.points).toHaveLength(2);
    expect(body.total).toMatchObject({ seconds: 120, creates: 1200, elsewhere: 12 });
    expect(db.urls.some((u) => u.startsWith(`${SUPABASE_URL}/rest/v1/atmosphere_minute?`))).toBe(true);
  });

  it('adds the PDS hosts over the range, checked, each census with its hosting diversity', async () => {
    const db = supabase(() => Response.json([row('2026-10-20T16:59:00+00:00')]));
    const h = createHistoryHandlers({ fetch: db.fetch, now: () => NOW, env: () => ({}), log: () => undefined });
    const body = (await (await h.GET(new Request('https://atpota.to/api/weather-history?range=week'))).json()) as { hosts: unknown };
    expect(db.bodies.atmosphere_host_trends).toEqual({ since: '2026-10-13T17:00:00.000Z', bucket: 'hour', max_hosts: 10 });
    expect(body.hosts).toEqual({
      bucket: 'hour',
      since: '2026-10-22',
      points: [
        { t: '2026-10-20T16:50:00.000Z', active: 1887, bluesky: 90, independent: 1797, writing: 702, accountsBluesky: 23767508, accountsIndependent: 363866, share: 1.51, spread: 24.54, index: 7.48 },
        { t: '2026-10-20T16:40:00.000Z', active: 1887, bluesky: 90, independent: 1797, writing: null, accountsBluesky: 23767508, accountsIndependent: 363866, share: 1.51, spread: 24.54, index: 7.48, estimated: true },
      ],
      newHosts: 2,
      new: [{ hostname: 'fresh.example', accounts: 40, people: 31, first: '2026-10-23' }],
      // a host without the people who arrived on it isn't listed
      growing: [{ hostname: 'blacksky.app', accounts: 42500, prevAccounts: 42366, people: 120 }],
      daily: [
        { day: '2026-10-22', active: 1880, change: null, joined: null, left: null, estimated: true },
        { day: '2026-10-23', active: 1885, change: -2, joined: 4, left: 6, estimated: false },
      ],
      identities: [
        { day: '2026-10-22', ops: 170066, createdBluesky: 9946, createdIndependent: 4383, createdUnlisted: 150845, createdCustomHandle: 122, movedOut: 19, movedIn: 0, movedBetween: 1, deleted: 1, createdBulk: 4000, bulk: [{ hostname: 'goodmkt.id', accounts: 4000, bursts: 2, seconds: 1929 }], createdUnnamed: 0, createdScripted: 0, scripted: [], destinations: [{ hostname: 'eurosky.social', accounts: 4 }], moves: [] },
      ],
      activeDaily: [{ day: '2026-10-22', independent: 41000, all: 1082706 }, { day: '2026-10-23', independent: 900, all: null }],
      liveliest: { day: '2026-10-22', soFar: false, hosts: [{ hostname: 'blacksky.app', active: 9000, accounts: 42900 }] },
    });
  });

  it('says which host each day\'s movers left for which, checked, and leaves the days whole when it can\'t', async () => {
    const MOVES = [
      { day: '2026-10-22', from_host: 'bluesky', to_host: 'eurosky.social', accounts: 16 },
      { day: '2026-10-22', from_host: 'pds.tophhie.cloud', to_host: 'blacksky.app', accounts: '2' },
      { day: '2026-10-22', from_host: 'pds.tophhie.cloud', to_host: 'bluesky', accounts: 1 },
      // someone else's text, and rows that say nothing
      { day: '2026-10-22', from_host: '<b>x</b>', to_host: 'eurosky.social', accounts: 1 },
      { day: '2026-10-22', from_host: 'Bluesky', to_host: 'eurosky.social', accounts: 1 },
      { day: '2026-10-22', from_host: 'bluesky', to_host: 'bluesky', accounts: 1 },
      { day: '2026-10-22', from_host: 'bluesky', to_host: 'blacksky.app', accounts: 0 },
      { day: 'today', from_host: 'bluesky', to_host: 'blacksky.app', accounts: 1 },
      // a day the hosts' answer has no identities for
      { day: '2026-10-19', from_host: 'bluesky', to_host: 'blacksky.app', accounts: 3 },
    ];
    const urls: string[] = [];
    const scripted = (moves: () => Response) =>
      (async (url: string) => {
        urls.push(url);
        if (url.endsWith('/rpc/atmosphere_host_trends')) return Response.json(HOSTS);
        if (url.includes('/rpc/')) return new Response('no', { status: 404 });
        if (url.includes('atmosphere_host_move_day')) return moves();
        return Response.json([row('2026-10-20T16:59:00+00:00')]);
      }) as typeof globalThis.fetch;
    const identities = async (fetch: typeof globalThis.fetch) => {
      const h = createHistoryHandlers({ fetch, now: () => NOW, env: () => ({}), log: () => undefined });
      const body = (await (await h.GET(new Request('https://atpota.to/api/weather-history?range=week'))).json()) as { hosts: { identities: Array<{ day: string; moves: unknown }> } };
      return body.hosts.identities;
    };
    expect((await identities(scripted(() => Response.json(MOVES))))[0]).toMatchObject({
      day: '2026-10-22',
      movedOut: 19,
      moves: [
        { from: 'bluesky', to: 'eurosky.social', accounts: 16 },
        { from: 'pds.tophhie.cloud', to: 'blacksky.app', accounts: 2 },
        { from: 'pds.tophhie.cloud', to: 'bluesky', accounts: 1 },
      ],
    });
    // asked from the first day the hosts give identities for (a week of days at least), newest and biggest first
    expect(urls.find((u) => u.includes('atmosphere_host_move_day'))).toBe(
      `${SUPABASE_URL}/rest/v1/atmosphere_host_move_day?select=day,from_host,to_host,accounts&day=gte.2026-10-13&order=day.desc,accounts.desc,from_host.asc,to_host.asc&limit=1000&offset=0`,
    );
    expect(hosts.identitiesSince('2026-10-20T16:00:00.000Z', NOW)).toBe('2026-10-14');
    expect(hosts.identitiesSince('2026-09-20T17:00:00.000Z', NOW)).toBe('2026-09-20');
    // the table isn't there (the migration hasn't been applied), or it's down: the days come all the same
    expect((await identities(scripted(() => new Response('no such table', { status: 404 }))))[0]).toMatchObject({ day: '2026-10-22', movedOut: 19, moves: [] });
    expect((await identities(scripted(() => Response.json({ not: 'rows' }))))[0]).toMatchObject({ day: '2026-10-22', moves: [] });
  });

  it('names at most 25 pairs a day, and drops the oldest day when the pages run out before the range does', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ day: '2026-10-22', from_host: 'bluesky', to_host: `h${String(i).padStart(2, '0')}.example`, accounts: 40 - i }));
    const one = await hosts.readMoves({ get: async () => many, rpc: async () => null }, '2026-10-22');
    expect(one.get('2026-10-22')).toHaveLength(hosts.TOP_MOVES);
    expect(one.get('2026-10-22')![0]).toEqual({ from: 'bluesky', to: 'h00.example', accounts: 40 });
    // of pairs the same size, the ones that left an independent host are kept before the ones that left bluesky's:
    // 30 single accounts off bluesky's hosts, and two off tophhie, which sort after them by name
    const singles = [...Array.from({ length: 30 }, (_, i) => ({ day: '2026-10-22', from_host: 'bluesky', to_host: `h${String(i).padStart(2, '0')}.example`, accounts: 1 })), { day: '2026-10-22', from_host: 'pds.tophhie.cloud', to_host: 'eurosky.social', accounts: 1 }, { day: '2026-10-22', from_host: 'pds.tophhie.cloud', to_host: 'bluesky', accounts: 1 }];
    const kept = (await hosts.readMoves({ get: async () => singles, rpc: async () => null }, '2026-10-22')).get('2026-10-22')!;
    expect(kept).toHaveLength(hosts.TOP_MOVES);
    expect(kept.slice(0, 2)).toEqual([{ from: 'pds.tophhie.cloud', to: 'bluesky', accounts: 1 }, { from: 'pds.tophhie.cloud', to: 'eurosky.social', accounts: 1 }]);
    expect(kept.at(-1)).toEqual({ from: 'bluesky', to: 'h22.example', accounts: 1 });
    // every page comes back full: the last day read may be cut short, so it isn't known
    const asked: string[] = [];
    const full = (day: string) => Array.from({ length: hosts.MOVE_ROWS }, (_, i) => ({ day, from_host: 'bluesky', to_host: `h${i}.example`, accounts: 1 }));
    const days = ['2026-10-22', '2026-10-21', '2026-10-20', '2026-10-19', '2026-10-18', '2026-10-17'];
    const cut = await hosts.readMoves({ get: async (path) => (asked.push(path), full(days[asked.length - 1]!)), rpc: async () => null }, '2026-10-01');
    expect(asked).toHaveLength(hosts.MOVE_PAGES);
    expect(asked[4]).toContain('offset=4000');
    expect([...cut.keys()]).toEqual(['2026-10-22', '2026-10-21', '2026-10-20', '2026-10-19']);
    await expect(hosts.readMoves({ get: async () => 'nope', rpc: async () => null }, '2026-10-01')).rejects.toThrow('moves did not check out');
  });

  it('leaves the hosts out, and caches briefly, when they do not come', async () => {
    const db = supabase(() => Response.json([row('2026-10-20T16:59:00+00:00')]), { atmosphere_host_trends: () => Response.json({ points: 'no' }) });
    const h = createHistoryHandlers({ fetch: db.fetch, now: () => NOW, env: () => ({}), log: () => undefined });
    const res = await h.GET(new Request('https://atpota.to/api/weather-history?range=hour'));
    expect(res.headers.get('cache-control')).toBe(PARTIAL_CACHE);
    expect(((await res.json()) as { hosts?: unknown }).hosts).toBeUndefined();
  });

  it('adds the busiest apps, each against the same span earlier, and apps heard over time', async () => {
    const db = supabase(() => Response.json([row('2026-10-20T16:59:00+00:00')]));
    const h = createHistoryHandlers({ fetch: db.fetch, now: () => NOW, env: () => ({}), log: () => undefined });
    const body = (await (await h.GET(new Request('https://atpota.to/api/weather-history?range=hour'))).json()) as {
      apps: App[];
      compare: unknown;
      appsOverTime: unknown;
    };
    expect(body.apps).toEqual([{ domain: 'tangled.sh', creates: 420, prevCreates: 300, collections: ['sh.tangled.repo'] }]);
    expect(body.compare).toEqual({ seconds: 3600, prevSeconds: 3000, lagMs: 86_400_000 });
    expect(body.appsOverTime).toEqual({ bucket: 'minute', points: [{ t: '2026-10-20T16:59:00.000Z', apps: 14 }] });
    // the last hour against the same hour yesterday
    expect(db.bodies.atmosphere_app_trends).toEqual({
      since: '2026-10-20T16:00:00.000Z',
      until: '2026-10-20T17:00:00.000Z',
      prev_since: '2026-10-19T16:00:00.000Z',
      prev_until: '2026-10-19T17:00:00.000Z',
      max_apps: 10,
    });
    expect(db.bodies.atmosphere_apps_over_time).toEqual({ since: '2026-10-20T16:00:00.000Z', bucket: 'minute' });
  });

  it('compares longer ranges with the span before them, bucketed by day or month', () => {
    expect(trendArgs('month', NOW)).toMatchObject({ since: '2026-09-20T17:00:00.000Z', prev_since: '2026-08-21T17:00:00.000Z', prev_until: '2026-09-20T17:00:00.000Z' });
    expect(RANGES.month.bucket).toBe('day');
    expect(RANGES.year.bucket).toBe('month');
  });

  it('still answers with the trends when the apps call fails', async () => {
    const db = supabase(() => Response.json([row('2026-10-20T16:59:00+00:00')]), {
      atmosphere_app_trends: () => new Response('nope', { status: 404 }),
      atmosphere_apps_over_time: () => Response.json({ not: 'rows' }),
    });
    const h = createHistoryHandlers({ fetch: db.fetch, now: () => NOW, env: () => ({}), log: () => undefined });
    const res = await h.GET(new Request('https://atpota.to/api/weather-history?range=day'));
    expect(res.status).toBe(200);
    // missing pieces are only cached briefly, so they come back soon
    expect(res.headers.get('cache-control')).toBe(PARTIAL_CACHE);
    const body = (await res.json()) as object;
    expect('apps' in body || 'compare' in body || 'appsOverTime' in body).toBe(false);
  });

  it('reads app rows, and refuses odd names', () => {
    expect(toApp({ domain: 'delve.town', creates: 3, prevCreates: 2, collections: null })).toEqual({ domain: 'delve.town', creates: 3, prevCreates: 2, collections: [] });
    expect(toApp({ domain: 'a.b.c', creates: 3, prevCreates: 2 })).toBeNull();
    expect(toApp({ domain: 'delve.town', creates: -1, prevCreates: 2 })).toBeNull();
    expect(toApp({ domain: 'delve.town', creates: 1 })).toBeNull();
  });

  it('refuses an unknown range, and says 503 when Supabase is down', async () => {
    const db = supabase(() => new Response('oops', { status: 500 }));
    const h = createHistoryHandlers({ fetch: db.fetch, now: () => NOW, env: () => ({}), log: () => undefined });
    expect((await h.GET(new Request('https://atpota.to/api/weather-history?range=decade'))).status).toBe(400);
    const res = await h.GET(new Request('https://atpota.to/api/weather-history?range=day'));
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers one host\'s days for ?host=, oldest first, and refuses what isn\'t a hostname', async () => {
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(url);
      if (url.includes('atmosphere_host_active_day')) return Response.json([{ day: '2026-10-22', dids: 1204 }, { day: 'nope', dids: 1 }]);
      // nobody's moves kept yet
      if (url.includes('atmosphere_host_move_day')) return Response.json([]);
      return Response.json([
        { day: '2026-10-22', accounts: 38036, estimated: false, bluesky: false },
        { day: '2026-10-21', accounts: '37979', estimated: true, bluesky: false },
        { day: 'yesterday', accounts: 1 },
      ]);
    }) as typeof globalThis.fetch;
    const db = { urls };
    const h = createHistoryHandlers({ fetch, now: () => NOW, env: () => ({}), log: () => undefined });
    const res = await h.GET(new Request('https://atpota.to/api/weather-history?host=EuroSky.social'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      host: {
        hostname: 'eurosky.social',
        bluesky: false,
        days: [
          { day: '2026-10-21', accounts: 37979, estimated: true },
          { day: '2026-10-22', accounts: 38036, estimated: false, active: 1204 },
        ],
        moves: [],
      },
    });
    expect(db.urls).toEqual([
      `${SUPABASE_URL}/rest/v1/atmosphere_host_day?hostname=eq.eurosky.social&select=day,accounts,estimated,bluesky&order=day.desc&limit=400`,
      `${SUPABASE_URL}/rest/v1/atmosphere_host_active_day?hostname=eq.eurosky.social&select=day,dids&order=day.desc&limit=400`,
      `${SUPABASE_URL}/rest/v1/atmosphere_host_move_day?to_host=eq.eurosky.social&select=day,from_host,accounts&order=day.desc,accounts.desc,from_host.asc&limit=1000`,
      `${SUPABASE_URL}/rest/v1/atmosphere_host_move_day?from_host=eq.eurosky.social&select=day,to_host,accounts&order=day.desc,accounts.desc,to_host.asc&limit=1000`,
      `${SUPABASE_URL}/rest/v1/atmosphere_host_move_day?select=day&order=day.asc&limit=1`,
    ]);
    expect((await h.GET(new Request('https://atpota.to/api/weather-history?host=a%26b'))).status).toBe(400);
    expect((await h.GET(new Request('https://atpota.to/api/weather-history?host='))).status).toBe(400);
  });

  it('answers who moved to one host and away from it, by the day and the other host', async () => {
    const fetch = (async (url: string) => {
      if (url.includes('atmosphere_host_move_day?to_host=')) {
        return Response.json([
          { day: '2026-11-10', from_host: 'bluesky', accounts: 19 },
          { day: '2026-11-10', from_host: 'pds.wsocial.network', accounts: '1' },
          { day: '2026-11-09', from_host: 'bluesky', accounts: 12 },
          { day: '2026-11-09', from_host: 'pds.tophhie.cloud', accounts: 1 },
          { day: '2026-11-09', from_host: '<script>', accounts: 1 },
          { day: '2026-11-09', from_host: 'pds.oso.social', accounts: 0 },
        ]);
      }
      if (url.includes('atmosphere_host_move_day?from_host=')) return Response.json([{ day: '2026-11-08', to_host: 'bluesky', accounts: 1 }]);
      if (url.includes('atmosphere_host_move_day?select=day')) return Response.json([{ day: '2026-10-08' }]);
      if (url.includes('atmosphere_host_active_day')) return Response.json([]);
      return Response.json([{ day: '2026-11-10', accounts: 38200, estimated: false, bluesky: false }]);
    }) as typeof globalThis.fetch;
    const h = createHistoryHandlers({ fetch, now: () => NOW, env: () => ({}), log: () => undefined });
    const body = (await (await h.GET(new Request('https://atpota.to/api/weather-history?host=eurosky.social'))).json()) as { host: { moves: unknown; movesSince?: unknown; similar?: unknown } };
    expect(body.host.moves).toEqual([
      { day: '2026-11-08', arrived: [], left: [{ to: 'bluesky', accounts: 1 }] },
      { day: '2026-11-09', arrived: [{ from: 'bluesky', accounts: 12 }, { from: 'pds.tophhie.cloud', accounts: 1 }], left: [] },
      { day: '2026-11-10', arrived: [{ from: 'bluesky', accounts: 19 }, { from: 'pds.wsocial.network', accounts: 1 }], left: [] },
    ]);
    // from when the station kept anyone's moves: a day this host isn't in, since then, nobody moved
    expect(body.host.movesSince).toBe('2026-10-08');
    expect(body.host.similar).toBeUndefined();
    // a side that comes back full may have cut its oldest day short: only whole days are told, on both sides
    const full = Array.from({ length: hosts.MOVE_ROWS }, (_, i) => ({ day: i < 999 ? '2026-11-10' : '2026-11-01', from_host: `h${i}.example`, accounts: 1 }));
    const cut = hosts.toHostMoves(full, [{ day: '2026-11-10', to_host: 'bluesky', accounts: 2 }, { day: '2026-10-30', to_host: 'bluesky', accounts: 1 }]);
    expect(cut.map((d) => [d.day, d.arrived.length, d.left.length])).toEqual([['2026-11-10', 999, 1]]);
  });

  it('says which hosts a name the station never kept could be', async () => {
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(url);
      // tophhie.social is the service's website; its accounts live on pds.tophhie.cloud
      if (url.includes('hostname=ilike.')) {
        return Response.json([
          { hostname: 'pds.tophhie.cloud', accounts: 611 },
          { hostname: 'pds.tophhie.cloud', accounts: 611 },
          { hostname: 'tophhie.social', accounts: 0 },
          { hostname: 'Not A Host', accounts: 1 },
        ]);
      }
      return Response.json([]);
    }) as typeof globalThis.fetch;
    const h = createHistoryHandlers({ fetch, now: () => NOW, env: () => ({}), log: () => undefined });
    const body = (await (await h.GET(new Request('https://atpota.to/api/weather-history?host=tophhie.social'))).json()) as { host: unknown };
    expect(body.host).toEqual({ hostname: 'tophhie.social', bluesky: false, days: [], moves: [], similar: ['pds.tophhie.cloud'] });
    // hosts kept in the last week whose names hold the asked one's own, biggest first
    expect(urls.at(-1)).toBe(`${SUPABASE_URL}/rest/v1/atmosphere_host_day?hostname=ilike.*tophhie*&day=gte.2026-10-13&select=hostname,accounts&order=day.desc,accounts.desc&limit=50`);
    // a name too short to mean anything ("co" of example.co.uk) isn't looked up, and a failed lookup is only left out
    const quiet: string[] = [];
    const none = { get: async (path: string) => (quiet.push(path), []), rpc: async () => null };
    expect(await hosts.similarHosts(none, 'example.co.uk', NOW)).toEqual([]);
    expect(quiet).toEqual([]);
    const down = (async (url: string) => (url.includes('ilike') ? new Response('no', { status: 500 }) : Response.json([]))) as typeof globalThis.fetch;
    const h2 = createHistoryHandlers({ fetch: down, now: () => NOW, env: () => ({}), log: () => undefined });
    expect(((await (await h2.GET(new Request('https://atpota.to/api/weather-history?host=tophhie.social'))).json()) as { host: unknown }).host).toEqual({ hostname: 'tophhie.social', bluesky: false, days: [], moves: [] });
  });

  it('only takes GET and HEAD', async () => {
    const res = await api.POST(new Request('https://atpota.to/api/weather-history', { method: 'POST' }));
    expect(res.status).toBe(405);
  });
});

describe('steady counts and bursts', () => {
  // An hour as the atmosphere_hour view has it: `steady` is its records with any burst taken out.
  const hourRow = (hour: string, creates: number, steady?: number | string) => ({ ...row(hour), minute: undefined, hour, seconds_covered: 3600, creates, ...(steady === undefined ? {} : { steady }) });

  it('asks the hour and day views for steady, and the minute table not', () => {
    const select = (range: keyof typeof RANGES) => new URL(queryUrl(SUPABASE_URL, range, NOW)).searchParams.get('select')!.split(',');
    expect(select('hour')).not.toContain('steady');
    for (const range of ['day', 'week', 'month', 'year'] as const) expect(select(range)).toContain('steady');
  });

  it('reads steady when it comes, and sums it only when every point has one', () => {
    const a = toPoint(hourRow('2026-10-20T15:00:00Z', 5000, '4000'), 'hour')!;
    const b = toPoint(hourRow('2026-10-20T16:00:00Z', 3000, 3000), 'hour')!;
    const none = toPoint(hourRow('2026-10-20T17:00:00Z', 1000), 'hour')!;
    expect(a.steady).toBe(4000);
    expect('steady' in none).toBe(false);
    expect('steady' in toPoint(hourRow('2026-10-20T18:00:00Z', 1000, -1), 'hour')!).toBe(false);
    expect(sumPoints([a, b], 'x').steady).toBe(7000);
    expect('steady' in sumPoints([a, none], 'x')).toBe(false);
    expect(byMonth([a, b])[0]!.steady).toBe(7000);
  });

  it('picks out the hours that ran well past their steady count, biggest first', () => {
    const p = (hour: string, creates: number, steady?: number) => toPoint(hourRow(hour, creates, steady), 'hour')!;
    expect(burstHours([
      p('2026-10-17T00:00:00Z', 5_000_000, 1_500_000),
      p('2026-10-17T01:00:00Z', 1_600_000, 1_550_000), // 3% over: not a burst
      p('2026-10-17T02:00:00Z', 2_000_000, 1_500_000),
      p('2026-10-17T03:00:00Z', 9_000_000), // no steady count, so nothing to say
    ])).toEqual([
      { t: '2026-10-17T00:00:00.000Z', records: 3_500_000 },
      { t: '2026-10-17T02:00:00.000Z', records: 500_000 },
    ]);
  });

  it('names the app whose minute made a burst, and none when no app made most of it', async () => {
    const urls: URL[] = [];
    const fetch = (async (input: string) => {
      const url = new URL(input);
      urls.push(url);
      const table = url.pathname.split('/').pop();
      if (table === 'atmosphere_hour')
        return Response.json([
          hourRow('2026-10-17T00:00:00+00:00', 5_000_000, 1_500_000),
          hourRow('2026-10-17T01:00:00+00:00', 1_600_000, 1_550_000),
          hourRow('2026-10-17T02:00:00+00:00', 2_000_000, 1_500_000),
        ]);
      if (table === 'atmosphere_minute_app')
        return Response.json(
          url.searchParams.getAll('minute')[0] === 'gte.2026-10-17T00:00:00.000Z'
            ? [{ minute: '2026-10-17T00:59:00+00:00', domain: 'podping.at', creates: 3_400_000, collections: ['at.podping.records.podping', '<b>'], dids: 1 }]
            : [{ minute: '2026-10-17T02:06:00+00:00', domain: 'standard.site', creates: 7_869, collections: [] }],
        );
      if (url.pathname.includes('/rpc/')) return new Response('no', { status: 404 });
      return Response.json([]);
    }) as typeof globalThis.fetch;
    const h = createHistoryHandlers({ fetch, now: () => Date.parse('2026-10-17T03:30:00Z'), env: () => ({}), log: () => undefined });
    const body = (await (await h.GET(new Request('https://atpota.to/api/weather-history?range=week'))).json()) as { bursts: Burst[]; total: Point };
    expect(body.bursts).toEqual([
      {
        t: '2026-10-17T00:00:00.000Z',
        records: 3_500_000,
        // and one account wrote all of that minute: somebody's batch
        app: { domain: 'podping.at', minute: '2026-10-17T00:59:00.000Z', records: 3_400_000, collections: ['at.podping.records.podping'], accounts: 1 },
      },
      // the biggest app-minute that hour is a sliver of it, so no app gets the blame
      { t: '2026-10-17T02:00:00.000Z', records: 500_000 },
    ]);
    expect(body.total.steady).toBe(4_550_000);
    const asked = urls.find((u) => u.pathname.endsWith('/atmosphere_minute_app'))!;
    expect(asked.searchParams.getAll('minute')).toEqual(['gte.2026-10-17T00:00:00.000Z', 'lt.2026-10-17T01:00:00.000Z']);
    expect(asked.searchParams.get('order')).toBe('creates.desc');
    expect(asked.searchParams.get('limit')).toBe('1');
    expect(asked.searchParams.get('select')!.split(',')).toContain('dids');
  });

  it('lists bursts for a week only (Poe\'s dispatch), so the page\'s other ranges and the cards don\'t wait on them', async () => {
    const db = supabase(() => Response.json([row('2026-10-20T16:59:00+00:00')]));
    const h = createHistoryHandlers({ fetch: db.fetch, now: () => NOW, env: () => ({}), log: () => undefined });
    for (const range of ['hour', 'day', 'month']) {
      const body = (await (await h.GET(new Request(`https://atpota.to/api/weather-history?range=${range}`))).json()) as object;
      expect('bursts' in body).toBe(false);
    }
    expect(db.urls.some((u) => u.includes('atmosphere_minute_app'))).toBe(false);
  });
});

// A sketch with value 1 in the given registers, as PostgREST answers bytea: one account
// per register, so the counts below are exact.
const sk = (...registers: number[]) => `\\x020c${registers.map((i) => `${i.toString(16).padStart(4, '0')}01`).join('')}`;

describe('active accounts in the trends', () => {
  function stationDb({ minuteSketchesYesterday = true } = {}) {
    const urls: URL[] = [];
    const fetch = (async (input: string) => {
      const url = new URL(input);
      urls.push(url);
      const table = url.pathname.split('/').pop();
      const q = url.searchParams;
      const earlier = (q.get('t') ?? q.get('minute') ?? '').startsWith('gte.2026-10-19');
      // the hour sketch the earlier hour falls back to, when its minute sketches are gone
      const hourBefore = q.get('period') === 'eq.hour' && q.get('t') === 'eq.2026-10-19T16:00:00.000Z';
      if (table === 'atmosphere_account_sketch' && hourBefore) return Response.json([{ seconds: 3600, bluesky: sk(1, 6, 8), elsewhere: sk(7) }]);
      if (table === 'atmosphere_account_app_sketch' && hourBefore) return Response.json([{ domain: 'tangled.sh', sketch: sk(7) }, { domain: 'whtwnd.com', sketch: sk(7) }]);
      if (table === 'atmosphere_account_sketch' && earlier)
        return Response.json(minuteSketchesYesterday ? [{ t: '2026-10-19T16:30:00+00:00', seconds: 3600, bluesky: sk(1, 6), elsewhere: sk(7) }] : []);
      if (table === 'atmosphere_account_sketch')
        return Response.json([
          { t: '2026-10-20T16:58:00+00:00', seconds: 60, dids: 3, dids_bluesky: 2, dids_elsewhere: 1, bluesky: sk(1, 2), elsewhere: sk(3) },
          { t: '2026-10-20T16:59:00+00:00', seconds: 60, dids: 4, dids_bluesky: 2, dids_elsewhere: 2, bluesky: sk(2, 4), elsewhere: sk(3, 5) },
          { t: '2026-10-20T17:00:00+00:00', seconds: 60, dids: 1, dids_bluesky: 1, dids_elsewhere: 0, bluesky: 'not a sketch', elsewhere: sk() },
        ]);
      if (table === 'atmosphere_account_app_sketch')
        return Response.json(
          earlier
            ? minuteSketchesYesterday
              ? [{ domain: 'tangled.sh', sketch: sk(7) }]
              : []
            : [
                { t: '2026-10-20T16:58:00+00:00', domain: 'tangled.sh', dids: 1, sketch: sk(3) },
                { t: '2026-10-20T16:59:00+00:00', domain: 'tangled.sh', dids: 2, sketch: sk(3, 5) },
                { t: '2026-10-20T16:59:00+00:00', domain: 'whtwnd.com', dids: 1, sketch: sk(5) },
                { t: '2026-10-20T16:59:00+00:00', domain: '<b>x</b>', dids: 3, sketch: sk(9, 10, 11) },
              ],
        );
      if (table === 'atmosphere_minute' && q.get('select')?.startsWith('seconds:')) return Response.json([{ seconds: 60 }, { seconds: 30 }]);
      if (table === 'atmosphere_minute_app') return Response.json(q.get('domain') === 'eq.tangled.sh' ? [{ collections: ['sh.tangled.repo', '<i>'] }] : []);
      if (table === 'rpc') return new Response('no', { status: 404 });
      return Response.json([row('2026-10-20T16:59:00+00:00')]);
    }) as typeof globalThis.fetch;
    return { urls, fetch };
  }

  it('merges the buckets\' sketches for the range, counts each bucket, and ranks apps by accounts', async () => {
    const db = stationDb();
    const h = createHistoryHandlers({ fetch: db.fetch, now: () => NOW, env: () => ({}), log: () => undefined, liveSince: 0 });
    const body = (await (await h.GET(new Request('https://atpota.to/api/weather-history?range=hour'))).json()) as { accounts: unknown };
    expect(body.accounts).toEqual({
      seconds: 120,
      prevSeconds: 90,
      // registers 1, 2, 4 on Bluesky and 3, 5 elsewhere: a union, not 2 + 2 or 3 + 4;
      // over the hour, tangled.sh had both accounts elsewhere and whtwnd.com one of them
      total: { active: 5, bluesky: 3, elsewhere: 2, share: 40, spread: 1.89, index: 54.99 },
      // the same hour yesterday, from the minute sketches still kept: one of three accounts elsewhere, all tangled.sh's
      prev: { seconds: 3600, active: 3, bluesky: 2, elsewhere: 1, share: 33.33, spread: 1, index: 33.33 },
      points: [
        { t: '2026-10-20T16:58:00.000Z', seconds: 60, active: 3, bluesky: 2, elsewhere: 1, share: 33.33, spread: 1, index: 33.33 },
        { t: '2026-10-20T16:59:00.000Z', seconds: 60, active: 4, bluesky: 2, elsewhere: 2, share: 50, spread: 1.89, index: 68.74 },
      ],
      apps: [
        { domain: 'tangled.sh', active: 2, prevActive: 1, collections: ['sh.tangled.repo'] },
        { domain: 'whtwnd.com', active: 1, prevActive: 0, collections: [] },
      ],
    });
    const asked = (table: string) => db.urls.filter((u) => u.pathname.endsWith(`/${table}`));
    const [now, earlier] = asked('atmosphere_account_app_sketch');
    expect(now!.searchParams.get('period')).toBe('eq.minute');
    expect(now!.searchParams.getAll('t')).toEqual(['gte.2026-10-20T16:00:00.000Z', 'lt.2026-10-20T17:00:00.000Z']);
    expect(earlier!.searchParams.get('domain')).toBeNull();
    expect(earlier!.searchParams.getAll('t')).toEqual(['gte.2026-10-19T16:00:00.000Z', 'lt.2026-10-19T17:00:00.000Z']);
    // the earlier hour's coverage from the minute rows, since minute sketches don't last a day
    expect(asked('atmosphere_minute').some((u) => u.searchParams.get('dids') === 'not.is.null')).toBe(true);
  });

  it('falls back to the hour sketch nearest the earlier hour when its minute sketches are gone', async () => {
    const db = stationDb({ minuteSketchesYesterday: false });
    const h = createHistoryHandlers({ fetch: db.fetch, now: () => NOW, env: () => ({}), log: () => undefined, liveSince: 0 });
    const body = (await (await h.GET(new Request('https://atpota.to/api/weather-history?range=hour'))).json()) as { accounts: { prev: unknown; apps: Array<{ domain: string; prevActive: number }> } };
    // registers 1, 6, 8 on Bluesky and 7 elsewhere, written to by both apps
    expect(body.accounts.prev).toEqual({ seconds: 3600, active: 4, bluesky: 3, elsewhere: 1, share: 25, spread: 2, index: 35.36 });
    expect(body.accounts.apps.map((a) => [a.domain, a.prevActive])).toEqual([
      ['tangled.sh', 1],
      ['whtwnd.com', 1],
    ]);
  });

  it('gives a longer range the earlier window\'s everyone and diversity index, over every app', async () => {
    const urls: URL[] = [];
    const fetch = (async (input: string) => {
      const url = new URL(input);
      urls.push(url);
      const table = url.pathname.split('/').pop();
      const earlier = (url.searchParams.get('t') ?? '').startsWith('gte.2026-10-18');
      if (table === 'atmosphere_account_sketch')
        return Response.json(
          earlier
            ? [{ t: '2026-10-18T18:00:00+00:00', seconds: 3600, bluesky: sk(1, 2, 3), elsewhere: sk(4) }]
            : [{ t: '2026-10-19T18:00:00+00:00', seconds: 3600, dids: 4, dids_bluesky: 2, dids_elsewhere: 2, bluesky: sk(1, 2), elsewhere: sk(3, 5) }],
        );
      if (table === 'atmosphere_account_app_sketch')
        return Response.json(earlier ? [{ domain: 'whtwnd.com', sketch: sk(4) }] : [{ t: '2026-10-19T18:00:00+00:00', domain: 'tangled.sh', dids: 2, sketch: sk(3, 5) }]);
      if (url.pathname.includes('/rpc/')) return new Response('no', { status: 404 });
      return Response.json([]);
    }) as typeof globalThis.fetch;
    const h = createHistoryHandlers({ fetch, now: () => NOW, env: () => ({}), log: () => undefined, liveSince: 0 });
    const body = (await (await h.GET(new Request('https://atpota.to/api/weather-history?range=day'))).json()) as { accounts: { prev: unknown } };
    // registers 1-3 on Bluesky and 4 elsewhere, all of it whtwnd.com's, which isn't in the top apps now
    expect(body.accounts.prev).toEqual({ seconds: 3600, active: 4, bluesky: 3, elsewhere: 1, share: 25, spread: 1, index: 25 });
    const earlier = urls.filter((u) => u.pathname.endsWith('/atmosphere_account_app_sketch') && u.searchParams.get('t')?.startsWith('gte.2026-10-18'));
    expect(earlier[0]!.searchParams.get('domain')).toBeNull();
  });

  it('says how many accounts wrote each of the busiest apps, so one account\'s batch doesn\'t read as a crowd', async () => {
    const db = stationDb();
    const trends = {
      seconds: 3600,
      prevSeconds: 3600,
      apps: [
        { domain: 'whtwnd.com', creates: 8600, prevCreates: 0, collections: [] },
        { domain: 'tangled.sh', creates: 420, prevCreates: 300, collections: [] },
        { domain: 'fresh.app', creates: 50, prevCreates: 0, collections: [] },
      ],
    };
    const fetch = (async (input: string, init?: RequestInit) =>
      input.endsWith('/rpc/atmosphere_app_trends') ? Response.json(trends) : db.fetch(input, init)) as typeof globalThis.fetch;
    const h = createHistoryHandlers({ fetch, now: () => NOW, env: () => ({}), log: () => undefined, liveSince: 0 });
    const body = (await (await h.GET(new Request('https://atpota.to/api/weather-history?range=hour'))).json()) as { apps: App[]; accounts: { apps: unknown[] } };
    expect(body.apps).toEqual([
      // the busiest by records, from one account: whtwnd.com's sketches over the hour hold one register
      { domain: 'whtwnd.com', creates: 8600, prevCreates: 0, collections: [], accounts: 1 },
      { domain: 'tangled.sh', creates: 420, prevCreates: 300, collections: [], accounts: 2 },
      // no sketch for it yet (heard in the last few minutes, say): unknown, so no count at all, never 0
      { domain: 'fresh.app', creates: 50, prevCreates: 0, collections: [] },
    ]);
    // the accounts part itself is as it was, with no list of every app in it
    expect(body.accounts.apps).toHaveLength(2);
    expect('byApp' in body.accounts).toBe(false);
  });

  it('leaves the earlier window\'s diversity index out when the station heard it from the archive, not live', async () => {
    const db = stationDb();
    const h = createHistoryHandlers({ fetch: db.fetch, now: () => NOW, env: () => ({}), log: () => undefined, liveSince: Date.parse('2026-10-20T16:50:00Z') });
    const body = (await (await h.GET(new Request('https://atpota.to/api/weather-history?range=hour'))).json()) as { accounts: object };
    expect('prev' in body.accounts).toBe(false);
  });

  it('reads longer ranges from hour, day and month sketches, and pages through them', async () => {
    const pages: string[] = [];
    const fetch = (async (input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/atmosphere_account_app_sketch') && url.searchParams.get('t')?.startsWith('gte.2026-09-20')) {
        pages.push(url.searchParams.get('offset')!);
        const offset = Number(url.searchParams.get('offset'));
        return Response.json(offset < 2000 ? Array.from({ length: 1000 }, (_, i) => ({ domain: 'tangled.sh', sketch: sk((offset + i) % 4096) })) : [{ domain: 'tangled.sh', sketch: sk(4000) }]);
      }
      if (url.pathname.includes('/rpc/')) return new Response('no', { status: 404 });
      return Response.json([]);
    }) as typeof globalThis.fetch;
    const h = createHistoryHandlers({ fetch, now: () => NOW, env: () => ({}), log: () => undefined });
    const body = (await (await h.GET(new Request('https://atpota.to/api/weather-history?range=month'))).json()) as { accounts: { apps: Array<{ active: number }> } };
    expect(pages).toEqual(['0', '1000', '2000']);
    expect(body.accounts.apps[0]!.active).toBeGreaterThan(1900); // 2001 registers; past a few hundred the count is an estimate
  });

  it('leaves accounts out when the sketches can\'t be read', async () => {
    const fetch = (async (input: string) => {
      if (input.includes('/atmosphere_account_')) return new Response('nope', { status: 500 });
      if (input.includes('/rpc/')) return new Response('no', { status: 404 });
      return Response.json([row('2026-10-20T16:59:00+00:00')]);
    }) as typeof globalThis.fetch;
    const h = createHistoryHandlers({ fetch, now: () => NOW, env: () => ({}), log: () => undefined });
    const res = await h.GET(new Request('https://atpota.to/api/weather-history?range=day'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(PARTIAL_CACHE);
    expect('accounts' in ((await res.json()) as object)).toBe(false);
  });
});

describe('new accounts made in bulk', () => {
  const row = { day: '2026-10-28', ops: 1, created_bluesky: 9905, created_independent: 5561, created_unlisted: 0, created_custom_handle: 50, moved_out: 0, moved_in: 0, moved_between: 0, deleted: 0, destinations: [] };
  const found = { ...row, created_bulk: 4574, bulk_hosts: [{ hostname: 'goodmkt.id', accounts: 4500, bursts: 1, seconds: 1278 }, { hostname: 'pds.1095.me', accounts: 74, bursts: 2, seconds: 72 }] };

  it("takes the station's count, and none from a row from before it looked", () => {
    expect(hosts.toIdentityDay(found)).toMatchObject({ createdBulk: 4574, bulk: [{ hostname: 'goodmkt.id', accounts: 4500 }, { hostname: 'pds.1095.me', accounts: 74 }] });
    expect(hosts.toIdentityDay(row)).toMatchObject({ createdBulk: 0, bulk: [] });
    // never more than the independent sign-ups
    expect(hosts.toIdentityDay({ ...found, created_bulk: 99_999 })!.createdBulk).toBe(5561);
  });

  it('takes the sign-ups the trends call scripted, and their hosts, never more than what the bulk and unnamed ones leave', () => {
    const scripted = { ...found, created_unnamed: 40, created_scripted: 603, scripted_hosts: [{ hostname: 'goodmkt.id', accounts: 603, why: 'bulk' }, { hostname: 'Not A Host', accounts: 1, why: 'bulk' }, { hostname: 'refpds.oyster.cafe', accounts: 9, why: 'who knows' }] };
    const d = hosts.toIdentityDay(scripted)!;
    expect([d.createdScripted, d.scripted]).toEqual([603, [{ hostname: 'goodmkt.id', accounts: 603, why: 'bulk' }]]);
    expect(hosts.peopleIndependentOf(d)).toBe(5561 - 4574 - 40 - 603);
    expect(hosts.toIdentityDay({ ...scripted, created_scripted: 99_999 })!.createdScripted).toBe(5561 - 4574 - 40);
    expect(hosts.toIdentityDay(row)).toMatchObject({ createdScripted: 0, scripted: [] });
    // a host let off by hand is let off these too
    expect(hosts.toIdentityDay(scripted, new Set(['goodmkt.id']))!.createdScripted).toBe(0);
  });

  it('takes the identities with no handle too, never more than the sign-ups the bulk ones leave', () => {
    expect(hosts.toIdentityDay({ ...found, created_unnamed: 340 })!.createdUnnamed).toBe(340);
    expect(hosts.toIdentityDay(row)!.createdUnnamed).toBe(0);
    expect(hosts.toIdentityDay({ ...found, created_unnamed: 99_999 })!.createdUnnamed).toBe(5561 - 4574);
  });

  it('lets a host off by hand: its sign-ups count as people again', () => {
    expect(hosts.NOT_BULK.size).toBe(0);
    const d = hosts.toIdentityDay(found, new Set(['goodmkt.id']))!;
    expect(d.createdBulk).toBe(74);
    expect(d.bulk.map((h) => h.hostname)).toEqual(['pds.1095.me']);
  });
});

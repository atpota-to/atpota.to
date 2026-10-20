import { describe, expect, it } from 'vitest';
import * as api from '../api/weather-history.js';
import { byMonth, createHistoryHandlers, queryUrl, RANGES, SUPABASE_URL, sumPoints, toApp, toPoint, trendArgs, type App, type Point } from '../server/weather-history.js';

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

type Rpc = Record<string, () => Response>;

function supabase(answer: () => Response, rpcs: Rpc = {}) {
  const urls: string[] = [];
  const bodies: Record<string, unknown> = {};
  const answers: Rpc = { atmosphere_app_trends: () => Response.json(TRENDS), atmosphere_apps_over_time: () => Response.json(OVER_TIME), ...rpcs };
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

  it('only takes GET and HEAD', async () => {
    const res = await api.POST(new Request('https://atpota.to/api/weather-history', { method: 'POST' }));
    expect(res.status).toBe(405);
  });
});

// A sketch with value 1 in the given registers, as PostgREST answers bytea: one account
// per register, so the counts below are exact.
const sk = (...registers: number[]) => `\\x020c${registers.map((i) => `${i.toString(16).padStart(4, '0')}01`).join('')}`;

describe('active accounts in the trends', () => {
  function stationDb() {
    const urls: URL[] = [];
    const fetch = (async (input: string) => {
      const url = new URL(input);
      urls.push(url);
      const table = url.pathname.split('/').pop();
      const q = url.searchParams;
      const earlier = (q.get('t') ?? q.get('minute') ?? '').startsWith('gte.2026-10-19');
      if (table === 'atmosphere_account_sketch')
        return Response.json([
          { t: '2026-10-20T16:58:00+00:00', seconds: 60, dids: 3, dids_bluesky: 2, dids_elsewhere: 1, bluesky: sk(1, 2), elsewhere: sk(3) },
          { t: '2026-10-20T16:59:00+00:00', seconds: 60, dids: 4, dids_bluesky: 2, dids_elsewhere: 2, bluesky: sk(2, 4), elsewhere: sk(3, 5) },
          { t: '2026-10-20T17:00:00+00:00', seconds: 60, dids: 1, dids_bluesky: 1, dids_elsewhere: 0, bluesky: 'not a sketch', elsewhere: sk() },
        ]);
      if (table === 'atmosphere_account_app_sketch')
        return Response.json(
          earlier
            ? [{ domain: 'tangled.sh', sketch: sk(7) }]
            : [
                { t: '2026-10-20T16:58:00+00:00', domain: 'tangled.sh', sketch: sk(3) },
                { t: '2026-10-20T16:59:00+00:00', domain: 'tangled.sh', sketch: sk(3, 5) },
                { t: '2026-10-20T16:59:00+00:00', domain: 'whtwnd.com', sketch: sk(5) },
                { t: '2026-10-20T16:59:00+00:00', domain: '<b>x</b>', sketch: sk(9, 10, 11) },
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
    const h = createHistoryHandlers({ fetch: db.fetch, now: () => NOW, env: () => ({}), log: () => undefined });
    const body = (await (await h.GET(new Request('https://atpota.to/api/weather-history?range=hour'))).json()) as { accounts: unknown };
    expect(body.accounts).toEqual({
      seconds: 120,
      prevSeconds: 90,
      // registers 1, 2, 4 on Bluesky and 3, 5 elsewhere: a union, not 2 + 2 or 3 + 4
      total: { active: 5, bluesky: 3, elsewhere: 2 },
      points: [
        { t: '2026-10-20T16:58:00.000Z', seconds: 60, active: 3, bluesky: 2, elsewhere: 1 },
        { t: '2026-10-20T16:59:00.000Z', seconds: 60, active: 4, bluesky: 2, elsewhere: 2 },
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
    expect(earlier!.searchParams.get('domain')).toBe('in.(tangled.sh,whtwnd.com)');
    expect(earlier!.searchParams.getAll('t')).toEqual(['gte.2026-10-19T16:00:00.000Z', 'lt.2026-10-19T17:00:00.000Z']);
    // the earlier hour's coverage from the minute rows, since minute sketches don't last a day
    expect(asked('atmosphere_minute').some((u) => u.searchParams.get('dids') === 'not.is.null')).toBe(true);
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
    expect('accounts' in ((await res.json()) as object)).toBe(false);
  });
});

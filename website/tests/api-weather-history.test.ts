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
    expect(new URL(queryUrl(SUPABASE_URL, 'month', NOW)).searchParams.get('day')).toBe('gte.2026-09-20T17:00:00.000Z');
    expect(Object.keys(RANGES)).toEqual(['hour', 'day', 'month', 'year']);
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

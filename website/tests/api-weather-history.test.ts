import { describe, expect, it } from 'vitest';
import * as api from '../api/weather-history.js';
import { byMonth, createHistoryHandlers, queryUrl, RANGES, SUPABASE_URL, sumPoints, toPoint, type Point } from '../server/weather-history.js';

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

function supabase(answer: () => Response) {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    return answer();
  }) as typeof globalThis.fetch;
  return { urls, fetch };
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
    expect(db.urls[0]!.startsWith(`${SUPABASE_URL}/rest/v1/atmosphere_minute?`)).toBe(true);
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

import { describe, expect, it } from 'vitest';
import * as api from '../api/weather-almanac.js';
import { CACHE, createAlmanacHandlers, HEATMAP_MS, timeZone, toHeatmap, toNewApps, toNormal, toToday, WARMUP_MS } from '../server/weather-almanac.js';

// /api/weather-almanac against a scripted Supabase.

const NOW = Date.parse('2026-11-03T17:00:00.000Z');
const SUMS = { seconds: 3600, posts: 180_000, creates: 1_600_000, elsewhere: 6000 };
const ANSWERS: Record<string, unknown> = {
  atmosphere_today: {
    start: '2026-11-03T05:00:00+00:00',
    ...SUMS,
    // high / low are Bluesky posts (from before the switch); the report reads every record
    high: { minute: '2026-11-03T15:14:00+00:00', perSecond: 72.4 },
    low: { minute: '2026-11-03T09:02:00+00:00', perSecond: '31.0' },
    recordsHigh: { minute: '2026-11-03T15:14:00+00:00', perSecond: 642.2 },
    recordsLow: { minute: '2026-11-03T09:02:00+00:00', perSecond: '262.9' },
  },
  atmosphere_normal: { historyStart: '2026-10-20T16:50:00+00:00', now: SUMS, days: { ...SUMS, windows: 6 }, weeks: { ...SUMS, windows: 2 } },
  atmosphere_new_apps: {
    historyStart: '2026-10-20T16:50:00+00:00',
    heard: 90,
    apps: [
      { domain: 'mu.social', firstSeen: '2026-11-03T16:46:00+00:00', creates: 4, minutes: 2, collections: ['social.mu.newsFeedPrefs', '<i>x</i>'] },
      { domain: '<b>nope</b>', firstSeen: '2026-11-03T16:00:00+00:00', creates: 1, collections: [] },
    ],
  },
  atmosphere_heatmap: { seconds: 1_200_000, cells: [{ dow: 2, hour: 17, seconds: 3600, posts: 180_000, creates: 1_600_000 }, { dow: 9, hour: 1, seconds: 1, posts: 1, creates: 1 }] },
};

function supabase(answers: Record<string, unknown> = ANSWERS) {
  const bodies: Record<string, unknown> = {};
  const fetch = (async (url: string, init?: RequestInit) => {
    const name = /\/rpc\/([a-z_]+)$/.exec(url)?.[1] ?? '';
    bodies[name] = JSON.parse(String(init?.body));
    return name in answers ? Response.json(answers[name]) : new Response('nope', { status: 500 });
  }) as typeof globalThis.fetch;
  return { bodies, fetch };
}

const get = (h: ReturnType<typeof createAlmanacHandlers>, q = '?tz=America/New_York') => h.GET(new Request(`https://atpota.to/api/weather-almanac${q}`));

describe('weather almanac', () => {
  it('takes IANA zones only', () => {
    expect(timeZone('America/Argentina/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires');
    expect(timeZone(null)).toBe('UTC');
    expect(timeZone('Etc/GMT+5')).toBe('Etc/GMT+5');
    expect(timeZone('Not/AZone')).toBeNull();
    expect(timeZone('../../etc/passwd')).toBeNull();
    expect(timeZone("UTC'; drop table x;--")).toBeNull();
  });

  it('answers with all four parts, cached a minute per zone', async () => {
    const db = supabase();
    const h = createAlmanacHandlers({ fetch: db.fetch, now: () => NOW, env: () => ({}), log: () => undefined });
    const res = await get(h);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(CACHE);
    const body = (await res.json()) as Record<string, any>;
    expect(body.tz).toBe('America/New_York');
    expect(body.today.high).toEqual({ minute: '2026-11-03T15:14:00.000Z', perSecond: 642.2 });
    expect(body.today.low.perSecond).toBe(262.9);
    expect(body.normal.weeks.windows).toBe(2);
    expect(body.newApps).toMatchObject({ warmingUp: false, heard: 90, readyAt: '2026-10-27T16:50:00.000Z' });
    expect(body.newApps.apps).toEqual([{ domain: 'mu.social', firstSeen: '2026-11-03T16:46:00.000Z', creates: 4, collections: ['social.mu.newsFeedPrefs'] }]);
    expect(body.heatmap.cells).toHaveLength(1);
    expect(db.bodies.atmosphere_today).toEqual({ tz: 'America/New_York' });
    expect(db.bodies.atmosphere_new_apps).toEqual({ since: '2026-11-02T17:00:00.000Z', max_apps: 50 });
    expect(db.bodies.atmosphere_heatmap).toEqual({ tz: 'America/New_York', since: new Date(NOW - HEATMAP_MS).toISOString() });
  });

  it('says it is warming up for the first week, and never calls an app new from before then', () => {
    const early = toNewApps(ANSWERS.atmosphere_new_apps, Date.parse('2026-10-21T12:00:00Z'))!;
    expect(early).toMatchObject({ warmingUp: true, apps: [] });
    const firstDay = { historyStart: '2026-10-20T16:50:00Z', heard: 3, apps: [{ domain: 'a.app', firstSeen: '2026-10-27T10:00:00Z', creates: 1, collections: [] }] };
    // just after the warm-up, an app first heard during it is not "new"
    expect(toNewApps(firstDay, Date.parse('2026-10-27T16:50:00Z') + WARMUP_MS / 7)!.apps).toEqual([]);
    expect(toNewApps({ heard: 1, apps: [] }, NOW)).toMatchObject({ warmingUp: true, readyAt: null });
  });

  it('leaves out a part that fails, and is a 503 only when all of them do', async () => {
    const { atmosphere_heatmap: _drop, ...rest } = ANSWERS;
    const h = createAlmanacHandlers({ fetch: supabase(rest).fetch, now: () => NOW, env: () => ({}), log: () => undefined });
    const body = (await (await get(h)).json()) as object;
    expect('heatmap' in body).toBe(false);
    expect('today' in body).toBe(true);
    const down = createAlmanacHandlers({ fetch: supabase({}).fetch, now: () => NOW, env: () => ({}), log: () => undefined });
    const res = await get(down);
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses a bad zone before asking anyone', async () => {
    const db = supabase();
    const h = createAlmanacHandlers({ fetch: db.fetch, now: () => NOW, env: () => ({}), log: () => undefined });
    expect((await get(h, '?tz=Not/AZone')).status).toBe(400);
    expect(db.bodies).toEqual({});
  });

  it('checks every part', () => {
    expect(toToday({ ...SUMS })).toBeNull();
    expect(toToday({ start: 'x', ...SUMS })).toBeNull();
    expect(toToday({ start: '2026-11-03T05:00:00Z', ...SUMS, high: { minute: 'nope', perSecond: 1 } })!.high).toBeNull();
    expect(toNormal({ now: SUMS, days: SUMS, weeks: { ...SUMS, windows: 1 } })).toBeNull();
    expect(toHeatmap({ seconds: 1, cells: [{ dow: 1, hour: 24, seconds: 1, posts: 1, creates: 1 }] })!.cells).toEqual([]);
  });

  it('only takes GET and HEAD', async () => {
    expect((await api.POST(new Request('https://atpota.to/api/weather-almanac', { method: 'POST' }))).status).toBe(405);
  });
});

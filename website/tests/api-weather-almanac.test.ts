import { describe, expect, it } from 'vitest';
import * as api from '../api/weather-almanac.js';
import { CACHE, createAlmanacHandlers, HEATMAP_MS, LIVE_SINCE, readDiversity, readRecords, timeZone, toHeatmap, toNewApps, toNormal, toToday, WARMUP_MS } from '../server/weather-almanac.js';

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

  it('carries each cell\'s steady count when it comes, and leaves an odd one out', () => {
    const cell = { dow: 6, hour: 0, seconds: 7200, posts: 300_000, creates: 6_500_000 };
    expect(toHeatmap({ seconds: 7200, cells: [{ ...cell, steady: '2900000' }] })!.cells).toEqual([{ ...cell, steady: 2_900_000 }]);
    expect(toHeatmap({ seconds: 7200, cells: [{ ...cell, steady: -1 }] })!.cells).toEqual([cell]);
    expect(toHeatmap({ seconds: 7200, cells: [cell] })!.cells).toEqual([cell]);
  });

  it('only takes GET and HEAD', async () => {
    expect((await api.POST(new Request('https://atpota.to/api/weather-almanac', { method: 'POST' }))).status).toBe(405);
  });
});

describe('the diversity index against usual', () => {
  // 17:00 on a tuesday: the last whole hour is 16:00
  const hour = (daysAgo: number) => new Date(Date.parse('2026-11-03T16:00:00.000Z') - daysAgo * 86_400_000).toISOString().replace('.000Z', '+00:00');
  const everyone = (daysAgo: number, dids: number, elsewhere: number, seconds = 3600) => ({ t: hour(daysAgo), seconds, dids, dids_elsewhere: elsewhere });
  const apps = (daysAgo: number, ...dids: number[]) => dids.map((n) => ({ t: hour(daysAgo), dids: n }));
  function db(main: unknown[], appRows: unknown[]) {
    const asked: string[] = [];
    const get = async (path: string) => {
      asked.push(path);
      const offset = Number(/offset=(\d+)/.exec(path)?.[1] ?? 0);
      return offset > 0 ? [] : path.startsWith('atmosphere_account_app_sketch') ? appRows : main;
    };
    return { asked, db: { get, rpc: async () => null } };
  }

  it("works out the last whole hour's index, and the same hour's on the days and weeks before", async () => {
    const { asked, db: d } = db(
      [
        everyone(0, 100_000, 1000), // 1%, four even apps: 2
        everyone(1, 100_000, 500), // 0.5%, four even apps: 1
        everyone(2, 100_000, 500, 1200), // barely heard: left out
        everyone(7, 100_000, 1000), // 1%, one app: 1
        everyone(14, 100_000, 300), // 2026-10-20 16:00, before the station listened live: left out
        everyone(42, 100_000, 1000), // its apps are no longer kept: left out
      ],
      [...apps(0, 250, 250, 250, 250), ...apps(1, 125, 125, 125, 125), ...apps(2, 500), ...apps(7, 1000), ...apps(14, 300)],
    );
    const got = await readDiversity(d, NOW);
    expect(got).toEqual({
      hour: '2026-11-03T16:00:00.000Z',
      now: { index: 2, share: 1, spread: 4, elsewhere: 1000 },
      days: { windows: 1, index: 1 },
      weeks: { windows: 1, index: 1 },
    });
    expect(asked[0]).toContain('period=eq.hour&t=in.(2026-11-03T16:00:00.000Z,2026-11-02T16:00:00.000Z,');
    expect(asked.every((q) => !q.includes('sketch,') && !q.includes(',sketch'))).toBe(true); // counts only, no sketches to merge
  });

  it('has nothing to say when the last whole hour was not heard', async () => {
    expect(await readDiversity(db([everyone(1, 100_000, 500)], apps(1, 500)).db, NOW)).toBeNull();
  });

  it('comes with the normal, and the normal comes without it when it cannot be read', async () => {
    const answers = { ...ANSWERS };
    const fetch = (async (url: string) => {
      const name = /\/rpc\/([a-z_]+)$/.exec(url)?.[1];
      if (name) return name in answers ? Response.json(answers[name]) : new Response('nope', { status: 500 });
      if (url.includes('/atmosphere_account_app_sketch')) return Response.json(apps(0, 250, 250, 250, 250));
      return Response.json([everyone(0, 100_000, 1000)]);
    }) as typeof globalThis.fetch;
    const h = createAlmanacHandlers({ fetch, now: () => NOW, env: () => ({}), log: () => undefined });
    const body = (await (await get(h)).json()) as Record<string, any>;
    expect(body.normal.weeks.windows).toBe(2);
    expect(body.normal.diversity).toEqual({ hour: '2026-11-03T16:00:00.000Z', now: { index: 2, share: 1, spread: 4, elsewhere: 1000 }, days: { windows: 0, index: 0 }, weeks: { windows: 0, index: 0 } });
    const without = (await (await get(createAlmanacHandlers({ fetch: supabase().fetch, now: () => NOW, env: () => ({}), log: () => undefined }))).json()) as Record<string, any>;
    expect(without.normal.weeks.windows).toBe(2);
    expect('diversity' in without.normal).toBe(false);
  });
});

describe("the station's records", () => {
  const db = (answers: Record<string, unknown>) => {
    const asked: string[] = [];
    return {
      asked,
      get: async (path: string) => {
        asked.push(path);
        const by = /order=([a-z]+)\.desc/.exec(path)?.[1] ?? '';
        if (!(by in answers)) throw new Error('nope');
        return answers[by];
      },
      rpc: async () => {
        throw new Error('no rpc here');
      },
    };
  };

  it('reads the busiest whole minute and the most apps in a minute, since it listened live', async () => {
    const d = db({
      creates: [{ minute: '2026-10-20T19:04:00+00:00', creates: 30_588, seconds_covered: 60 }],
      apps: [{ minute: '2026-10-21T02:11:00+00:00', apps: 24 }],
    });
    expect(await readRecords(d)).toEqual({
      since: new Date(LIVE_SINCE).toISOString(),
      busiest: { minute: '2026-10-20T19:04:00.000Z', perSecond: 509.8 },
      mostApps: { minute: '2026-10-21T02:11:00.000Z', apps: 24 },
    });
    expect(d.asked).toHaveLength(2);
    for (const path of d.asked) expect(path).toContain(`minute=gte.${new Date(LIVE_SINCE).toISOString()}`);
    expect(d.asked[0]).toContain('seconds_covered=eq.60');
  });

  it('has no record before it has heard a minute, and fails when Supabase does', async () => {
    expect(await readRecords(db({ creates: [], apps: [] }))).toMatchObject({ busiest: null, mostApps: null });
    await expect(readRecords(db({ creates: { not: 'rows' }, apps: [] }))).rejects.toThrow();
    await expect(readRecords(db({ apps: [] }))).rejects.toThrow();
  });
});

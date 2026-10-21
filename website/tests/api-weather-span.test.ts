import { describe, expect, it } from 'vitest';
import * as api from '../api/weather-span.js';
import { LIVE_SINCE } from '../server/weather-almanac.js';
import { cover, createSpanHandlers, GUST_COVERAGE, LIVE_FLOOR, SPANS, stretches, sumRows } from '../server/weather-span.js';

// /api/weather-span: the last-minute tile over an hour, a day or a week, and the stretch
// before it, against a scripted Supabase.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T = (iso: string) => Date.parse(iso);
const at = (ms: number) => new Date(ms).toISOString();

// A sketch with value 1 in the given registers, as PostgREST answers bytea: one account
// per register, so the counts below are exact.
const sk = (...registers: number[]) => `\\x020c${registers.map((i) => `${i.toString(16).padStart(4, '0')}01`).join('')}`;

type Row = Record<string, unknown>;

/**
 * A Supabase that answers each table from rows, filtered the way PostgREST would by the
 * query's eq / gte / lt / lte on any column, ordered, and paged by limit and offset.
 */
function station(tables: Record<string, Row[]>, failing: string[] = []) {
  const asked: URL[] = [];
  const fetch = (async (input: string) => {
    const url = new URL(input);
    asked.push(url);
    const table = url.pathname.split('/').pop()!;
    if (failing.includes(table) || !(table in tables)) return new Response('nope', { status: 500 });
    let rows = tables[table]!.filter((r) =>
      [...url.searchParams].every(([k, v]) => {
        if (['select', 'order', 'limit', 'offset'].includes(k)) return true;
        const [op, ...rest] = v.split('.');
        const want = rest.join('.');
        const x = r[k];
        if (op === 'eq') return String(x) === want;
        const a = T(String(x));
        const b = T(want);
        return op === 'gte' ? a >= b : op === 'lt' ? a < b : op === 'lte' ? a <= b : true;
      }),
    );
    const order = url.searchParams.get('order') ?? '';
    const [key, dir] = order.split(',')[0]!.split('.');
    if (key) rows = [...rows].sort((p, q) => (T(String(p[key])) - T(String(q[key]))) * (dir === 'desc' ? -1 : 1));
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? rows.length);
    return Response.json(rows.slice(offset, offset + limit));
  }) as typeof globalThis.fetch;
  return { asked, fetch };
}

const counts = (rate: number, seconds = 60) => ({ seconds_covered: seconds, creates: rate * seconds, posts: (rate / 10) * seconds, updates: seconds, deletes: 2 * seconds, identity: 1, account: 1 });

function handlers(db: ReturnType<typeof station>, now: number, logged: string[] = []) {
  return createSpanHandlers({ fetch: db.fetch, now: () => now, env: () => ({}), log: (f) => logged.push(f.event) });
}

const get = (h: ReturnType<typeof createSpanHandlers>, span: string) => h.GET(new Request(`https://atpota.to/api/weather-span?span=${span}`));

describe('the stretches', () => {
  it('an hour is whole minutes, up to the one going on; a day or week ends now, by the hour', () => {
    const now = T('2026-11-03T17:20:30Z');
    expect(stretches('hour', now)).toEqual({ now: [T('2026-11-03T16:20:00Z'), T('2026-11-03T17:20:00Z')], before: [T('2026-11-03T15:20:00Z'), T('2026-11-03T16:20:00Z')] });
    expect(stretches('day', now)).toEqual({ now: [T('2026-11-02T18:00:00Z'), now], before: [T('2026-11-01T18:00:00Z'), T('2026-11-02T18:00:00Z')] });
    const week = stretches('week', now);
    expect(week.now).toEqual([T('2026-10-27T18:00:00Z'), now]);
    expect(week.before[1] - week.before[0]).toBe(7 * DAY);
  });

  it('reads whole days where they fit and hours at the edges; ending now, it ends in today so far', () => {
    // the last day: last night's hours, then today's bucket
    expect(cover(T('2026-11-02T18:00:00Z'), T('2026-11-03T17:20:30Z'), true)).toEqual({ days: [T('2026-11-03T00:00:00Z'), T('2026-11-04T00:00:00Z')], hours: [[T('2026-11-02T18:00:00Z'), T('2026-11-03T00:00:00Z')]] });
    // the day before it: no whole day, hours either side of midnight
    expect(cover(T('2026-11-01T18:00:00Z'), T('2026-11-02T18:00:00Z'), false)).toEqual({
      days: null,
      hours: [
        [T('2026-11-01T18:00:00Z'), T('2026-11-02T00:00:00Z')],
        [T('2026-11-02T00:00:00Z'), T('2026-11-02T18:00:00Z')],
      ],
    });
    // a week before: six whole days between the edges
    expect(cover(T('2026-10-20T18:00:00Z'), T('2026-10-27T18:00:00Z'), false)).toEqual({
      days: [T('2026-10-21T00:00:00Z'), T('2026-10-27T00:00:00Z')],
      hours: [
        [T('2026-10-20T18:00:00Z'), T('2026-10-21T00:00:00Z')],
        [T('2026-10-27T00:00:00Z'), T('2026-10-27T18:00:00Z')],
      ],
    });
    // inside one day
    expect(cover(T('2026-11-03T16:00:00Z'), T('2026-11-03T17:20:00Z'), true)).toEqual({ days: null, hours: [[T('2026-11-03T16:00:00Z'), T('2026-11-03T17:20:00Z')]] });
  });

  it('a gust is the busiest row heard well enough, so a sliver of a minute is no burst', () => {
    const row = (rate: number, seconds = 60) => ({ t: 0, seconds, creates: rate * seconds, posts: 0, updates: 0, deletes: 0, identity: 0, account: 0 });
    const sum = sumRows([row(400), row(900), row(5000, 60 * GUST_COVERAGE - 1)], MIN);
    expect(sum.gust).toBe(900);
    expect(sum.seconds).toBe(149);
    expect(sum.creates).toBe(400 * 60 + 900 * 60 + 5000 * 29);
    expect(sumRows([], HOUR).gust).toBeNull();
  });
});

describe('/api/weather-span', () => {
  it('the minute before the live one: the newest whole minute that ended before it began', async () => {
    const now = T('2026-11-03T17:20:30Z');
    const minutes = [17, 18, 19, 20].map((m) => ({ minute: `2026-11-03T17:${m}:00+00:00`, ...counts(400 + m), apps: m, dids: 1000 + m }));
    const db = station({ atmosphere_minute: minutes });
    const res = await get(handlers(db, now), 'minute');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(SPANS.minute.cache);
    const body = (await res.json()) as { span: string; now?: unknown; before: Record<string, unknown> };
    expect(body.now).toBeUndefined();
    // the live 60 seconds began at 17:19:30, so 17:18 is the last minute wholly before it
    expect(body.before).toMatchObject({ since: '2026-11-03T17:18:00.000Z', until: '2026-11-03T17:19:00.000Z', seconds: 60, creates: 418 * 60, apps: 18, active: 1018, activeSeconds: 60, gust: null });
  });

  it('an hour: the last 60 minutes against the 60 before, with apps and accounts for each', async () => {
    const now = T('2026-11-03T17:00:30Z');
    const start = T('2026-11-03T15:00:00Z');
    const minutes = Array.from({ length: 121 }, (_, i) => {
      const t = start + i * MIN;
      const rate = t === T('2026-11-03T16:30:00Z') ? 900 : t >= T('2026-11-03T16:00:00Z') ? 440 : 400;
      return { minute: at(t), ...counts(rate) };
    });
    const db = station({
      atmosphere_minute: minutes,
      atmosphere_minute_app: [
        { minute: '2026-11-03T15:10:00Z', domain: 'a.com' },
        { minute: '2026-11-03T15:20:00Z', domain: 'b.com' },
        { minute: '2026-11-03T16:10:00Z', domain: 'a.com' },
        { minute: '2026-11-03T16:20:00Z', domain: 'c.com' },
        { minute: '2026-11-03T16:30:00Z', domain: 'c.com' },
        { minute: '2026-11-03T16:40:00Z', domain: '<b>x</b>' },
        { minute: '2026-11-03T16:50:00Z', domain: 'd.com' },
      ],
      atmosphere_account_sketch: [
        { period: 'minute', t: '2026-11-03T15:30:00Z', seconds: 60, bluesky: sk(1, 2), elsewhere: sk(3) },
        { period: 'minute', t: '2026-11-03T16:10:00Z', seconds: 60, bluesky: sk(1, 2), elsewhere: sk(3) },
        { period: 'minute', t: '2026-11-03T16:20:00Z', seconds: 60, bluesky: sk(2, 4), elsewhere: sk(3, 5) },
        { period: 'hour', t: '2026-11-03T16:00:00Z', seconds: 3600, bluesky: sk(9, 10, 11), elsewhere: sk(12) },
      ],
    });
    const res = await get(handlers(db, now), 'hour');
    expect(res.headers.get('cache-control')).toBe(SPANS.hour.cache);
    const { now: n, before: b } = (await res.json()) as Record<string, Record<string, number | string>>;
    expect(n).toMatchObject({ since: '2026-11-03T16:00:00.000Z', until: '2026-11-03T17:00:00.000Z', seconds: 3600, gust: 900, apps: 3, active: 5, activeSeconds: 120 });
    expect(n!.creates).toBe(59 * 440 * 60 + 900 * 60);
    expect(b).toMatchObject({ since: '2026-11-03T15:00:00.000Z', seconds: 3600, gust: 400, apps: 2, active: 3, activeSeconds: 60 });
  });

  it('a day: hour rows, apps and accounts from today so far and last night by the hour', async () => {
    const now = T('2026-11-03T17:20:00Z');
    const hours = Array.from({ length: 48 }, (_, i) => ({ hour: at(T('2026-11-01T18:00:00Z') + i * HOUR), ...(i === 47 ? counts(2000, 1200) : counts(i < 24 ? 400 : 450, 3600)) }));
    const db = station({
      atmosphere_hour: hours,
      atmosphere_day_app: [{ day: '2026-11-03T00:00:00Z', domain: 'a.com' }],
      atmosphere_hour_app: [
        { hour: '2026-11-02T20:00:00Z', domain: 'b.com' },
        { hour: '2026-11-02T10:00:00Z', domain: 'c.com' },
      ],
      atmosphere_account_sketch: [
        { period: 'day', t: '2026-11-03T00:00:00Z', seconds: 62_400, bluesky: sk(1), elsewhere: sk(2) },
        { period: 'hour', t: '2026-11-02T20:00:00Z', seconds: 3600, bluesky: sk(1, 3), elsewhere: sk() },
        { period: 'hour', t: '2026-11-02T10:00:00Z', seconds: 3600, bluesky: sk(7), elsewhere: sk() },
      ],
    });
    const res = await get(handlers(db, now), 'day');
    const { now: n, before: b } = (await res.json()) as Record<string, Record<string, number | string>>;
    expect(n).toMatchObject({ since: '2026-11-02T18:00:00.000Z', seconds: 23 * 3600 + 1200, apps: 2, active: 3, activeSeconds: 66_000 });
    // the hour going on is only 20 minutes in: too little of it to be the day's gust
    expect(n!.gust).toBe(450);
    expect(b).toMatchObject({ since: '2026-11-01T18:00:00.000Z', until: '2026-11-02T18:00:00.000Z', seconds: 24 * 3600, apps: 1, active: 1 });
    const asked = db.asked.map((u) => `${u.pathname.split('/').pop()} ${u.searchParams.get('period') ?? ''}`.trim());
    expect(asked).toContain('atmosphere_day_app');
    expect(asked).toContain('atmosphere_account_sketch eq.day');
    expect(asked).not.toContain('atmosphere_minute_app');
  });

  it('30 days: hours, a page at a time, against the 30 days before', async () => {
    const now = T('2027-01-10T12:30:00Z');
    const start = T('2026-11-11T13:00:00Z'); // 1,440 hours back: two stretches of 720
    const hours = Array.from({ length: 1440 }, (_, i) => ({ hour: at(start + i * HOUR), ...counts(i < 720 ? 400 : 450, 3600) }));
    const db = station({ atmosphere_hour: hours, atmosphere_day_app: [], atmosphere_hour_app: [], atmosphere_account_sketch: [] });
    const res = await get(handlers(db, now), 'month');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(SPANS.month.cache);
    const { now: n, before: b } = (await res.json()) as Record<string, Record<string, number | string>>;
    expect(n).toMatchObject({ since: at(start + 720 * HOUR), until: at(now), seconds: 720 * 3600, creates: 450 * 720 * 3600, gust: 450 });
    expect(b).toMatchObject({ since: at(start), until: at(start + 720 * HOUR), seconds: 720 * 3600, creates: 400 * 720 * 3600 });
    // more hours than a page holds
    expect(db.asked.filter((u) => u.pathname.endsWith('/atmosphere_hour')).map((u) => u.searchParams.get('offset'))).toEqual(['0', '1000']);
  });

  it("only counts what the station heard live: a stretch from before has nothing, and asks for nothing", async () => {
    expect(LIVE_FLOOR).toBe(T('2026-10-20T16:00:00Z'));
    const now = T('2026-10-21T14:39:00Z');
    const hours = Array.from({ length: 48 }, (_, i) => ({ hour: at(T('2026-10-19T15:00:00Z') + i * HOUR), ...counts(i < 25 ? 50_000 : 450, 3600) }));
    const db = station({ atmosphere_hour: hours, atmosphere_day_app: [], atmosphere_hour_app: [], atmosphere_account_sketch: [] });
    const { now: n, before: b } = (await (await get(handlers(db, now), 'day')).json()) as Record<string, Record<string, number | string> | null>;
    expect(b).toBeNull();
    expect(n).toMatchObject({ since: '2026-10-20T16:00:00.000Z' });
    expect(n!.gust).toBe(450);
    for (const u of db.asked) for (const v of u.searchParams.values()) if (v.startsWith('gte.')) expect(T(v.slice(4))).toBeGreaterThanOrEqual(LIVE_FLOOR);
    // an hour reaches back to the minute the station went live
    const db2 = station({ atmosphere_minute: [], atmosphere_minute_app: [], atmosphere_account_sketch: [] });
    await get(handlers(db2, LIVE_SINCE + 30 * MIN), 'hour');
    expect(db2.asked.find((u) => u.pathname.endsWith('/atmosphere_minute'))!.searchParams.getAll('minute')[0]).toBe(`gte.${at(LIVE_SINCE)}`);
  });

  it('leaves out apps or accounts that fail, and says unavailable when the rows do', async () => {
    const now = T('2026-11-03T17:00:30Z');
    const minutes = Array.from({ length: 120 }, (_, i) => ({ minute: at(T('2026-11-03T15:00:00Z') + i * MIN), ...counts(400) }));
    const logged: string[] = [];
    const db = station({ atmosphere_minute: minutes, atmosphere_account_sketch: [] }, ['atmosphere_minute_app']);
    const { now: n } = (await (await get(handlers(db, now, logged), 'hour')).json()) as Record<string, Record<string, unknown>>;
    expect(n).toMatchObject({ apps: null, active: null, activeSeconds: 0 });
    expect(logged).toContain('span_apps_error');
    const down = await get(handlers(station({}), now, logged), 'hour');
    expect(down.status).toBe(503);
    expect(down.headers.get('cache-control')).toBe('no-store');
    expect(logged).toContain('span_error');
  });

  it("takes minute, hour, day, week or month; anything else is a 400, and only GET and HEAD", async () => {
    const res = await get(handlers(station({}), Date.now()), 'year');
    expect(res.status).toBe(400);
    const post = await api.POST(new Request('https://atpota.to/api/weather-span', { method: 'POST' }));
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });
});

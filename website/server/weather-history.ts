/**
 * /api/weather-history: the weather report's trends, from the weather station's minute
 * rows in Supabase (atmosphere/SPEC.md, server/supabase-public.ts). Everything there is
 * readable by anyone; this only picks the right table, checks the rows and lets the CDN
 * cache them.
 *
 *   GET /api/weather-history?range=hour   the last 60 minutes, a point a minute
 *                                ?range=day    the last 24 hours, a point an hour
 *                                ?range=week   the last 7 days, a point an hour
 *                                ?range=month  the last 30 days, a point a day
 *                                ?range=year   the last 12 months, a point a month
 *   ->  { range, points: Point[], total: Point, apps?, compare?, appsOverTime?, accounts? }
 *
 * Points are raw counts with the seconds they cover, never rates: a rate is
 * count / seconds, worked out in the page, so summing points (into months, or into the
 * total) stays exact. The diversity index goes by accounts, so it comes with them.
 *
 * Alongside, each from a read-only function (atmosphere/sql/atmosphere_almanac.sql) and
 * left out if it fails:
 *   apps          the busiest apps outside Bluesky over the range, each with its count in
 *                 an earlier window of the same length (atmosphere_app_trends): the same
 *                 hour yesterday, the day before, the week before, the 30 days before,
 *                 the year before
 *   compare       how much of the range and of that earlier window the station heard, so
 *                 the page compares rates, not counts
 *   appsOverTime  how many apps outside Bluesky were heard each minute, hour, day or
 *                 month (atmosphere_apps_over_time)
 *   accounts      active accounts (different DIDs) over the range and in each bucket, the
 *                 diversity index they make, and the apps with the most, from the
 *                 station's sketches (weather-accounts.ts)
 */

import { readAccounts } from './weather-accounts.js';
import { collectionsOf, counts, DOMAIN_RE, isRecord, iso, json, methodNotAllowed, num, supabase, type Env, type Fetch } from './supabase-public.js';

export { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './supabase-public.js';

export const COUNTS = ['creates', 'bluesky', 'elsewhere', 'posts', 'likes', 'reposts', 'follows', 'updates', 'deletes', 'identity', 'account'] as const;
export type CountKey = (typeof COUNTS)[number];

export type Point = { t: string; seconds: number } & Record<CountKey, number>;

export interface App {
  domain: string;
  creates: number;
  /** Its records in the earlier window. */
  prevCreates: number;
  collections: string[];
}

export interface Compare {
  seconds: number;
  prevSeconds: number;
  /** How far back the earlier window is. */
  lagMs: number;
}

export type Bucket = 'minute' | 'hour' | 'day' | 'month';

export const TOP_APPS = 10;
const DAY = 86_400_000;

export const RANGES = {
  hour: { table: 'atmosphere_minute', key: 'minute', spanMs: 60 * 60_000, lagMs: DAY, bucket: 'minute', cache: 'public, max-age=0, s-maxage=30, stale-while-revalidate=300' },
  day: { table: 'atmosphere_hour', key: 'hour', spanMs: DAY, lagMs: DAY, bucket: 'hour', cache: 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600' },
  week: { table: 'atmosphere_hour', key: 'hour', spanMs: 7 * DAY, lagMs: 7 * DAY, bucket: 'hour', cache: 'public, max-age=0, s-maxage=900, stale-while-revalidate=3600' },
  month: { table: 'atmosphere_day', key: 'day', spanMs: 30 * DAY, lagMs: 30 * DAY, bucket: 'day', cache: 'public, max-age=0, s-maxage=1800, stale-while-revalidate=86400' },
  year: { table: 'atmosphere_day', key: 'day', spanMs: 366 * DAY, lagMs: 366 * DAY, bucket: 'month', cache: 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400' },
} as const satisfies Record<string, { table: string; key: string; spanMs: number; lagMs: number; bucket: Bucket; cache: string }>;

export type Range = keyof typeof RANGES;

export function isRange(v: string | null): v is Range {
  return v !== null && Object.hasOwn(RANGES, v);
}

/** The start of a range ending at `now`. */
export function rangeStart(range: Range, now: number): string {
  return new Date(now - RANGES[range].spanMs).toISOString();
}

/** The PostgREST path (under /rest/v1/) for a range ending at `now`. */
export function queryPath(range: Range, now: number): string {
  const { table, key } = RANGES[range];
  const params = new URLSearchParams({ select: [key, 'seconds_covered', ...COUNTS].join(','), order: `${key}.asc`, limit: '1000' });
  params.set(key, `gte.${rangeStart(range, now)}`);
  return `${table}?${params}`;
}

export function queryUrl(base: string, range: Range, now: number): string {
  return `${base}/rest/v1/${queryPath(range, now)}`;
}

/** The arguments to atmosphere_app_trends: the range, and the same span `lagMs` earlier. */
export function trendArgs(range: Range, now: number) {
  const { spanMs, lagMs } = RANGES[range];
  const at = (ms: number) => new Date(ms).toISOString();
  return { since: at(now - spanMs), until: at(now), prev_since: at(now - spanMs - lagMs), prev_until: at(now - lagMs), max_apps: TOP_APPS };
}

/** A row as a Point, or null if anything is off. Views sum to numeric, which may arrive as strings. */
export function toPoint(row: unknown, key: string): Point | null {
  if (!isRecord(row)) return null;
  const t = iso(row[key]);
  const seconds = num(row.seconds_covered);
  if (!t || !Number.isFinite(seconds) || seconds <= 0) return null;
  const c = counts(row, COUNTS);
  return c ? ({ t, seconds, ...c } as Point) : null;
}

/** An atmosphere_app_trends app, or null if it doesn't check out (names are someone else's text). */
export function toApp(row: unknown): App | null {
  if (!isRecord(row) || typeof row.domain !== 'string' || !DOMAIN_RE.test(row.domain)) return null;
  const c = counts(row, ['creates', 'prevCreates'] as const);
  return c ? { domain: row.domain, creates: c.creates, prevCreates: c.prevCreates, collections: collectionsOf(row.collections) } : null;
}

export function sumPoints(points: Point[], t: string): Point {
  const total = { t, seconds: 0 } as Point;
  for (const k of COUNTS) total[k] = 0;
  for (const p of points) {
    total.seconds += p.seconds;
    for (const k of COUNTS) total[k] += p[k];
  }
  return total;
}

/** Days into calendar months (UTC), oldest first. */
export function byMonth(days: Point[]): Point[] {
  const months = new Map<string, Point[]>();
  for (const d of days) {
    const key = `${d.t.slice(0, 7)}-01T00:00:00.000Z`;
    months.set(key, [...(months.get(key) ?? []), d]);
  }
  return [...months].map(([t, ps]) => sumPoints(ps, t));
}

export interface HistoryDeps {
  fetch?: Fetch;
  now?: () => number;
  env?: () => Env;
  log?: (fields: { event: string; [k: string]: unknown }) => void;
}

export function createHistoryHandlers(deps: HistoryDeps = {}) {
  const fetchImpl: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => Date.now());
  const env = deps.env ?? (() => process.env);
  const log = deps.log ?? ((fields) => console.warn(JSON.stringify({ src: 'weather-history', ...fields })));

  async function GET(request: Request): Promise<Response> {
    const range = new URL(request.url).searchParams.get('range') ?? 'day';
    if (!isRange(range)) return json(request, 400, { error: 'range must be hour, day, week, month or year' }, 'no-store');
    const db = supabase(env(), fetchImpl);
    const at = now();
    const { key: column, cache, lagMs, bucket } = RANGES[range];
    /** An extra: asked alongside the points, and left out if it doesn't come. */
    const extra = async <T>(what: string, run: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await run();
      } catch (error) {
        log({ event: `history_${what}_error`, range, error: (error as Error)?.message ?? 'Error' });
        return undefined;
      }
    };
    const trends = extra('apps', async () => {
      const body = await db.rpc('atmosphere_app_trends', trendArgs(range, at));
      const c = counts(body, ['seconds', 'prevSeconds'] as const);
      if (!c || !isRecord(body) || !Array.isArray(body.apps)) throw new Error('apps did not check out');
      const apps = body.apps.map(toApp).filter((a): a is App => a !== null).slice(0, TOP_APPS);
      return { apps, compare: { seconds: c.seconds, prevSeconds: c.prevSeconds, lagMs } satisfies Compare };
    });
    const appsOverTime = extra('apps_over_time', async () => {
      const body = await db.rpc('atmosphere_apps_over_time', { since: rangeStart(range, at), bucket });
      if (!Array.isArray(body)) throw new Error('apps over time did not check out');
      const points = body.flatMap((p) => {
        const t = isRecord(p) ? iso(p.t) : null;
        const c = counts(p, ['apps'] as const);
        return t && c ? [{ t, apps: c.apps }] : [];
      });
      return { bucket, points };
    });
    const accounts = extra('accounts', () => {
      const { since, until, prev_since, prev_until } = trendArgs(range, at);
      return readAccounts(db, { since, until, prev_since, prev_until, period: bucket, maxApps: TOP_APPS });
    });
    let rows: unknown;
    try {
      rows = await db.get(queryPath(range, at));
      if (!Array.isArray(rows)) throw new Error('supabase answered something other than rows');
    } catch (error) {
      log({ event: 'history_error', range, error: (error as Error)?.message ?? 'Error' });
      return json(request, 503, { error: 'unavailable' }, 'no-store');
    }
    const points = (rows as unknown[]).map((r) => toPoint(r, column)).filter((p): p is Point => p !== null);
    const shaped = range === 'year' ? byMonth(points) : points;
    const t = await trends;
    return json(
      request,
      200,
      { range, points: shaped, total: sumPoints(points, new Date(at).toISOString()), apps: t?.apps, compare: t?.compare, appsOverTime: await appsOverTime, accounts: await accounts },
      cache,
    );
  }

  return { GET, HEAD: GET, methodNotAllowed: async (request: Request) => methodNotAllowed(request) };
}

/**
 * /api/weather-history: the weather report's trends, from the weather station's minute
 * rows in Supabase (atmosphere/SPEC.md). Everything there is readable by anyone, so this
 * uses the project's publishable key; it only exists to pick the right table, check the
 * rows and let the CDN cache them.
 *
 *   GET /api/weather-history?range=hour   the last 60 minutes, a point a minute
 *                                ?range=day    the last 24 hours, a point an hour
 *                                ?range=month  the last 30 days, a point a day
 *                                ?range=year   the last 12 months, a point a month
 *   ->  { range, points: Point[], total: Point }
 *
 * Points are raw counts with the seconds they cover, never rates: a rate is
 * count / seconds and the diversity index is 100 * elsewhere / creates, worked out in the
 * page, so summing points (into months, or into the total) stays exact.
 */

export const SUPABASE_URL = 'https://zdzjtziydmwkxbzlkwxv.supabase.co';
/** The project's publishable key: public by design, it only reaches what row-level security lets anyone read. */
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_pPelLpQDK2XWc9HuxjUOmQ_RlPfGcx_';
export const UPSTREAM_TIMEOUT_MS = 5000;

export const COUNTS = ['creates', 'bluesky', 'elsewhere', 'posts', 'likes', 'reposts', 'follows', 'updates', 'deletes', 'identity', 'account'] as const;
export type CountKey = (typeof COUNTS)[number];

export type Point = { t: string; seconds: number } & Record<CountKey, number>;

export const RANGES = {
  hour: { table: 'atmosphere_minute', key: 'minute', spanMs: 60 * 60_000, cache: 'public, max-age=0, s-maxage=30, stale-while-revalidate=300' },
  day: { table: 'atmosphere_hour', key: 'hour', spanMs: 24 * 3600_000, cache: 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600' },
  month: { table: 'atmosphere_day', key: 'day', spanMs: 30 * 86_400_000, cache: 'public, max-age=0, s-maxage=1800, stale-while-revalidate=86400' },
  year: { table: 'atmosphere_day', key: 'day', spanMs: 366 * 86_400_000, cache: 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400' },
} as const;

export type Range = keyof typeof RANGES;

export function isRange(v: string | null): v is Range {
  return v !== null && Object.hasOwn(RANGES, v);
}

/** The PostgREST query for a range ending at `now`. */
export function queryUrl(base: string, range: Range, now: number): string {
  const { table, key, spanMs } = RANGES[range];
  const from = new Date(now - spanMs).toISOString();
  const params = new URLSearchParams({ select: [key, 'seconds_covered', ...COUNTS].join(','), order: `${key}.asc`, limit: '1000' });
  params.set(key, `gte.${from}`);
  return `${base}/rest/v1/${table}?${params}`;
}

/** A row as a Point, or null if anything is off. Views sum to numeric, which may arrive as strings. */
export function toPoint(row: unknown, key: string): Point | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  const t = typeof r[key] === 'string' ? Date.parse(r[key] as string) : NaN;
  const n = (x: unknown) => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN);
  const seconds = n(r.seconds_covered);
  if (!Number.isFinite(t) || !Number.isFinite(seconds) || seconds <= 0) return null;
  const point = { t: new Date(t).toISOString(), seconds } as Point;
  for (const k of COUNTS) {
    const v = n(r[k]);
    if (!Number.isFinite(v) || v < 0) return null;
    point[k] = v;
  }
  return point;
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
  fetch?: typeof fetch;
  now?: () => number;
  env?: () => Record<string, string | undefined>;
  log?: (fields: { event: string; [k: string]: unknown }) => void;
}

const BASE_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' } as const;

export function createHistoryHandlers(deps: HistoryDeps = {}) {
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => Date.now());
  const env = deps.env ?? (() => process.env);
  const log = deps.log ?? ((fields) => console.warn(JSON.stringify({ src: 'weather-history', ...fields })));
  const answer = (request: Request, status: number, body: unknown, cache: string) =>
    new Response(request.method === 'HEAD' ? null : JSON.stringify(body), { status, headers: { ...BASE_HEADERS, 'cache-control': cache } });

  async function GET(request: Request): Promise<Response> {
    const range = new URL(request.url).searchParams.get('range') ?? 'day';
    if (!isRange(range)) return answer(request, 400, { error: 'range must be hour, day, month or year' }, 'no-store');
    const vars = env();
    const base = (vars.ATMOSPHERE_SUPABASE_URL?.trim() || SUPABASE_URL).replace(/\/+$/, '');
    const key = vars.ATMOSPHERE_SUPABASE_KEY?.trim() || SUPABASE_PUBLISHABLE_KEY;
    let rows: unknown;
    try {
      const res = await fetchImpl(queryUrl(base, range, now()), {
        headers: { accept: 'application/json', apikey: key },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`supabase answered ${res.status}`);
      rows = await res.json();
      if (!Array.isArray(rows)) throw new Error('supabase answered something other than rows');
    } catch (error) {
      log({ event: 'history_error', range, error: (error as Error)?.message ?? 'Error' });
      return answer(request, 503, { error: 'unavailable' }, 'no-store');
    }
    const { key: column, cache } = RANGES[range];
    const points = (rows as unknown[]).map((r) => toPoint(r, column)).filter((p): p is Point => p !== null);
    const shaped = range === 'year' ? byMonth(points) : points;
    return answer(request, 200, { range, points: shaped, total: sumPoints(points, new Date(now()).toISOString()) }, cache);
  }

  return {
    GET,
    HEAD: GET,
    async methodNotAllowed(request: Request) {
      return new Response(request.method === 'HEAD' ? null : 'method not allowed\n', {
        status: 405,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', allow: 'GET, HEAD', 'x-content-type-options': 'nosniff' },
      });
    },
  };
}

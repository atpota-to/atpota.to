/**
 * /api/weather-span: the weather report's "last minute" tile over a longer stretch, and the
 * stretch right before it, so the page can say what's up and what's down. From the weather
 * station's rows in Supabase (atmosphere/SPEC.md), read the way anyone could
 * (supabase-public.ts).
 *
 *   GET /api/weather-span?span=minute   only the minute before (the page has the live one)
 *                            ?span=hour     the last 60 whole minutes, and the 60 before
 *                            ?span=day      the last 24 hours (this one so far), and the 24 before
 *                            ?span=week     the last 7 days, by the hour the same way, and the 7 before
 *   ->  { span, now?: Stretch, before: Stretch | null }
 *
 * A stretch is raw counts with the seconds the station heard, never rates, like
 * weather-history's points, and three things that don't add up from rows:
 *   gust    records a second in its busiest minute (an hour) or hour (a day or week)
 *   apps    how many different apps outside Bluesky wrote anything
 *   active  how many different accounts wrote anything: the station's sketches, merged
 *           (hll.ts), with the seconds they cover
 * Apps and accounts come from the coarsest rows that fit: whole UTC days inside the
 * stretch, hours at its edges, minutes for an hour. Each is null if it doesn't come.
 *
 * Only what the station heard live (LIVE_SINCE): the archive's backfill heard a fifth of
 * the edits and fewer apps and accounts, so a stretch of it isn't one to compare with. A
 * stretch with nothing live in it is null, and the page waits to show arrows.
 */

import { countSketch, emptySketch, fromBytea, mergeSketch } from './hll.js';
import { counts, DOMAIN_RE, isRecord, iso, json, methodNotAllowed, num, supabase, type Env, type Fetch, type Supabase } from './supabase-public.js';
import { getAll } from './weather-accounts.js';
import { LIVE_SINCE } from './weather-almanac.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const SPAN_COUNTS = ['creates', 'posts', 'updates', 'deletes', 'identity', 'account'] as const;
export type SpanCount = (typeof SPAN_COUNTS)[number];

export type Stretch = {
  since: string;
  until: string;
  seconds: number;
  gust: number | null;
  apps: number | null;
  active: number | null;
  /** How much of the stretch the station heard while counting accounts. */
  activeSeconds: number;
} & Record<SpanCount, number>;

export const SPANS = {
  minute: { stretchMs: MINUTE, cache: 'public, max-age=0, s-maxage=30, stale-while-revalidate=120' },
  hour: { stretchMs: HOUR, cache: 'public, max-age=0, s-maxage=60, stale-while-revalidate=300' },
  day: { stretchMs: DAY, cache: 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600' },
  week: { stretchMs: 7 * DAY, cache: 'public, max-age=0, s-maxage=900, stale-while-revalidate=3600' },
} as const;

export type Span = keyof typeof SPANS;

export function isSpan(v: string | null): v is Span {
  return v !== null && Object.hasOwn(SPANS, v);
}

/** A gust needs this much of its minute or hour heard, so a sliver of one can't pass for a burst. */
export const GUST_COVERAGE = 0.5;
/** The hour the station started listening live in; nothing in it came from the archive. */
export const LIVE_FLOOR = Math.floor(LIVE_SINCE / HOUR) * HOUR;

const floorTo = (t: number, unit: number) => Math.floor(t / unit) * unit;
const ceilTo = (t: number, unit: number) => Math.ceil(t / unit) * unit;
const at = (t: number) => new Date(t).toISOString();

/**
 * The two stretches for a span at `now`, as [since, until) in ms, earliest first. An hour
 * is whole minutes, up to the one going on; a day or week is hours, up to and including
 * the one going on, so each ends now.
 */
export function stretches(span: Exclude<Span, 'minute'>, now: number): { now: [number, number]; before: [number, number] } {
  if (span === 'hour') {
    const m = floorTo(now, MINUTE);
    return { now: [m - HOUR, m], before: [m - 2 * HOUR, m - HOUR] };
  }
  const n = SPANS[span].stretchMs / HOUR;
  const h = floorTo(now, HOUR);
  return { now: [h - (n - 1) * HOUR, now], before: [h - (2 * n - 1) * HOUR, h - (n - 1) * HOUR] };
}

/**
 * [since, until) as the station's day and hour buckets: whole UTC days inside it, hours at
 * its edges. A stretch that ends now ends in today's day bucket, which holds today so far.
 */
export function cover(since: number, until: number, endsNow: boolean): { days: [number, number] | null; hours: Array<[number, number]> } {
  const first = ceilTo(since, DAY);
  if (first >= until) return { days: null, hours: [[since, until]] };
  let last = first;
  while (last + DAY <= until) last += DAY;
  if (endsNow && last < until) last += DAY;
  const hours: Array<[number, number]> = [];
  if (since < first) hours.push([since, first]);
  if (last < until) hours.push([last, until]);
  return { days: last > first ? [first, last] : null, hours };
}

type Row = { t: number; seconds: number } & Record<SpanCount, number>;

function toRow(row: unknown, key: string): Row | null {
  const t = isRecord(row) ? iso(row[key]) : null;
  const seconds = isRecord(row) ? num(row.seconds_covered) : NaN;
  const c = counts(row, SPAN_COUNTS);
  return t && c && Number.isFinite(seconds) && seconds > 0 ? { t: Date.parse(t), seconds, ...c } : null;
}

/** Rows into a stretch's counts and its gust: the busiest row of `rowMs` heard well enough. */
export function sumRows(rows: Row[], rowMs: number): { seconds: number; gust: number | null } & Record<SpanCount, number> {
  const total = { seconds: 0, gust: null as number | null } as { seconds: number; gust: number | null } & Record<SpanCount, number>;
  for (const k of SPAN_COUNTS) total[k] = 0;
  for (const r of rows) {
    total.seconds += r.seconds;
    for (const k of SPAN_COUNTS) total[k] += r[k];
    if (r.seconds >= (rowMs / 1000) * GUST_COVERAGE) total.gust = Math.max(total.gust ?? 0, r.creates / r.seconds);
  }
  return total;
}

const between = (key: string, from: number, to: number) => `${key}=gte.${at(from)}&${key}=lt.${at(to)}`;

/** Different apps outside Bluesky heard over [since, until): minute rows for an hour, else days and hours. */
async function appsOver(db: Supabase, since: number, until: number, endsNow: boolean, byMinute: boolean): Promise<number> {
  const queries = byMinute
    ? [`atmosphere_minute_app?select=domain&${between('minute', since, until)}&order=minute.asc,domain.asc`]
    : (() => {
        const { days, hours } = cover(since, until, endsNow);
        return [
          ...(days ? [`atmosphere_day_app?select=domain&${between('day', days[0], days[1])}&order=day.asc,domain.asc`] : []),
          ...hours.map(([from, to]) => `atmosphere_hour_app?select=domain&${between('hour', from, to)}&order=hour.asc,domain.asc`),
        ];
      })();
  const domains = new Set<string>();
  for (const rows of await Promise.all(queries.map((q) => getAll(db, q)))) {
    for (const r of rows) if (isRecord(r) && typeof r.domain === 'string' && DOMAIN_RE.test(r.domain)) domains.add(r.domain);
  }
  return domains.size;
}

/** Different accounts over [since, until), from the station's sketches merged, and the seconds they cover. */
async function activeOver(db: Supabase, since: number, until: number, endsNow: boolean, byMinute: boolean): Promise<{ active: number; seconds: number }> {
  const sketches = (period: string, from: number, to: number) => `atmosphere_account_sketch?select=seconds,bluesky,elsewhere&period=eq.${period}&${between('t', from, to)}&order=t.asc`;
  const { days, hours } = byMinute ? { days: null, hours: [] } : cover(since, until, endsNow);
  const queries = byMinute ? [sketches('minute', since, until)] : [...(days ? [sketches('day', days[0], days[1])] : []), ...hours.map(([from, to]) => sketches('hour', from, to))];
  const everyone = emptySketch();
  let seconds = 0;
  for (const rows of await Promise.all(queries.map((q) => getAll(db, q)))) {
    for (const r of rows) {
      const b = isRecord(r) ? fromBytea(r.bluesky) : null;
      const e = isRecord(r) ? fromBytea(r.elsewhere) : null;
      const s = isRecord(r) ? num(r.seconds) : NaN;
      if (!b || !e || !Number.isFinite(s) || s < 0) continue;
      mergeSketch(mergeSketch(everyone, b), e);
      seconds += s;
    }
  }
  return { active: seconds > 0 ? countSketch(everyone) : 0, seconds };
}

export interface SpanDeps {
  fetch?: Fetch;
  now?: () => number;
  env?: () => Env;
  log?: (fields: { event: string; [k: string]: unknown }) => void;
}

export function createSpanHandlers(deps: SpanDeps = {}) {
  const fetchImpl: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => Date.now());
  const env = deps.env ?? (() => process.env);
  const log = deps.log ?? ((fields) => console.warn(JSON.stringify({ src: 'weather-span', ...fields })));

  /** The minute before the live one: the newest whole minute that ended before the live 60 seconds began. */
  async function minuteBefore(db: Supabase, t: number): Promise<Stretch | null> {
    const rows = await db.get(
      `atmosphere_minute?select=minute,seconds_covered,${SPAN_COUNTS.join(',')},apps,dids&minute=lte.${at(t - 2 * MINUTE)}&minute=gte.${at(Math.max(t - 10 * MINUTE, LIVE_SINCE))}&order=minute.desc&limit=1`,
    );
    if (!Array.isArray(rows)) throw new Error('supabase answered something other than rows');
    const raw = rows[0];
    const row = toRow(raw, 'minute');
    if (!row || !isRecord(raw)) return null;
    const apps = num(raw.apps);
    const dids = num(raw.dids);
    return {
      since: at(row.t),
      until: at(row.t + MINUTE),
      ...sumRows([row], MINUTE),
      // the station keeps no seconds for a minute gone by
      gust: null,
      apps: Number.isFinite(apps) && apps >= 0 ? apps : null,
      active: Number.isFinite(dids) && dids >= 0 ? dids : null,
      activeSeconds: Number.isFinite(dids) && dids >= 0 ? row.seconds : 0,
    };
  }

  async function GET(request: Request): Promise<Response> {
    const span = new URL(request.url).searchParams.get('span') ?? 'minute';
    if (!isSpan(span)) return json(request, 400, { error: 'span must be minute, hour, day or week' }, 'no-store');
    const db = supabase(env(), fetchImpl);
    const t = now();
    const { cache } = SPANS[span];
    const fail = (error: unknown) => {
      log({ event: 'span_error', span, error: (error as Error)?.message ?? 'Error' });
      return json(request, 503, { error: 'unavailable' }, 'no-store');
    };
    if (span === 'minute') {
      try {
        return json(request, 200, { span, before: await minuteBefore(db, t) }, cache);
      } catch (error) {
        return fail(error);
      }
    }

    const byMinute = span === 'hour';
    const s = stretches(span, t);
    const table = byMinute ? 'atmosphere_minute' : 'atmosphere_hour';
    const key = byMinute ? 'minute' : 'hour';
    const rowMs = byMinute ? MINUTE : HOUR;
    /** The live part of a stretch, or null if it has none. */
    const live = ([since, until]: [number, number]): [number, number] | null => {
      const from = Math.max(since, byMinute ? LIVE_SINCE : LIVE_FLOOR);
      return from < until ? [from, until] : null;
    };
    /** Apps or accounts over one stretch, null if they don't come. */
    const extra = async <T>(what: string, run: () => Promise<T>): Promise<T | null> => {
      try {
        return await run();
      } catch (error) {
        log({ event: `span_${what}_error`, span, error: (error as Error)?.message ?? 'Error' });
        return null;
      }
    };
    const parts = (['now', 'before'] as const).map((which) => {
      const w = live(s[which]);
      const endsNow = which === 'now';
      return {
        w,
        apps: w ? extra('apps', () => appsOver(db, w[0], w[1], endsNow, byMinute)) : Promise.resolve(null),
        active: w ? extra('accounts', () => activeOver(db, w[0], w[1], endsNow, byMinute)) : Promise.resolve(null),
      };
    });

    const all = live([s.before[0], s.now[1]]);
    let rows: Row[] = [];
    if (all) {
      try {
        const got = await db.get(`${table}?select=${key},seconds_covered,${SPAN_COUNTS.join(',')}&${between(key, all[0], all[1])}&order=${key}.asc&limit=1000`);
        if (!Array.isArray(got)) throw new Error('supabase answered something other than rows');
        rows = got.map((r) => toRow(r, key)).filter((r): r is Row => r !== null);
      } catch (error) {
        return fail(error);
      }
    }

    const [current, before] = await Promise.all(
      parts.map(async ({ w, apps, active }): Promise<Stretch | null> => {
        if (!w) return null;
        const sums = sumRows(
          rows.filter((r) => r.t >= w[0] && r.t < w[1]),
          rowMs,
        );
        if (sums.seconds <= 0) return null;
        const a = await active;
        return { since: at(w[0]), until: at(w[1]), ...sums, apps: await apps, active: a && a.seconds > 0 ? a.active : null, activeSeconds: a?.seconds ?? 0 };
      }),
    );
    return json(request, 200, { span, now: current, before }, cache);
  }

  return { GET, HEAD: GET, methodNotAllowed: async (request: Request) => methodNotAllowed(request) };
}

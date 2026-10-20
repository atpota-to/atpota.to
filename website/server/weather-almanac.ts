/**
 * /api/weather-almanac: the weather report's almanac, from the weather station's minute
 * rows in Supabase (server/supabase-public.ts, atmosphere/sql/atmosphere_almanac.sql).
 *
 *   GET /api/weather-almanac?tz=America/New_York
 *   ->  { tz, today?, normal?, newApps?, heatmap? }
 *
 *   today    today so far, from midnight in `tz`: totals, and the busiest and quietest
 *            whole minute by new records a second, every app (atmosphere_today's
 *            recordsHigh / recordsLow)
 *   normal   the last hour against the same hour on the days before and on the same
 *            weekday in the weeks before (atmosphere_normal); the page words it
 *   newApps  apps outside Bluesky heard in the last 24 hours that the station had never
 *            heard before (atmosphere_new_apps). Until the station has listened for
 *            WARMUP_MS, every app is new to it, so it says it's warming up instead
 *   heatmap  every hour of the week in `tz` over the last HEATMAP_MS (atmosphere_heatmap)
 *
 * Each part is asked for at once and left out if it fails; only all four failing is a
 * 503. `tz` is an IANA zone name (the page sends the reader's own); anything else is a 400.
 * Cached at the CDN for a minute per zone.
 */

import { collectionsOf, counts, DOMAIN_RE, isRecord, iso, json, methodNotAllowed, supabase, type Env, type Fetch } from './supabase-public.js';

export const CACHE = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';
const DAY = 86_400_000;
/** How long the station listens before an app it hasn't heard counts as new. */
export const WARMUP_MS = 7 * DAY;
export const HEATMAP_MS = 8 * 7 * DAY;
export const NEW_APPS = 20;

const TZ_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

/** An IANA time zone this runtime knows, or null. */
export function timeZone(raw: string | null): string | null {
  const tz = raw?.trim() || 'UTC';
  if (tz.length > 64 || !TZ_RE.test(tz)) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

const SUMS = ['seconds', 'posts', 'creates', 'elsewhere'] as const;
type Sums = Record<(typeof SUMS)[number], number>;

export interface Extreme {
  minute: string;
  perSecond: number;
}

export interface Today extends Sums {
  start: string;
  high: Extreme | null;
  low: Extreme | null;
}

export interface Normal {
  historyStart: string | null;
  now: Sums;
  /** The same hour on each of the 6 days before, where the station heard at least half of it. */
  days: Sums & { windows: number };
  /** The same hour and weekday in each of the 8 weeks before. */
  weeks: Sums & { windows: number };
}

export interface NewApp {
  domain: string;
  firstSeen: string;
  creates: number;
  collections: string[];
}

export interface NewApps {
  historyStart: string | null;
  /** When an unheard app starts to count as new. */
  readyAt: string | null;
  warmingUp: boolean;
  /** Apps outside Bluesky heard in the last 24 hours. */
  heard: number;
  apps: NewApp[];
}

export interface HeatCell {
  /** ISO weekday, 1 = monday. */
  dow: number;
  hour: number;
  seconds: number;
  posts: number;
  creates: number;
}

export interface Heatmap {
  seconds: number;
  cells: HeatCell[];
}

function extreme(x: unknown): Extreme | null {
  if (!isRecord(x)) return null;
  const minute = iso(x.minute);
  const c = counts(x, ['perSecond'] as const);
  return minute && c ? { minute, perSecond: c.perSecond } : null;
}

export function toToday(body: unknown): Today | null {
  const sums = counts(body, SUMS);
  const start = isRecord(body) ? iso(body.start) : null;
  if (!sums || !start || !isRecord(body)) return null;
  return { start, ...sums, high: extreme(body.recordsHigh), low: extreme(body.recordsLow) };
}

export function toNormal(body: unknown): Normal | null {
  if (!isRecord(body)) return null;
  const now = counts(body.now, SUMS);
  const days = counts(body.days, [...SUMS, 'windows'] as const);
  const weeks = counts(body.weeks, [...SUMS, 'windows'] as const);
  if (!now || !days || !weeks) return null;
  return { historyStart: iso(body.historyStart), now, days, weeks };
}

export function toNewApps(body: unknown, now: number): NewApps | null {
  if (!isRecord(body) || !Array.isArray(body.apps)) return null;
  const heard = counts(body, ['heard'] as const);
  if (!heard) return null;
  const historyStart = iso(body.historyStart);
  const readyAt = historyStart ? new Date(Date.parse(historyStart) + WARMUP_MS).toISOString() : null;
  const warmingUp = !readyAt || now < Date.parse(readyAt);
  const apps = warmingUp
    ? []
    : body.apps.flatMap((a): NewApp[] => {
        if (!isRecord(a) || typeof a.domain !== 'string' || !DOMAIN_RE.test(a.domain)) return [];
        const firstSeen = iso(a.firstSeen);
        const c = counts(a, ['creates'] as const);
        // Heard before the station had warmed up means "new to the station", not new.
        if (!firstSeen || !c || Date.parse(firstSeen) < Date.parse(readyAt!)) return [];
        return [{ domain: a.domain, firstSeen, creates: c.creates, collections: collectionsOf(a.collections) }];
      });
  return { historyStart, readyAt, warmingUp, heard: heard.heard, apps: apps.slice(0, NEW_APPS) };
}

export function toHeatmap(body: unknown): Heatmap | null {
  if (!isRecord(body) || !Array.isArray(body.cells)) return null;
  const total = counts(body, ['seconds'] as const);
  if (!total) return null;
  const cells = body.cells.flatMap((c): HeatCell[] => {
    const v = counts(c, ['dow', 'hour', 'seconds', 'posts', 'creates'] as const);
    if (!v || !Number.isInteger(v.dow) || v.dow < 1 || v.dow > 7 || !Number.isInteger(v.hour) || v.hour > 23) return [];
    return [v];
  });
  return { seconds: total.seconds, cells };
}

export interface AlmanacDeps {
  fetch?: Fetch;
  now?: () => number;
  env?: () => Env;
  log?: (fields: { event: string; [k: string]: unknown }) => void;
}

export function createAlmanacHandlers(deps: AlmanacDeps = {}) {
  const fetchImpl: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => Date.now());
  const env = deps.env ?? (() => process.env);
  const log = deps.log ?? ((fields) => console.warn(JSON.stringify({ src: 'weather-almanac', ...fields })));

  async function GET(request: Request): Promise<Response> {
    const tz = timeZone(new URL(request.url).searchParams.get('tz'));
    if (!tz) return json(request, 400, { error: 'tz must be an IANA time zone, like Europe/London' }, 'no-store');
    const db = supabase(env(), fetchImpl);
    const at = now();
    const part = async <T>(what: string, run: () => Promise<T | null>): Promise<T | undefined> => {
      try {
        const v = await run();
        if (v === null) throw new Error(`${what} did not check out`);
        return v;
      } catch (error) {
        log({ event: `almanac_${what}_error`, tz, error: (error as Error)?.message ?? 'Error' });
        return undefined;
      }
    };
    const [today, normal, newApps, heatmap] = await Promise.all([
      part('today', async () => toToday(await db.rpc('atmosphere_today', { tz }))),
      part('normal', async () => toNormal(await db.rpc('atmosphere_normal', {}))),
      part('new_apps', async () => toNewApps(await db.rpc('atmosphere_new_apps', { since: new Date(at - DAY).toISOString(), max_apps: 50 }), at)),
      part('heatmap', async () => toHeatmap(await db.rpc('atmosphere_heatmap', { tz, since: new Date(at - HEATMAP_MS).toISOString() }))),
    ]);
    if (!today && !normal && !newApps && !heatmap) return json(request, 503, { error: 'unavailable' }, 'no-store');
    return json(request, 200, { tz, today, normal, newApps, heatmap }, CACHE);
  }

  return { GET, HEAD: GET, methodNotAllowed: async (request: Request) => methodNotAllowed(request) };
}

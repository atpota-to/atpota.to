/**
 * /api/weather-almanac: the weather report's almanac, from the weather station's minute
 * rows in Supabase (server/supabase-public.ts, atmosphere/sql/atmosphere_almanac.sql).
 *
 *   GET /api/weather-almanac?tz=America/New_York
 *   ->  { tz, today?, normal?, newApps?, heatmap?, records? }
 *
 *   today    today so far, from midnight in `tz`: totals, and the busiest and quietest
 *            whole minute by new records a second, every app (atmosphere_today's
 *            recordsHigh / recordsLow)
 *   normal   the last hour against the same hour on the days before and on the same
 *            weekday in the weeks before (atmosphere_normal); the page words it. With
 *            it, when they can be read, the diversity index of the last whole hour and
 *            of the same hour on those days and weeks (readDiversity)
 *   newApps  apps outside Bluesky heard in the last 24 hours that the station had never
 *            heard before (atmosphere_new_apps). Until the station has listened for
 *            WARMUP_MS, every app is new to it, so it says it's warming up instead
 *   heatmap  every hour of the week in `tz` over the last HEATMAP_MS (atmosphere_heatmap)
 *   records  the busiest whole minute the station has heard, by new records a second, and
 *            the minute it heard the most apps outside Bluesky (readRecords). Only since
 *            it listened live (LIVE_SINCE): the archive's backfill has minutes of a replay's
 *            pile-up in it, tens of thousands a second, that no one ever saw
 *
 * Each part is asked for at once and left out if it fails; only all of them failing is a
 * 503. `tz` is an IANA zone name (the page sends the reader's own); anything else is a 400.
 * Cached at the CDN for a minute per zone.
 */

import { diversityOf } from './atmosphere.js';
import { collectionsOf, counts, DOMAIN_RE, isCount, isRecord, iso, json, methodNotAllowed, num, supabase, type Env, type Fetch, type Supabase } from './supabase-public.js';
import { getAll } from './weather-accounts.js';

export const CACHE = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How many days back atmosphere_normal looks for "usual": each of the 6 days before, and the same weekday in each of the 8 weeks before. */
export const USUAL_DAYS = [1, 2, 3, 4, 5, 6] as const;
export const USUAL_WEEKS = [7, 14, 21, 28, 35, 42, 49, 56] as const;
/**
 * The station has listened live since this. Everything before came from Jetstream's
 * archive (atmosphere/README.md), which keeps about a fifth of the edits the station hears
 * (0.5 a second against 2.7), and other apps lean on edits, so it hears fewer accounts
 * outside Bluesky: 0.29% of an hour's active accounts on average, against the station's
 * 0.48%. Its hours' diversity index isn't comparable, so "usual" leaves them out.
 */
export const LIVE_SINCE = Date.parse('2026-10-20T16:50:00Z');
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
  diversity?: NormalDiversity;
}

/**
 * The diversity index by the hour: the last whole one, and on average the same hour on
 * the days and weeks atmosphere_normal looks at, wherever the station heard at least half
 * of it and still has each app's accounts (it keeps those by the hour for 30 days).
 */
export interface NormalDiversity {
  /** The start of the hour. */
  hour: string;
  now: { index: number; share: number; spread: number; elsewhere: number };
  days: { windows: number; index: number };
  weeks: { windows: number; index: number };
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

export interface Records {
  /** Records count from here (LIVE_SINCE). */
  since: string;
  busiest: Extreme | null;
  mostApps: { minute: string; apps: number } | null;
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

/**
 * The diversity index of the last whole hour and of the same hour on the days and weeks
 * before, from the station's hourly account counts (atmosphere_account_sketch and
 * _app_sketch, their `dids`: no sketch needs merging). Clock hours, not the last 60
 * minutes, since that's how the station keeps accounts. Each earlier hour's index on its
 * own, then their mean: adding the hours' accounts up first would spread them over more
 * apps than any one hour has. Hours from before the station listened live (LIVE_SINCE)
 * are left out. null when the last whole hour wasn't heard well enough.
 */
export async function readDiversity(db: Supabase, at: number): Promise<NormalDiversity | null> {
  const hour = Math.floor(at / HOUR) * HOUR - HOUR;
  const ago = [0, ...USUAL_DAYS, ...USUAL_WEEKS];
  const list = `(${ago.map((k) => new Date(hour - k * DAY).toISOString()).join(',')})`;
  const [main, appRows] = await Promise.all([
    getAll(db, `atmosphere_account_sketch?select=t,seconds,dids,dids_elsewhere&period=eq.hour&t=in.${list}&order=t.asc`),
    getAll(db, `atmosphere_account_app_sketch?select=t,dids&period=eq.hour&t=in.${list}&order=t.asc,domain.asc`),
  ]);
  const apps = new Map<string, number[]>();
  for (const r of appRows) {
    const t = isRecord(r) ? iso(r.t) : null;
    if (!t || !isRecord(r) || !isCount(r.dids)) continue;
    apps.set(t, [...(apps.get(t) ?? []), num(r.dids)]);
  }
  const byHour = new Map<string, NormalDiversity['now']>();
  for (const r of main) {
    const t = isRecord(r) ? iso(r.t) : null;
    const c = counts(r, ['seconds', 'dids', 'dids_elsewhere'] as const);
    // heard live and at least half, and its apps still kept if anyone wrote elsewhere
    if (!t || Date.parse(t) < LIVE_SINCE || !c || c.seconds < 1800 || c.dids <= 0 || (c.dids_elsewhere > 0 && !apps.has(t))) continue;
    byHour.set(t, { ...diversityOf({ active: c.dids, elsewhere: c.dids_elsewhere, apps: apps.get(t) ?? [] }), elsewhere: c.dids_elsewhere });
  }
  const now = byHour.get(new Date(hour).toISOString());
  if (!now) return null;
  const usual = (ks: readonly number[]) => {
    const heard = ks.flatMap((k) => byHour.get(new Date(hour - k * DAY).toISOString()) ?? []);
    return { windows: heard.length, index: heard.length ? Math.round((heard.reduce((sum, h) => sum + h.index, 0) / heard.length) * 100) / 100 : 0 };
  };
  return { hour: new Date(hour).toISOString(), now, days: usual(USUAL_DAYS), weeks: usual(USUAL_WEEKS) };
}

/**
 * The station's records since it listened live: the whole minute with the most new records
 * a second, and the one with the most apps outside Bluesky. Straight off the minute rows
 * (the newest of any tie), no sums needed.
 */
export async function readRecords(db: Supabase): Promise<Records> {
  const since = new Date(LIVE_SINCE).toISOString();
  const path = (select: string, order: string, extra = '') => `atmosphere_minute?select=${select}&minute=gte.${since}${extra}&order=${order},minute.desc&limit=1`;
  const [busy, apps] = await Promise.all([
    db.get(path('minute,creates,seconds_covered', 'creates.desc', '&seconds_covered=eq.60')),
    db.get(path('minute,apps', 'apps.desc')),
  ]);
  const first = (rows: unknown) => (Array.isArray(rows) ? rows[0] : undefined);
  const b = first(busy);
  const bm = isRecord(b) ? iso(b.minute) : null;
  const bc = counts(b, ['creates', 'seconds_covered'] as const);
  const a = first(apps);
  const am = isRecord(a) ? iso(a.minute) : null;
  const ac = counts(a, ['apps'] as const);
  if (!Array.isArray(busy) || !Array.isArray(apps)) throw new Error('records did not check out');
  return {
    since,
    busiest: bm && bc && bc.seconds_covered > 0 ? { minute: bm, perSecond: Math.round((bc.creates / bc.seconds_covered) * 10) / 10 } : null,
    mostApps: am && ac ? { minute: am, apps: ac.apps } : null,
  };
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
    const [today, normal, newApps, heatmap, records] = await Promise.all([
      part('today', async () => toToday(await db.rpc('atmosphere_today', { tz }))),
      part('normal', async () => {
        const diversity = readDiversity(db, at).catch((error) => {
          log({ event: 'almanac_diversity_error', tz, error: (error as Error)?.message ?? 'Error' });
          return null;
        });
        const normal = toNormal(await db.rpc('atmosphere_normal', {}));
        const d = await diversity;
        return normal && d ? { ...normal, diversity: d } : normal;
      }),
      part('new_apps', async () => toNewApps(await db.rpc('atmosphere_new_apps', { since: new Date(at - DAY).toISOString(), max_apps: 50 }), at)),
      part('heatmap', async () => toHeatmap(await db.rpc('atmosphere_heatmap', { tz, since: new Date(at - HEATMAP_MS).toISOString() }))),
      part('records', () => readRecords(db)),
    ]);
    if (!today && !normal && !newApps && !heatmap && !records) return json(request, 503, { error: 'unavailable' }, 'no-store');
    return json(request, 200, { tz, today, normal, newApps, heatmap, records }, CACHE);
  }

  return { GET, HEAD: GET, methodNotAllowed: async (request: Request) => methodNotAllowed(request) };
}

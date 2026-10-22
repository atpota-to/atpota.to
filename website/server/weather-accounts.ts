/**
 * The trends' active accounts: how many different accounts (DIDs) wrote anything over a
 * range, everyone and on each side of Bluesky, bucket by bucket, the diversity index
 * they make (atmosphere.ts diversityOf), and the apps with the most of them. Part of
 * /api/weather-history (weather-history.ts).
 *
 * The weather station counts accounts with HyperLogLog sketches and keeps them by
 * minute, hour, day and month (atmosphere/sql/atmosphere_accounts.sql). A bucket's own
 * count is on its row; a range's is the union of its buckets' sketches, merged here
 * (hll.ts), never a sum: someone active every hour of the day is one account for the day.
 * Everyone is Bluesky merged with elsewhere. A bucket's diversity index spreads its
 * accounts over its apps as the station counted each (the `dids` on its app rows); the
 * range's, over each app's accounts across the whole range.
 *
 * Coverage works as it does for records: `seconds` is how much of the range the station
 * heard while counting accounts, and the page says when that's short. Unlike records,
 * accounts don't scale with time (an hour has far fewer than 60 times a minute's), so
 * the page compares apps' counts, and the diversity index with the earlier window's
 * (`prev`), only when both windows were heard about as well.
 */

import { diversityOf } from './atmosphere.js';
import { countSketch, emptySketch, fromBytea, mergeSketch, type Registers } from './hll.js';
import { collectionsOf, counts, DOMAIN_RE, isCount, iso, isRecord, num, type Supabase } from './supabase-public.js';

export type Period = 'minute' | 'hour' | 'day' | 'month';

export interface AccountCounts {
  active: number;
  bluesky: number;
  elsewhere: number;
}

/** The diversity index the accounts make, with its parts (atmosphere.ts diversityOf). */
export interface Diversity {
  index: number;
  /** Percent of the accounts that wrote outside Bluesky. */
  share: number;
  /** How many apps those are spread across, as an effective number. */
  spread: number;
}

export interface AccountPoint extends AccountCounts, Diversity {
  t: string;
  seconds: number;
}

export interface AccountApp {
  domain: string;
  active: number;
  /** Its accounts in the earlier window. */
  prevActive: number;
  collections: string[];
}

export interface Accounts {
  seconds: number;
  /** How much of the earlier window the station heard, counting accounts. */
  prevSeconds: number;
  total: AccountCounts & Diversity;
  /** Everyone active in the earlier window, with the seconds its sketches cover, when the station kept them. */
  prev?: AccountCounts & Diversity & { seconds: number };
  points: AccountPoint[];
  apps: AccountApp[];
}

export interface AccountWindow {
  since: string;
  until: string;
  prev_since: string;
  prev_until: string;
  period: Period;
  maxApps: number;
  /** When the station started listening live: an earlier window from before then is the archive's, which hears
   * fewer accounts outside Bluesky, so its diversity index isn't one to compare with (weather-almanac.ts LIVE_SINCE). */
  liveSince?: number;
}

/** Supabase answers at most this many rows at a time. */
export const PAGE_ROWS = 1000;
export const MAX_PAGES = 40;

/** Every row a query answers, a page at a time. */
export async function getAll(db: Supabase, query: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const got = await db.get(`${query}&limit=${PAGE_ROWS}&offset=${page * PAGE_ROWS}`);
    if (!Array.isArray(got)) throw new Error('supabase answered something other than rows');
    rows.push(...got);
    if (got.length < PAGE_ROWS) return rows;
  }
  return rows;
}

const range = (from: string, to: string) => `t=gte.${from}&t=lt.${to}`;

/** Sketch rows merged by domain (names are someone else's text, so they're checked). */
function mergeApps(rows: unknown[]): Map<string, Registers> {
  const apps = new Map<string, Registers>();
  for (const r of rows) {
    if (!isRecord(r) || typeof r.domain !== 'string' || !DOMAIN_RE.test(r.domain)) continue;
    const s = fromBytea(r.sketch);
    if (!s) continue;
    const into = apps.get(r.domain);
    if (into) mergeSketch(into, s);
    else apps.set(r.domain, s);
  }
  return apps;
}

/** The seconds a window's sketch rows cover. */
function coveredSeconds(rows: unknown[]): number {
  return rows.reduce<number>((n, r) => n + (isRecord(r) && Number.isFinite(num(r.seconds)) && num(r.seconds) > 0 ? num(r.seconds) : 0), 0);
}

/** Everyone in a window's sketch rows, the seconds they cover, and the diversity index they make over `apps`. */
function everyoneOf(rows: unknown[], apps: Map<string, Registers>): AccountCounts & Diversity & { seconds: number } {
  const bluesky = emptySketch();
  const elsewhere = emptySketch();
  let seconds = 0;
  for (const r of rows) {
    const b = isRecord(r) ? fromBytea(r.bluesky) : null;
    const e = isRecord(r) ? fromBytea(r.elsewhere) : null;
    const s = isRecord(r) ? num(r.seconds) : NaN;
    if (!b || !e || !Number.isFinite(s) || s < 0) continue;
    mergeSketch(bluesky, b);
    mergeSketch(elsewhere, e);
    seconds += s;
  }
  const everyone = { active: countSketch(mergeSketch(mergeSketch(emptySketch(), bluesky), elsewhere)), bluesky: countSketch(bluesky), elsewhere: countSketch(elsewhere) };
  return { seconds, ...everyone, ...diversityOf({ active: everyone.active, elsewhere: everyone.elsewhere, apps: [...apps.values()].map(countSketch) }) };
}

export async function readAccounts(db: Supabase, w: AccountWindow): Promise<Accounts> {
  const { since, until, prev_since, prev_until, period } = w;
  const [main, appRows] = await Promise.all([
    getAll(db, `atmosphere_account_sketch?select=t,seconds,dids,dids_bluesky,dids_elsewhere,bluesky,elsewhere&period=eq.${period}&${range(since, until)}&order=t.asc`),
    getAll(db, `atmosphere_account_app_sketch?select=t,domain,dids,sketch&period=eq.${period}&${range(since, until)}&order=t.asc,domain.asc`),
  ]);

  // each bucket's apps' accounts, as the station counted them
  const bucketApps = new Map<string, number[]>();
  for (const r of appRows) {
    const t = isRecord(r) ? iso(r.t) : null;
    if (!t || !isRecord(r) || typeof r.domain !== 'string' || !DOMAIN_RE.test(r.domain) || !isCount(r.dids)) continue;
    const apps = bucketApps.get(t);
    if (apps) apps.push(num(r.dids));
    else bucketApps.set(t, [num(r.dids)]);
  }

  const points: AccountPoint[] = [];
  const kept: unknown[] = [];
  let seconds = 0;
  for (const r of main) {
    const t = isRecord(r) ? iso(r.t) : null;
    const c = counts(r, ['seconds', 'dids', 'dids_bluesky', 'dids_elsewhere'] as const);
    if (!t || !c || !isRecord(r) || !fromBytea(r.bluesky) || !fromBytea(r.elsewhere)) continue;
    kept.push(r);
    seconds += c.seconds;
    const diversity = diversityOf({ active: c.dids, elsewhere: c.dids_elsewhere, apps: bucketApps.get(t) ?? [] });
    points.push({ t, seconds: c.seconds, active: c.dids, bluesky: c.dids_bluesky, elsewhere: c.dids_elsewhere, ...diversity });
  }
  const appSketches = mergeApps(appRows);
  const apps = [...appSketches].map(([domain, s]) => ({ domain, active: countSketch(s) }));
  const { seconds: _, ...total } = everyoneOf(kept, appSketches);

  const top = apps
    .sort((a, b) => b.active - a.active || (a.domain < b.domain ? -1 : 1))
    .slice(0, w.maxApps);

  // the earlier window's diversity index spreads its accounts over every app, not only the top ones
  let [prevRows, prevCoverage, prevSketches, collections] = await Promise.all([
    getAll(db, `atmosphere_account_app_sketch?select=domain,sketch&period=eq.${period}&${range(prev_since, prev_until)}&order=t.asc,domain.asc`),
    // minute sketches of everyone may not reach back to the earlier window (they're kept 26 hours), so its coverage
    // comes from the minute rows, and the seconds its sketches cover go with its diversity index
    period === 'minute'
      ? getAll(db, `atmosphere_minute?select=seconds:seconds_covered&minute=gte.${prev_since}&minute=lt.${prev_until}&dids=not.is.null&order=minute.asc`)
      : null,
    getAll(db, `atmosphere_account_sketch?select=seconds,bluesky,elsewhere&period=eq.${period}&${range(prev_since, prev_until)}&order=t.asc`),
    // each app's busiest collections lately, as the records' apps have them
    Promise.all(
      top.map(async (a) => {
        const rows = await db.get(`atmosphere_minute_app?select=collections&domain=eq.${a.domain}&minute=gte.${new Date(Math.max(Date.parse(since), Date.parse(until) - 2 * 86_400_000)).toISOString()}&order=creates.desc,minute.desc&limit=1`);
        return Array.isArray(rows) && isRecord(rows[0]) ? collectionsOf(rows[0].collections) : [];
      }),
    ),
  ]);
  // where the minute sketches don't cover the earlier hour (they began on 2026-10-21, and
  // are kept 26 hours), the hour sketch nearest it stands in: an hour of accounts like
  // the one it's compared with, at most half an hour off
  if (period === 'minute' && coveredSeconds(prevSketches) < 0.9 * (Date.parse(prev_until) - Date.parse(prev_since)) / 1000) {
    const hour = new Date(Math.round(Date.parse(prev_since) / 3_600_000) * 3_600_000).toISOString();
    [prevRows, prevSketches] = await Promise.all([
      getAll(db, `atmosphere_account_app_sketch?select=domain,sketch&period=eq.hour&t=eq.${hour}&order=domain.asc`),
      getAll(db, `atmosphere_account_sketch?select=seconds,bluesky,elsewhere&period=eq.hour&t=eq.${hour}`),
    ]);
  }
  const prev = mergeApps(prevRows);
  const prevTotal = everyoneOf(prevSketches, prev);
  const prevSeconds = (prevCoverage ?? prevSketches).reduce<number>((n, r) => n + (isRecord(r) && Number.isFinite(num(r.seconds)) ? num(r.seconds) : 0), 0);

  return {
    seconds,
    prevSeconds,
    total,
    ...(prevTotal.seconds > 0 && Date.parse(prev_since) >= (w.liveSince ?? -Infinity) ? { prev: prevTotal } : {}),
    points,
    apps: top.map((a, i) => {
      const p = prev.get(a.domain);
      return { ...a, prevActive: p ? countSketch(p) : 0, collections: collections[i] ?? [] };
    }),
  };
}

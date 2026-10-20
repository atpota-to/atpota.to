/**
 * The trends' active accounts: how many different accounts (DIDs) wrote anything over a
 * range, everyone and on each side of the diversity index, bucket by bucket, and the
 * apps with the most of them. Part of /api/weather-history (weather-history.ts).
 *
 * The weather station counts accounts with HyperLogLog sketches and keeps them by
 * minute, hour, day and month (atmosphere/sql/atmosphere_accounts.sql). A bucket's own
 * count is on its row; a range's is the union of its buckets' sketches, merged here
 * (hll.ts), never a sum: someone active every hour of the day is one account for the day.
 * Everyone is Bluesky merged with elsewhere.
 *
 * Coverage works as it does for records: `seconds` is how much of the range the station
 * heard while counting accounts, and the page says when that's short. Unlike records,
 * accounts don't scale with time (an hour has far fewer than 60 times a minute's), so
 * the page compares apps' counts only when both windows were heard about as well.
 */

import { countSketch, emptySketch, fromBytea, mergeSketch, type Registers } from './hll.js';
import { collectionsOf, counts, DOMAIN_RE, iso, isRecord, num, type Supabase } from './supabase-public.js';

export type Period = 'minute' | 'hour' | 'day' | 'month';

export interface AccountCounts {
  active: number;
  bluesky: number;
  elsewhere: number;
}

export interface AccountPoint extends AccountCounts {
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
  total: AccountCounts;
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

export async function readAccounts(db: Supabase, w: AccountWindow): Promise<Accounts> {
  const { since, until, prev_since, prev_until, period } = w;
  const [main, appRows] = await Promise.all([
    getAll(db, `atmosphere_account_sketch?select=t,seconds,dids,dids_bluesky,dids_elsewhere,bluesky,elsewhere&period=eq.${period}&${range(since, until)}&order=t.asc`),
    getAll(db, `atmosphere_account_app_sketch?select=t,domain,sketch&period=eq.${period}&${range(since, until)}&order=t.asc,domain.asc`),
  ]);

  const bluesky = emptySketch();
  const elsewhere = emptySketch();
  const points: AccountPoint[] = [];
  let seconds = 0;
  for (const r of main) {
    const t = isRecord(r) ? iso(r.t) : null;
    const c = counts(r, ['seconds', 'dids', 'dids_bluesky', 'dids_elsewhere'] as const);
    const b = isRecord(r) ? fromBytea(r.bluesky) : null;
    const e = isRecord(r) ? fromBytea(r.elsewhere) : null;
    if (!t || !c || !b || !e) continue;
    mergeSketch(bluesky, b);
    mergeSketch(elsewhere, e);
    seconds += c.seconds;
    points.push({ t, seconds: c.seconds, active: c.dids, bluesky: c.dids_bluesky, elsewhere: c.dids_elsewhere });
  }
  const total = { active: countSketch(mergeSketch(mergeSketch(emptySketch(), bluesky), elsewhere)), bluesky: countSketch(bluesky), elsewhere: countSketch(elsewhere) };

  const top = [...mergeApps(appRows)]
    .map(([domain, s]) => ({ domain, active: countSketch(s) }))
    .sort((a, b) => b.active - a.active || (a.domain < b.domain ? -1 : 1))
    .slice(0, w.maxApps);
  const domains = top.map((a) => a.domain).join(',');

  const [prevRows, prevCoverage, collections] = await Promise.all([
    top.length ? getAll(db, `atmosphere_account_app_sketch?select=domain,sketch&period=eq.${period}&${range(prev_since, prev_until)}&domain=in.(${domains})&order=t.asc,domain.asc`) : [],
    // minute sketches are only kept a couple of hours, so the earlier window's minutes come from the minute rows
    period === 'minute'
      ? getAll(db, `atmosphere_minute?select=seconds:seconds_covered&minute=gte.${prev_since}&minute=lt.${prev_until}&dids=not.is.null&order=minute.asc`)
      : getAll(db, `atmosphere_account_sketch?select=seconds&period=eq.${period}&${range(prev_since, prev_until)}&order=t.asc`),
    // each app's busiest collections lately, as the records' apps have them
    Promise.all(
      top.map(async (a) => {
        const rows = await db.get(`atmosphere_minute_app?select=collections&domain=eq.${a.domain}&minute=gte.${new Date(Math.max(Date.parse(since), Date.parse(until) - 2 * 86_400_000)).toISOString()}&order=creates.desc,minute.desc&limit=1`);
        return Array.isArray(rows) && isRecord(rows[0]) ? collectionsOf(rows[0].collections) : [];
      }),
    ),
  ]);
  const prev = mergeApps(prevRows);
  const prevSeconds = prevCoverage.reduce<number>((n, r) => n + (isRecord(r) && Number.isFinite(num(r.seconds)) ? num(r.seconds) : 0), 0);

  return {
    seconds,
    prevSeconds,
    total,
    points,
    apps: top.map((a, i) => {
      const p = prev.get(a.domain);
      return { ...a, prevActive: p ? countSketch(p) : 0, collections: collections[i] ?? [] };
    }),
  };
}

/**
 * The PDS hosts over a range, for /api/weather-history's `hosts`: the weather station's
 * censuses of the relay's list of hosts (atmosphere/src/hosts.js), kept every 10 minutes
 * in atmosphere_hosts, and each active host's day in atmosphere_host_day
 * (atmosphere/sql/atmosphere_hosts.sql). One read-only function, atmosphere_host_trends,
 * answers all of it:
 *
 *   points    the last census in each minute, hour, day or month of the range, with its
 *             hosting diversity (worked out here from its parts, like the live reading's)
 *   since     the first day the station kept hosts: nothing before it counts as new
 *   newHosts  how many independent hosts were first seen active in the range, and `new`
 *             the ones with the most accounts now
 *   growing   the independent hosts that gained the most accounts over the range, by day
 *   daily     day by day (UTC), over the range but at least a week: active hosts at the
 *             day's last census and the change from the day before, and the independent
 *             hosts that joined and left. Each is null where there's nothing to compare.
 *   identities  day by day over the same days: new accounts by where they signed up,
 *             own-domain handles among them, the ones made in bulk (runs of sign-ups shaped
 *             as no crowd makes them: atmosphere/src/backfill-hosts.js bulkRun), accounts
 *             moving out of Bluesky's hosts, back in and between independent hosts, and
 *             deletions, from the PLC directory's log (atmosphere/src/plc-watch.js; today's
 *             so far)
 *
 * Hostnames are someone else's text, so each is checked again here.
 */

import { diversityIndex, HOSTNAME_RE } from './atmosphere.js';
import { counts, isRecord, iso, num, type Supabase } from './supabase-public.js';

export type HostBucket = 'minute' | 'hour' | 'day' | 'month';

export interface HostPoint {
  t: string;
  active: number;
  bluesky: number;
  independent: number;
  /** Active hosts that relayed anything in the hour before, or null when the station hadn't counted twice yet. */
  writing: number | null;
  accountsBluesky: number;
  accountsIndependent: number;
  share: number;
  spread: number;
  index: number;
  /** One a day from the backfill (atmosphere/src/backfill-hosts.js), not the station's census. */
  estimated?: boolean;
}

export interface HostHistory {
  bucket: HostBucket;
  since: string | null;
  points: HostPoint[];
  newHosts: number;
  new: Array<{ hostname: string; accounts: number; first: string }>;
  growing: Array<{ hostname: string; accounts: number; prevAccounts: number }>;
  daily: HostDay[];
  identities: IdentityDay[];
  /** Each day's active accounts on independent hosts, and everyone's (null before the station counted them). */
  activeDaily: ActiveDay[];
  /** The independent hosts with the most accounts active on the latest day counted (yesterday, usually). */
  liveliest: Liveliest | null;
}

export interface ActiveDay {
  day: string;
  independent: number;
  all: number | null;
}

export interface Liveliest {
  day: string;
  /** Today, still counting: there's no finished day yet. */
  soFar: boolean;
  hosts: Array<{ hostname: string; active: number; accounts: number | null }>;
}

export function toActiveDay(x: unknown): ActiveDay | null {
  if (!isRecord(x) || typeof x.day !== 'string' || !DAY_RE.test(x.day)) return null;
  const c = counts(x, ['independent'] as const);
  if (!c) return null;
  return { day: x.day, independent: c.independent, all: countOrNull(x.all) };
}

export function toLiveliest(x: unknown): Liveliest | null {
  if (!isRecord(x) || typeof x.day !== 'string' || !DAY_RE.test(x.day) || !Array.isArray(x.hosts)) return null;
  return {
    day: x.day,
    soFar: x.soFar === true,
    hosts: x.hosts
      .flatMap((h) => {
        const c = counts(h, ['active'] as const);
        return isRecord(h) && hostname(h.hostname) && c ? [{ hostname: h.hostname, active: c.active, accounts: countOrNull(h.accounts) }] : [];
      })
      .slice(0, TOP_HOSTS),
  };
}

/** A day of the PLC directory's log (atmosphere_plc_day). */
export interface IdentityDay {
  day: string;
  ops: number;
  createdBluesky: number;
  createdIndependent: number;
  /** On hosts the relay doesn't list: test servers, bulk sign-ups nobody relays. */
  createdUnlisted: number;
  /** New accounts on listed hosts with a handle on their own domain. */
  createdCustomHandle: number;
  /**
   * Of createdIndependent, the ones made in bulk: in runs on one host shaped as no crowd of
   * people makes them (the station's bulkRun), less any on hosts in NOT_BULK. Zero on days
   * counted before the station looked.
   */
  createdBulk: number;
  /** The hosts that made them, the most first: how many, in how many runs, over how many seconds in all. */
  bulk: BulkHost[];
  movedOut: number;
  movedIn: number;
  movedBetween: number;
  deleted: number;
  /** Where the day's movers went (out of Bluesky's hosts or between independent ones), busiest first. */
  destinations: Array<{ hostname: string; accounts: number }>;
}

export interface BulkHost {
  hostname: string;
  accounts: number;
  bursts: number;
  seconds: number;
}

const IDENTITY_KEYS = {
  ops: 'ops',
  createdBluesky: 'created_bluesky',
  createdIndependent: 'created_independent',
  createdUnlisted: 'created_unlisted',
  createdCustomHandle: 'created_custom_handle',
  movedOut: 'moved_out',
  movedIn: 'moved_in',
  movedBetween: 'moved_between',
  deleted: 'deleted',
} as const;

/** A row's [{ hostname, accounts }], checked. */
const hostCounts = (x: unknown) =>
  (Array.isArray(x) ? x : [])
    .flatMap((h) => {
      const a = counts(h, ['accounts'] as const);
      return isRecord(h) && hostname(h.hostname) && a ? [{ hostname: h.hostname, accounts: a.accounts }] : [];
    })
    .slice(0, TOP_HOSTS);

/**
 * Hosts never counted as made in bulk, whatever the station finds. Its rules only count runs
 * of sign-ups no crowd of people makes, but one thing can look like them: a server maxed out
 * by a rush for a new app, then falling over, whose last minutes are as steady and as sudden
 * to stop as a script's. A host named here has its sign-ups counted as people again, every day.
 */
export const NOT_BULK: ReadonlySet<string> = new Set<string>([]);

export function toIdentityDay(x: unknown, notBulk: ReadonlySet<string> = NOT_BULK): IdentityDay | null {
  if (!isRecord(x) || typeof x.day !== 'string' || !DAY_RE.test(x.day)) return null;
  const c = counts(x, Object.values(IDENTITY_KEYS));
  if (!c) return null;
  // a row from before the station counted them has neither
  const found = (Array.isArray(x.bulk_hosts) ? x.bulk_hosts : [])
    .flatMap((h) => {
      const b = counts(h, ['accounts', 'bursts', 'seconds'] as const);
      return isRecord(h) && hostname(h.hostname) && b ? [{ hostname: h.hostname, ...b }] : [];
    })
    .slice(0, TOP_HOSTS);
  const bulk = found.filter((h) => !notBulk.has(h.hostname));
  const letOff = found.reduce((t, h) => t + (notBulk.has(h.hostname) ? h.accounts : 0), 0);
  const createdBulk = Math.max(0, Math.min(c.created_independent, (countOrNull(x.created_bulk) ?? 0) - letOff));
  return {
    day: x.day,
    ...(Object.fromEntries(Object.entries(IDENTITY_KEYS).map(([k, col]) => [k, c[col]])) as Omit<IdentityDay, 'day' | 'destinations' | 'createdBulk' | 'bulk'>),
    createdBulk,
    bulk,
    destinations: hostCounts(x.destinations),
  };
}

export interface HostDay {
  /** YYYY-MM-DD, UTC. */
  day: string;
  active: number | null;
  /** Active hosts against the day before; can be negative. */
  change: number | null;
  /** Independent hosts active that day and not the day before, and the other way round. */
  joined: number | null;
  left: number | null;
  /** From the backfill's estimate (atmosphere/src/backfill-hosts.js), not the station's census. */
  estimated: boolean;
}

/** How many hosts each list names. */
export const TOP_HOSTS = 10;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const hostname = (x: unknown): x is string => typeof x === 'string' && HOSTNAME_RE.test(x);

export function toHostPoint(x: unknown): HostPoint | null {
  const t = isRecord(x) ? iso(x.t) : null;
  const c = counts(x, ['active', 'bluesky', 'independent', 'accountsBluesky', 'accountsIndependent', 'share', 'spread'] as const);
  if (!t || !c || !isRecord(x)) return null;
  const writing = x.writing === null || x.writing === undefined ? null : num(x.writing);
  const share = Math.min(c.share, 100);
  return { t, ...c, share, writing: writing !== null && Number.isFinite(writing) && writing >= 0 ? writing : null, index: diversityIndex(share, c.spread), ...(x.estimated === true ? { estimated: true } : {}) };
}

const countOrNull = (x: unknown): number | null => {
  const v = x === null || x === undefined ? NaN : num(x);
  return Number.isFinite(v) && v >= 0 ? v : null;
};

export function toHostDay(x: unknown): HostDay | null {
  if (!isRecord(x) || typeof x.day !== 'string' || !DAY_RE.test(x.day)) return null;
  const change = x.change === null || x.change === undefined ? NaN : num(x.change);
  return { day: x.day, active: countOrNull(x.active), change: Number.isFinite(change) ? change : null, joined: countOrNull(x.joined), left: countOrNull(x.left), estimated: x.estimated === true };
}

/** atmosphere_host_trends's answer, checked, or null if its shape is off. */
export function toHostHistory(body: unknown, bucket: HostBucket): HostHistory | null {
  if (!isRecord(body) || !Array.isArray(body.points) || !Array.isArray(body.new) || !Array.isArray(body.growing)) return null;
  const newHosts = num(body.newHosts);
  return {
    bucket,
    since: typeof body.since === 'string' && DAY_RE.test(body.since) ? body.since : null,
    points: body.points.map(toHostPoint).filter((p): p is HostPoint => p !== null),
    newHosts: Number.isFinite(newHosts) && newHosts >= 0 ? newHosts : 0,
    new: body.new
      .flatMap((h) => {
        const c = counts(h, ['accounts'] as const);
        return isRecord(h) && hostname(h.hostname) && c && typeof h.first === 'string' && DAY_RE.test(h.first) ? [{ hostname: h.hostname, accounts: c.accounts, first: h.first }] : [];
      })
      .slice(0, TOP_HOSTS),
    growing: body.growing
      .flatMap((h) => {
        const c = counts(h, ['accounts', 'prevAccounts'] as const);
        return isRecord(h) && hostname(h.hostname) && c ? [{ hostname: h.hostname, accounts: c.accounts, prevAccounts: c.prevAccounts }] : [];
      })
      .slice(0, TOP_HOSTS),
    daily: (Array.isArray(body.daily) ? body.daily : []).map(toHostDay).filter((d): d is HostDay => d !== null),
    identities: (Array.isArray(body.identities) ? body.identities : []).map((d) => toIdentityDay(d)).filter((d): d is IdentityDay => d !== null),
    activeDaily: (Array.isArray(body.activeDaily) ? body.activeDaily : []).map(toActiveDay).filter((d): d is ActiveDay => d !== null),
    liveliest: toLiveliest(body.liveliest),
  };
}

export async function readHosts(db: Supabase, since: string, bucket: HostBucket): Promise<HostHistory> {
  const body = await db.rpc('atmosphere_host_trends', { since, bucket, max_hosts: TOP_HOSTS });
  const hosts = toHostHistory(body, bucket);
  if (!hosts) throw new Error('hosts did not check out');
  return hosts;
}

/** One host's days, oldest first (atmosphere_host_day), for /api/weather-history?host=. */
export interface OneHost {
  hostname: string;
  bluesky: boolean;
  /** `active`: the accounts that wrote anything that day (atmosphere_host_active_day), when the station counted them. */
  days: Array<{ day: string; accounts: number; estimated: boolean; active?: number }>;
}

/** How many days a host's history reaches back. */
export const HOST_DAYS_MAX = 400;

/** A hostname as asked for, lower-cased, or null if it isn't one. */
export function askedHost(x: string | null): string | null {
  const h = x?.trim().toLowerCase() ?? '';
  return hostname(h) ? h : null;
}

/** A host's days from atmosphere_host_day, checked; no days if the station never kept it. */
export async function readHost(db: Supabase, host: string): Promise<OneHost> {
  const [rows, active] = await Promise.all([
    db.get(`atmosphere_host_day?hostname=eq.${encodeURIComponent(host)}&select=day,accounts,estimated,bluesky&order=day.desc&limit=${HOST_DAYS_MAX}`),
    // who was active each day: an extra, so the days still come without it
    db.get(`atmosphere_host_active_day?hostname=eq.${encodeURIComponent(host)}&select=day,dids&order=day.desc&limit=${HOST_DAYS_MAX}`).catch(() => []),
  ]);
  if (!Array.isArray(rows)) throw new Error('host days did not check out');
  const activeOn = new Map(
    (Array.isArray(active) ? active : []).flatMap((r) => {
      const c = counts(r, ['dids'] as const);
      return isRecord(r) && typeof r.day === 'string' && DAY_RE.test(r.day) && c ? [[r.day, c.dids] as const] : [];
    }),
  );
  const days = rows
    .flatMap((r) => {
      const c = counts(r, ['accounts'] as const);
      return isRecord(r) && typeof r.day === 'string' && DAY_RE.test(r.day) && c ? [{ day: r.day, accounts: c.accounts, estimated: r.estimated === true, bluesky: r.bluesky === true }] : [];
    })
    .reverse();
  return {
    hostname: host,
    bluesky: days.some((d) => d.bluesky),
    days: days.map(({ day, accounts, estimated }) => ({ day, accounts, estimated, ...(activeOn.has(day) ? { active: activeOn.get(day)! } : {}) })),
  };
}

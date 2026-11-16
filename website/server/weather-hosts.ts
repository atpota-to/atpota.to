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
 *   newHosts  how many independent hosts were first seen active in the range and are new,
 *             not just newly seen (small when first seen, or at least half their accounts
 *             arrived in the range), and `new` the ones the most people arrived on
 *   growing   the independent hosts the most people arrived on over the range, by day:
 *             signed up (not in bulk) or moved in, from the PLC directory's log
 *             (atmosphere_host_arrival_day). Not the relay's count of their accounts, which
 *             goes up for accounts made in bulk and for identities nobody signs in to (a git
 *             server's repositories) as much as for people
 *   daily     day by day (UTC), over the range but at least a week: active hosts at the
 *             day's last census and the change from the day before, and the independent
 *             hosts that joined and left. Each is null where there's nothing to compare.
 *   identities  day by day over the same days: new accounts by where they signed up,
 *             own-domain handles among them, the ones made in bulk (runs of sign-ups shaped
 *             as no crowd makes them: atmosphere/src/backfill-hosts.js bulkRun) and the
 *             identities with no handle, accounts
 *             moving out of Bluesky's hosts, back in and between independent hosts, and
 *             deletions, from the PLC directory's log (atmosphere/src/plc-watch.js; today's
 *             so far)
 *
 * And, read straight from its table (atmosphere_host_move_day), which host each mover left
 * for which: each identity day's `moves`, and one host's own (readHost), so "how many of
 * today's movers came from pds.tophhie.cloud?" has an answer. Bluesky's own hosts are one
 * place there, BLUESKY.
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
  /** `accounts`: the relay's count now; `people`: who signed up (not in bulk) or moved in over the range. */
  new: Array<{ hostname: string; accounts: number; people: number; first: string }>;
  /** The same, and `prevAccounts`, the relay's count on the host's first day in the range. */
  growing: Array<{ hostname: string; accounts: number; prevAccounts: number; people: number }>;
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
  /**
   * Of createdIndependent, the identities with no handle: nobody signs in to one (a git
   * server's repositories, on knot1.tangled.sh). Zero on days counted before the station looked.
   */
  createdUnnamed: number;
  /**
   * Of the rest of createdIndependent (not bulk, not unnamed), the ones a script made by the
   * trends' rules (atmosphere_host_trends): on a host caught making accounts in bulk in the
   * last 30 days, or on a day of 100 or more after which the host signed nobody up for 3 days.
   * Zero from a function from before them.
   */
  createdScripted: number;
  /** The hosts that made them, the most first, and why: 'bulk' or 'stopped'. */
  scripted: ScriptedHost[];
  movedOut: number;
  movedIn: number;
  movedBetween: number;
  deleted: number;
  /** Where the day's movers went (out of Bluesky's hosts or between independent ones), busiest first. */
  destinations: Array<{ hostname: string; accounts: number }>;
  /**
   * Which host the day's movers left for which, the most first, up to TOP_MOVES pairs. They add up
   * to movedOut + movedIn + movedBetween when all of them fit. Empty on a day with moves means the
   * pairs aren't known (a day from before the station kept them, or they couldn't be read), not
   * that nobody moved.
   */
  moves: Move[];
}

/** Bluesky's own hosts, as one place, where a move names the host it left or went to (atmosphere/src/backfill-hosts.js BLUESKY). */
export const BLUESKY = 'bluesky';

/** Accounts that left one host for another on a day. Each is an independent host's name, or BLUESKY. */
export interface Move {
  from: string;
  to: string;
  accounts: number;
}

/** How many pairs a day names. A day has about 15 (13 on 2026-11-09). */
export const TOP_MOVES = 25;
/** Supabase answers at most this many rows at a time. */
export const MOVE_ROWS = 1000;
/** At most this many pages of moves for a range: a year of them is about 5. */
export const MOVE_PAGES = 5;

export interface ScriptedHost {
  hostname: string;
  accounts: number;
  why: 'bulk' | 'stopped';
}

/** New accounts on independent hosts that people made: less the bulk ones, the unnamed ones and the scripted ones. */
export const peopleIndependentOf = (d: IdentityDay): number => Math.max(0, d.createdIndependent - d.createdBulk - d.createdUnnamed - d.createdScripted);

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
 * to stop as a script's. A host named here has its sign-ups counted as people again, every day
 * (in the sign-ups; the trends' lists of hosts are worked out in SQL and don't know it).
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
  // never more than what's left of the day's independent sign-ups (bulk accounts all have a handle)
  const createdUnnamed = Math.min(c.created_independent - createdBulk, countOrNull(x.created_unnamed) ?? 0);
  const allScripted = (Array.isArray(x.scripted_hosts) ? x.scripted_hosts : [])
    .flatMap((h) => {
      const a = counts(h, ['accounts'] as const);
      return isRecord(h) && hostname(h.hostname) && a && (h.why === 'bulk' || h.why === 'stopped') ? [{ hostname: h.hostname, accounts: a.accounts, why: h.why as ScriptedHost['why'] }] : [];
    })
    .slice(0, TOP_HOSTS);
  const scripted = allScripted.filter((h) => !notBulk.has(h.hostname));
  const scriptedOff = allScripted.reduce((t, h) => t + (notBulk.has(h.hostname) ? h.accounts : 0), 0);
  return {
    day: x.day,
    ...(Object.fromEntries(Object.entries(IDENTITY_KEYS).map(([k, col]) => [k, c[col]])) as Omit<IdentityDay, 'day' | 'destinations' | 'moves' | 'createdBulk' | 'bulk' | 'createdUnnamed' | 'createdScripted' | 'scripted'>),
    createdBulk,
    bulk,
    createdUnnamed,
    createdScripted: Math.max(0, Math.min(c.created_independent - createdBulk - createdUnnamed, (countOrNull(x.created_scripted) ?? 0) - scriptedOff)),
    scripted,
    destinations: hostCounts(x.destinations),
    moves: [],
  };
}

/** A place a move names: an independent host's name, or BLUESKY. */
const place = (x: unknown): x is string => x === BLUESKY || hostname(x);

/** An atmosphere_host_move_day row as a Move, or null if it doesn't check out. */
export function toMove(row: unknown): (Move & { day: string }) | null {
  if (!isRecord(row) || typeof row.day !== 'string' || !DAY_RE.test(row.day) || !place(row.from_host) || !place(row.to_host) || row.from_host === row.to_host) return null;
  const c = counts(row, ['accounts'] as const);
  return c && c.accounts > 0 ? { day: row.day, from: row.from_host, to: row.to_host, accounts: c.accounts } : null;
}

/**
 * A day's pairs as it names them: the most first, and of two the same size, one that left an
 * independent host before one that left Bluesky's. So when a day has more than TOP_MOVES, the
 * ones cut are single accounts leaving Bluesky's hosts, which `destinations` has anyway, and
 * not the few that say which independent host is losing people.
 */
export function topMoves(moves: Move[]): Move[] {
  const fromBluesky = (m: Move) => (m.from === BLUESKY ? 1 : 0);
  const name = (m: Move) => `${m.from} ${m.to}`;
  return [...moves].sort((a, b) => b.accounts - a.accounts || fromBluesky(a) - fromBluesky(b) || (name(a) < name(b) ? -1 : 1)).slice(0, TOP_MOVES);
}

/**
 * Each day's moves from `since` (a UTC day) on, by day: the most first, up to TOP_MOVES a day
 * (topMoves). Read newest first, a page at a time. If MOVE_PAGES of them don't reach `since`,
 * the oldest day read may be cut short, so it's left out with the ones before it: not known,
 * not none.
 */
export async function readMoves(db: Supabase, since: string): Promise<Map<string, Move[]>> {
  const by = new Map<string, Move[]>();
  let oldest: string | null = null;
  const cut = () => new Map([...by].map(([day, moves]) => [day, topMoves(moves)]));
  for (let page = 0; page < MOVE_PAGES; page++) {
    const rows = await db.get(
      `atmosphere_host_move_day?select=day,from_host,to_host,accounts&day=gte.${since}&order=day.desc,accounts.desc,from_host.asc,to_host.asc&limit=${MOVE_ROWS}&offset=${page * MOVE_ROWS}`,
    );
    if (!Array.isArray(rows)) throw new Error('moves did not check out');
    for (const r of rows) {
      const m = toMove(r);
      if (!m) continue;
      oldest = m.day;
      const list = by.get(m.day) ?? [];
      list.push({ from: m.from, to: m.to, accounts: m.accounts });
      by.set(m.day, list);
    }
    if (rows.length < MOVE_ROWS) return cut();
  }
  if (oldest) by.delete(oldest);
  return cut();
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
        const c = counts(h, ['accounts', 'people'] as const);
        return isRecord(h) && hostname(h.hostname) && c && typeof h.first === 'string' && DAY_RE.test(h.first) ? [{ hostname: h.hostname, accounts: c.accounts, people: c.people, first: h.first }] : [];
      })
      .slice(0, TOP_HOSTS),
    growing: body.growing
      .flatMap((h) => {
        const c = counts(h, ['accounts', 'prevAccounts', 'people'] as const);
        return isRecord(h) && hostname(h.hostname) && c ? [{ hostname: h.hostname, accounts: c.accounts, prevAccounts: c.prevAccounts, people: c.people }] : [];
      })
      .slice(0, TOP_HOSTS),
    daily: (Array.isArray(body.daily) ? body.daily : []).map(toHostDay).filter((d): d is HostDay => d !== null),
    identities: (Array.isArray(body.identities) ? body.identities : []).map((d) => toIdentityDay(d)).filter((d): d is IdentityDay => d !== null),
    activeDaily: (Array.isArray(body.activeDaily) ? body.activeDaily : []).map(toActiveDay).filter((d): d is ActiveDay => d !== null),
    liveliest: toLiveliest(body.liveliest),
  };
}

const DAY_MS = 86_400_000;

/**
 * The first day atmosphere_host_trends gives identities for: the day `since` falls on, or six
 * days before `now` if that's earlier (a week of days at least), in UTC.
 */
export const identitiesSince = (since: string, now: number): string => new Date(Math.min(Date.parse(since), now - 6 * DAY_MS)).toISOString().slice(0, 10);

export async function readHosts(db: Supabase, since: string, bucket: HostBucket, now = Date.now()): Promise<HostHistory> {
  const [body, moves] = await Promise.all([
    db.rpc('atmosphere_host_trends', { since, bucket, max_hosts: TOP_HOSTS }),
    // which host each mover left for which: an extra, so the hosts still come without it
    readMoves(db, identitiesSince(since, now)).catch(() => null),
  ]);
  const hosts = toHostHistory(body, bucket);
  if (!hosts) throw new Error('hosts did not check out');
  if (moves) for (const d of hosts.identities) d.moves = moves.get(d.day) ?? [];
  return hosts;
}

/** One host's days, oldest first (atmosphere_host_day), for /api/weather-history?host=. */
export interface OneHost {
  hostname: string;
  bluesky: boolean;
  /** `active`: the accounts that wrote anything that day (atmosphere_host_active_day), when the station counted them. */
  days: Array<{ day: string; accounts: number; estimated: boolean; active?: number }>;
  /**
   * Accounts that moved to this host and away from it, by the day and by the other host
   * (atmosphere_host_move_day), oldest first: only the days anyone did, and only from when the
   * station kept them. None for one of Bluesky's own hosts: they're one place there, BLUESKY.
   */
  moves: HostMoveDay[];
  /**
   * The first day the station has anyone's moves for, any host's: from then on, a day this host
   * isn't in `moves` is a day nobody moved to it or away. Before it, nobody knows. Left out when
   * the station has none yet.
   */
  movesSince?: string;
  /**
   * When the station has never kept this hostname: hosts it has that share its name (asked for
   * tophhie.social, it has pds.tophhie.cloud). A service's website often isn't its PDS.
   */
  similar?: string[];
}

export interface HostMoveDay {
  day: string;
  /** Who moved in, by the host they left (BLUESKY for any of Bluesky's own), the most first. */
  arrived: Array<{ from: string; accounts: number }>;
  /** Who moved away, by the host they went to, the most first. */
  left: Array<{ to: string; accounts: number }>;
}

/** How many days a host's history reaches back. */
export const HOST_DAYS_MAX = 400;
/** How many hosts with a name like the one asked for are suggested. */
export const SIMILAR_HOSTS = 5;
/** A label short enough to be in half the hostnames there are ("pds", "co") suggests nothing. */
const SIMILAR_LABEL_MIN = 4;

/** A hostname as asked for, lower-cased, or null if it isn't one. */
export function askedHost(x: string | null): string | null {
  const h = x?.trim().toLowerCase() ?? '';
  return hostname(h) ? h : null;
}

/**
 * One side of a host's moves, newest first as read: [{ day, host, accounts }], `column` being the
 * other host's. A read that came back full may have cut its oldest day short, so that day is
 * left off, and `since` says which days are whole.
 */
function sideOf(rows: unknown, column: 'from_host' | 'to_host'): { rows: Array<{ day: string; host: string; accounts: number }>; since: string | null } {
  const list = (Array.isArray(rows) ? rows : []).flatMap((r) => {
    const c = counts(r, ['accounts'] as const);
    return isRecord(r) && typeof r.day === 'string' && DAY_RE.test(r.day) && place(r[column]) && c && c.accounts > 0 ? [{ day: r.day, host: r[column] as string, accounts: c.accounts }] : [];
  });
  if (!Array.isArray(rows) || rows.length < MOVE_ROWS || !list.length) return { rows: list, since: null };
  const cut = list[list.length - 1]!.day;
  return { rows: list.filter((r) => r.day > cut), since: cut };
}

/** A host's moves as days, oldest first, from its two sides (who came, who went). */
export function toHostMoves(arrived: unknown, left: unknown): HostMoveDay[] {
  const a = sideOf(arrived, 'from_host');
  const l = sideOf(left, 'to_host');
  // whole days only: from after the later of the two cuts
  const since = [a.since, l.since].reduce<string | null>((x, y) => (y !== null && (x === null || y > x) ? y : x), null);
  const days = new Map<string, HostMoveDay>();
  const dayOf = (day: string) => {
    let d = days.get(day);
    if (!d) days.set(day, (d = { day, arrived: [], left: [] }));
    return d;
  };
  for (const r of a.rows) if (since === null || r.day > since) dayOf(r.day).arrived.push({ from: r.host, accounts: r.accounts });
  for (const r of l.rows) if (since === null || r.day > since) dayOf(r.day).left.push({ to: r.host, accounts: r.accounts });
  return [...days.values()].sort((x, y) => (x.day < y.day ? -1 : 1));
}

/**
 * Hosts the station has kept in the last week whose names hold the asked one's own name, the
 * label before its top-level domain ("tophhie" of tophhie.social), biggest first.
 */
export async function similarHosts(db: Supabase, host: string, now: number): Promise<string[]> {
  const label = host.split('.').at(-2) ?? '';
  if (label.length < SIMILAR_LABEL_MIN) return [];
  const since = new Date(now - 7 * DAY_MS).toISOString().slice(0, 10);
  const rows = await db.get(`atmosphere_host_day?hostname=ilike.*${encodeURIComponent(label)}*&day=gte.${since}&select=hostname,accounts&order=day.desc,accounts.desc&limit=50`);
  const names = (Array.isArray(rows) ? rows : []).flatMap((r) => (isRecord(r) && hostname(r.hostname) && r.hostname !== host ? [r.hostname] : []));
  return [...new Set(names)].slice(0, SIMILAR_HOSTS);
}

/** A host's days from atmosphere_host_day, checked; no days if the station never kept it. */
export async function readHost(db: Supabase, host: string, now = Date.now()): Promise<OneHost> {
  const name = encodeURIComponent(host);
  const [rows, active, arrived, left, first] = await Promise.all([
    db.get(`atmosphere_host_day?hostname=eq.${name}&select=day,accounts,estimated,bluesky&order=day.desc&limit=${HOST_DAYS_MAX}`),
    // who was active each day: an extra, so the days still come without it
    db.get(`atmosphere_host_active_day?hostname=eq.${name}&select=day,dids&order=day.desc&limit=${HOST_DAYS_MAX}`).catch(() => []),
    // who moved in and who moved away, by the other host: extras too
    db.get(`atmosphere_host_move_day?to_host=eq.${name}&select=day,from_host,accounts&order=day.desc,accounts.desc,from_host.asc&limit=${MOVE_ROWS}`).catch(() => []),
    db.get(`atmosphere_host_move_day?from_host=eq.${name}&select=day,to_host,accounts&order=day.desc,accounts.desc,to_host.asc&limit=${MOVE_ROWS}`).catch(() => []),
    // and the first day the station kept anyone's: what "no moves" means depends on it
    db.get('atmosphere_host_move_day?select=day&order=day.asc&limit=1').catch(() => []),
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
  // a name the station never kept is often a service's website, not its PDS: say which hosts it could be
  const similar = days.length ? [] : await similarHosts(db, host, now).catch(() => []);
  const firstRow: unknown = Array.isArray(first) ? first[0] : null;
  const movesSince = isRecord(firstRow) && typeof firstRow.day === 'string' && DAY_RE.test(firstRow.day) ? firstRow.day : null;
  return {
    hostname: host,
    bluesky: days.some((d) => d.bluesky),
    days: days.map(({ day, accounts, estimated }) => ({ day, accounts, estimated, ...(activeOn.has(day) ? { active: activeOn.get(day)! } : {}) })),
    moves: toHostMoves(arrived, left),
    ...(movesSince ? { movesSince } : {}),
    ...(similar.length ? { similar } : {}),
  };
}

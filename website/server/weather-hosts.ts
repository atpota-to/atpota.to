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
}

export interface HostHistory {
  bucket: HostBucket;
  since: string | null;
  points: HostPoint[];
  newHosts: number;
  new: Array<{ hostname: string; accounts: number; first: string }>;
  growing: Array<{ hostname: string; accounts: number; prevAccounts: number }>;
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
  return { t, ...c, share, writing: writing !== null && Number.isFinite(writing) && writing >= 0 ? writing : null, index: diversityIndex(share, c.spread) };
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
  };
}

export async function readHosts(db: Supabase, since: string, bucket: HostBucket): Promise<HostHistory> {
  const body = await db.rpc('atmosphere_host_trends', { since, bucket, max_hosts: TOP_HOSTS });
  const hosts = toHostHistory(body, bucket);
  if (!hosts) throw new Error('hosts did not check out');
  return hosts;
}

/**
 * Where accounts live, over time: the bottom of the hosts tile (weather/index.html
 * [data-h-trends]). The weather station counts the PDS hosts every 10 minutes and keeps
 * each census (atmosphere/sql/atmosphere_hosts.sql); /api/weather-history answers them as
 * `hosts` (server/weather-hosts.ts) with the rest of a range's history, so this shares the
 * page's history feed. It draws two charts, active hosts and the hosting diversity, and
 * lists the independent hosts new in the range and the ones that grew most.
 *
 * It follows the lens's window, except that "now" and the last hour show the last 24
 * hours: a census every 10 minutes makes an hour only six points, and hosts don't change
 * minute to minute. Until the station has kept a census or two, the part stays hidden.
 *
 * Hostnames are someone else's text: the server has checked them, this checks them again,
 * and they only reach the DOM through textContent (renderBars).
 */

import { renderChart, type ChartPoint } from './weather-chart';
import { WINDOW_INFO, type Lens, type Window } from './weather-lens';
import { compactCount, formatCount, formatIndex } from './weather';
import type { Bar } from './weather-page';

export type HostRange = 'day' | 'week' | 'month';
export type HostBucket = 'minute' | 'hour' | 'day' | 'month';

export interface HostPoint {
  t: string;
  active: number;
  bluesky: number;
  independent: number;
  writing: number | null;
  accountsBluesky: number;
  accountsIndependent: number;
  share: number;
  spread: number;
  index: number;
}

export interface HostHistory {
  bucket: HostBucket;
  /** The first day the station kept hosts (YYYY-MM-DD). */
  since: string | null;
  points: HostPoint[];
  newHosts: number;
  new: Array<{ hostname: string; accounts: number; first: string }>;
  growing: Array<{ hostname: string; accounts: number; prevAccounts: number }>;
}

/** The parts of a history this needs (weather-page.ts History). */
export interface WithHosts {
  hosts?: HostHistory;
}

/** What the page's history feed hands over (weather-page.ts createHistoryFeed). */
export interface HostFeed {
  get(range: HostRange, maxAgeMs?: number): Promise<WithHosts | null>;
}

/** The range the hosts part shows for a window. */
export const hostRange = (window: Window): HostRange => (window === 'now' || window === 'hour' ? 'day' : window);

/** How many rows each list shows. */
export const HOST_LIST_TOP = 5;

const BUCKET_MS: Record<HostBucket, number> = { minute: 60_000, hour: 3600_000, day: 86_400_000, month: 32 * 86_400_000 };
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const n = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const obj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const hostname = (x: unknown): x is string => typeof x === 'string' && HOSTNAME_RE.test(x);

/** A history answer's `hosts`, checked field by field, or null. */
export function toHostHistory(x: unknown): HostHistory | null {
  if (!obj(x) || typeof x.bucket !== 'string' || !Object.hasOwn(BUCKET_MS, x.bucket) || !Array.isArray(x.points) || !Array.isArray(x.new) || !Array.isArray(x.growing)) return null;
  const keys = ['active', 'bluesky', 'independent', 'accountsBluesky', 'accountsIndependent', 'share', 'spread', 'index'] as const;
  return {
    bucket: x.bucket as HostBucket,
    since: typeof x.since === 'string' && DAY_RE.test(x.since) ? x.since : null,
    points: x.points.filter((p): p is HostPoint => obj(p) && typeof p.t === 'string' && Number.isFinite(Date.parse(p.t)) && keys.every((k) => n(p[k])) && (p.writing === null || n(p.writing))),
    newHosts: n(x.newHosts) ? x.newHosts : 0,
    new: x.new.filter((h): h is HostHistory['new'][number] => obj(h) && hostname(h.hostname) && n(h.accounts) && typeof h.first === 'string' && DAY_RE.test(h.first)).slice(0, 10),
    growing: x.growing.filter((h): h is HostHistory['growing'][number] => obj(h) && hostname(h.hostname) && n(h.accounts) && n(h.prevAccounts)).slice(0, 10),
  };
}

const $ = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T>(sel);

function setText(root: ParentNode, sel: string, text: string): void {
  const el = $(root, sel);
  if (el) el.textContent = text;
}

/** "3 new independent hosts in the last 7 days", or why there's nothing to say yet. */
export function newHostsWords(h: HostHistory, range: HostRange): string {
  const words = WINDOW_INFO[range].words;
  if (h.newHosts === 0) return `no new independent hosts in ${words}.`;
  return `${formatCount(h.newHosts)} new independent host${h.newHosts === 1 ? '' : 's'} in ${words}${h.newHosts > HOST_LIST_TOP ? `, the ${HOST_LIST_TOP} with the most accounts` : ''}.`;
}

/** The hosts' bars: their accounts, or what they gained ("+134"). */
export function hostBars(list: HostHistory['new'] | HostHistory['growing'], gained: boolean): Bar[] {
  return list.slice(0, HOST_LIST_TOP).map((h) => {
    const v = gained && 'prevAccounts' in h ? h.accounts - h.prevAccounts : h.accounts;
    return { label: h.hostname, perSecond: v, count: v, value: gained ? `+${compactCount(v)}` : compactCount(v) };
  });
}

/**
 * The hosts tile's charts and lists for a range. `drawBars` is the page's renderBars,
 * handed in so this module needn't import the page that imports it.
 */
export function renderHostTrends(part: HTMLElement, h: HostHistory | undefined, range: HostRange, drawBars: (list: HTMLElement, bars: Bar[]) => void, now = Date.now()): void {
  if (!h || h.points.length === 0) {
    part.hidden = true;
    return;
  }
  part.hidden = false;
  const words = WINDOW_INFO[range].words;
  setText(part, '[data-h-range]', words);
  const step = BUCKET_MS[h.bucket];
  const fmt = new Intl.DateTimeFormat(undefined, range === 'day' ? { weekday: 'short', hour: 'numeric', minute: '2-digit' } : range === 'week' ? { weekday: 'short', hour: 'numeric' } : { month: 'short', day: 'numeric' });
  const formatTime = (t: number) => fmt.format(new Date(t)).toLowerCase();
  const rows = h.points.map((p) => ({ ...p, t: Date.parse(p.t) }));
  // nothing kept yet at the start of the range: a gap, not a line from nowhere
  const start = now - WINDOW_INFO[range].seconds * 1000;
  const lead: ChartPoint[] = rows.length && rows[0]!.t - start > step ? [{ t: start, v: null }] : [];
  const pts = (v: (r: (typeof rows)[number]) => number): ChartPoint[] => [...lead, ...rows.map((r) => ({ t: r.t, v: v(r) }))];
  const active = $(part, '[data-h-chart="active"]');
  const index = $(part, '[data-h-chart="index"]');
  if (active) renderChart(active, pts((r) => r.active), { label: 'active pds hosts', color: 'var(--weather-bsky)', format: formatCount, formatTick: compactCount, formatTime, stepMs: step });
  if (index) renderChart(index, pts((r) => r.index), { label: 'hosting diversity', color: 'var(--weather-else)', format: formatIndex, formatTick: (v) => String(Number(v.toFixed(2))), formatTime, stepMs: step });

  const fresh = $(part, '[data-h-new]');
  if (fresh) drawBars(fresh, hostBars(h.new, false));
  setText(part, '[data-h-new-note]', newHostsWords(h, range));
  const growing = $(part, '[data-h-growing]');
  if (growing) drawBars(growing, hostBars(h.growing, true));
  setText(part, '[data-h-growing-note]', h.growing.length ? `accounts gained over ${words}, by day.` : `no independent host has gained accounts over ${words} yet.`);
  const since = $(part, '[data-h-since]');
  if (since) {
    // a range that reaches back before the station kept hosts says so
    const from = h.since ? Date.parse(`${h.since}T00:00:00Z`) : NaN;
    since.hidden = !(from > start);
    if (from > start) since.textContent = `i started keeping track of hosts on ${new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(from)).toLowerCase()}, so new hosts count from the day after.`;
  }
}

/** Follows the lens: the range's hosts on load, on a window change, and every 5 minutes while the tab is visible. */
export function initHostTrends(part: HTMLElement, feed: HostFeed, lens: Lens, drawBars: (list: HTMLElement, bars: Bar[]) => void): void {
  let asked = 0;
  const load = async (quietly = false) => {
    const range = hostRange(lens.get().window);
    const mine = ++asked;
    const history = await feed.get(range, quietly ? 295_000 : 30_000);
    if (mine !== asked) return; // the lens moved on
    if (history) renderHostTrends(part, history.hosts, range, drawBars);
    else if (!quietly) part.hidden = true;
  };
  lens.onChange((l, was) => {
    if (hostRange(l.window) !== hostRange(was.window)) void load();
  });
  void load();
  const tick = () =>
    window.setTimeout(async () => {
      if (document.visibilityState !== 'hidden') await load(true);
      tick();
    }, 300_000);
  tick();
}

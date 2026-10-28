/**
 * Where accounts live, over time: the bottom of the hosts tile (weather/index.html
 * [data-h-trends]). The weather station counts the PDS hosts every 10 minutes and keeps
 * each census (atmosphere/sql/atmosphere_hosts.sql); /api/weather-history answers them as
 * `hosts` (server/weather-hosts.ts) with the rest of a range's history, so this shares the
 * page's history feed. It draws three charts (active hosts, the hosting diversity, and
 * independent hosts joining each day), lists the independent hosts new in the range and
 * the ones that grew most, and goes day by day in a table: active hosts, the change from
 * the day before, and the independent hosts that joined and left. A day's change is a
 * handful of hosts on nearly two thousand, which a chart from zero can't show, so the
 * table has it in numbers.
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
import { compactCount, formatCount, formatIndex, renderShare } from './weather';
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
  /** One a day from the backfill, from before the station kept count. */
  estimated?: boolean;
}

export interface HostHistory {
  bucket: HostBucket;
  /** The first day the station kept hosts (YYYY-MM-DD). */
  since: string | null;
  points: HostPoint[];
  newHosts: number;
  new: Array<{ hostname: string; accounts: number; first: string }>;
  growing: Array<{ hostname: string; accounts: number; prevAccounts: number }>;
  /** Day by day (UTC), oldest first (server/weather-hosts.ts HostDay). */
  daily: HostDay[];
  /** The PLC directory's log day by day, oldest first; the last is usually today, so far (server/weather-hosts.ts IdentityDay). */
  identities: IdentityDay[];
  /** Each day's active accounts on independent hosts, and everyone's (server/weather-hosts.ts ActiveDay). */
  activeDaily?: Array<{ day: string; independent: number; all: number | null }>;
  /** The independent hosts with the most accounts active on the latest day counted. */
  liveliest?: { day: string; soFar: boolean; hosts: Array<{ hostname: string; active: number; accounts: number | null }> } | null;
}

export interface IdentityDay {
  day: string;
  ops: number;
  createdBluesky: number;
  createdIndependent: number;
  createdUnlisted: number;
  createdCustomHandle: number;
  /** Of createdIndependent, the ones made in bulk: in runs too fast or too even for people (atmosphere/src/backfill-hosts.js bulkRun). */
  createdBulk: number;
  /** The hosts that made them, the most first: how many, in how many runs, over how many seconds in all. */
  bulk: BulkHost[];
  movedOut: number;
  movedIn: number;
  movedBetween: number;
  deleted: number;
  /** Where the day's movers went, busiest first (server/weather-hosts.ts). */
  destinations: Array<{ hostname: string; accounts: number }>;
}

export interface BulkHost {
  hostname: string;
  accounts: number;
  bursts: number;
  seconds: number;
}

const IDENTITY_COUNTS = ['ops', 'createdBluesky', 'createdIndependent', 'createdUnlisted', 'createdCustomHandle', 'movedOut', 'movedIn', 'movedBetween', 'deleted'] as const;
/** The same, and the bulk ones, which an answer from before they were counted leaves out. */
const IDENTITY_SUMS = [...IDENTITY_COUNTS, 'createdBulk'] as const;

export interface HostDay {
  day: string;
  active: number | null;
  change: number | null;
  joined: number | null;
  left: number | null;
  /** Estimated from the PLC directory's log, from before the station kept hosts. */
  estimated?: boolean;
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
/** How many days the table shows, newest first. */
export const HOST_DAYS_TOP = 14;

const BUCKET_MS: Record<HostBucket, number> = { minute: 60_000, hour: 3600_000, day: 86_400_000, month: 32 * 86_400_000 };
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const n = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const obj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const hostname = (x: unknown): x is string => typeof x === 'string' && HOSTNAME_RE.test(x);
const orNull = (x: unknown): x is number | null => x === null || n(x);
const hostCounts = (x: unknown): Array<{ hostname: string; accounts: number }> => (Array.isArray(x) ? x.filter((h) => obj(h) && hostname(h.hostname) && n(h.accounts)).slice(0, 10) : []);
const bulkHosts = (x: unknown): BulkHost[] => (Array.isArray(x) ? x.filter((h) => obj(h) && hostname(h.hostname) && n(h.accounts) && n(h.bursts) && n(h.seconds)).slice(0, 10) : []);
const isDay = (d: unknown): d is HostDay =>
  obj(d) && typeof d.day === 'string' && DAY_RE.test(d.day) && orNull(d.active) && (d.change === null || (typeof d.change === 'number' && Number.isFinite(d.change))) && orNull(d.joined) && orNull(d.left);

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
    daily: Array.isArray(x.daily) ? x.daily.filter(isDay) : [],
    identities: Array.isArray(x.identities)
      ? x.identities
          .filter((d): d is IdentityDay => obj(d) && typeof d.day === 'string' && DAY_RE.test(d.day) && IDENTITY_COUNTS.every((k) => n(d[k])))
          .map((d) => ({
            ...d,
            createdBulk: n(d.createdBulk) ? Math.min(d.createdBulk, d.createdIndependent) : 0,
            bulk: bulkHosts(d.bulk),
            destinations: hostCounts(d.destinations),
          }))
      : [],
    activeDaily: Array.isArray(x.activeDaily)
      ? x.activeDaily.filter((d): d is NonNullable<HostHistory['activeDaily']>[number] => obj(d) && typeof d.day === 'string' && DAY_RE.test(d.day) && n(d.independent) && orNull(d.all))
      : [],
    liveliest:
      obj(x.liveliest) && typeof x.liveliest.day === 'string' && DAY_RE.test(x.liveliest.day) && Array.isArray(x.liveliest.hosts)
        ? {
            day: x.liveliest.day,
            soFar: x.liveliest.soFar === true,
            hosts: x.liveliest.hosts.filter((h): h is { hostname: string; active: number; accounts: number | null } => obj(h) && hostname(h.hostname) && n(h.active) && orNull(h.accounts)).slice(0, 10),
          }
        : null,
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

/** A share of accounts, to the hundredth: "1.51%". */
const pct = (v: number) => `${v.toFixed(2)}%`;

/**
 * The hosts' headline over a range: "1.51% of accounts live off bluesky's servers, up from
 * 1.46% over the last 7 days: +2,310 accounts on independent hosts."
 */
export function shareHeadline(h: HostHistory, range: HostRange): string {
  const last = h.points[h.points.length - 1];
  if (!last) return '';
  const now = `${pct(last.share)} of accounts live off bluesky's servers`;
  const first = h.points[0]!;
  if (first === last) return `${now}.`;
  const gained = last.accountsIndependent - first.accountsIndependent;
  const way = last.share > first.share ? 'up from' : last.share < first.share ? 'down from' : 'level with';
  return `${now}, ${way} ${pct(first.share)} over ${WINDOW_INFO[range].words}: ${signed(gained)} accounts on independent hosts.`;
}

/** The share of a day's active accounts that wrote from independent hosts, or null without everyone's count. */
export const activeShareOf = (d: { independent: number; all: number | null }): number | null => (d.all && d.all > 0 ? Math.min(100, (d.independent / d.all) * 100) : null);

/**
 * "yesterday, 3.2% of everyone active wrote from an independent host, though only 1.51%
 * of accounts live on one.", from the latest finished day (or today, so far, before there is one).
 */
export function activeShareWords(h: HostHistory, now = Date.now()): string {
  const today = new Date(now).toISOString().slice(0, 10);
  const days = (h.activeDaily ?? []).filter((d) => activeShareOf(d) !== null);
  const d = [...days].reverse().find((x) => x.day < today) ?? days[days.length - 1];
  if (!d) return '';
  const share = activeShareOf(d)!;
  const when = d.day === today ? 'today so far' : d.day === new Date(now - 86_400_000).toISOString().slice(0, 10) ? 'yesterday' : `on ${dayWords(d.day)}`;
  const living = h.points[h.points.length - 1]?.share;
  const versus = living === undefined ? '' : share > living * 1.1 ? `, though only ${pct(living)} of accounts live on one: they're busier than most` : share < living * 0.9 ? `, though ${pct(living)} of accounts live on one: many of them are quiet` : `, about their share of all accounts (${pct(living)})`;
  return `${when}, ${pct(share)} of everyone active wrote from an independent host (${formatCount(d.independent)} accounts)${versus}.`;
}

/** The liveliest hosts' bars: who was active, and what share of the host's accounts that is. */
export function livelyBars(list: NonNullable<HostHistory['liveliest']>['hosts']): Bar[] {
  return list.slice(0, HOST_LIST_TOP).map((h) => ({
    label: h.hostname,
    perSecond: h.active,
    count: h.active,
    value: `${compactCount(h.active)} active`,
    ...(h.accounts ? { sub: `${formatIndex(Math.min(100, (h.active / h.accounts) * 100))}% of its ${compactCount(h.accounts)} accounts` } : {}),
  }));
}

/** Who's active on independent hosts: the share in words and by day, and the liveliest hosts. Each stays hidden without its data. */
function renderActive(part: HTMLElement, h: HostHistory, drawBars: (list: HTMLElement, bars: Bar[]) => void, now: number): void {
  const words = activeShareWords(h, now);
  const line = $(part, '[data-h-active-share]');
  if (line) {
    line.hidden = !words;
    line.textContent = words;
  }
  const days = (h.activeDaily ?? []).filter((d) => activeShareOf(d) !== null);
  const chart = $(part, '[data-h-chart="active-share"]');
  const card = chart?.closest<HTMLElement>('.weather-chart-card');
  if (card) card.hidden = days.length < 2;
  if (chart && days.length >= 2) {
    const dayFmt = (t: number) => DAY_FORMAT.format(new Date(t)).toLowerCase();
    renderChart(chart, days.map((d) => ({ t: Date.parse(`${d.day}T00:00:00Z`), v: activeShareOf(d) })), { label: 'active accounts off bluesky, by day', color: 'var(--weather-else)', format: pct, formatTick: (v) => `${Number(v.toFixed(2))}%`, formatTime: dayFmt, stepMs: 86_400_000, fromZero: false });
  }
  const lively = h.liveliest;
  const wrap = $(part, '[data-h-lively-wrap]');
  if (wrap) wrap.hidden = !lively?.hosts.length;
  if (!lively?.hosts.length) return;
  const today = new Date(now).toISOString().slice(0, 10);
  setText(part, '[data-h-lively-title]', lively.soFar || lively.day === today ? 'liveliest today so far' : lively.day === new Date(now - 86_400_000).toISOString().slice(0, 10) ? 'liveliest yesterday' : `liveliest on ${dayWords(lively.day)}`);
  const list = $(part, '[data-h-lively]');
  if (list) drawBars(list, livelyBars(lively.hosts));
}

/** A day's change as text: "+5", "−2", "0", or a dash with nothing to compare. */
export function signed(v: number | null): string {
  if (v === null) return '–';
  return v > 0 ? `+${formatCount(v)}` : v < 0 ? `−${formatCount(-v)}` : '0';
}

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayWords = (day: string) => DAY_FORMAT.format(new Date(`${day}T00:00:00Z`)).toLowerCase();

/** The day-by-day table: newest first, today marked as so far. */
export function renderHostDays(table: HTMLTableElement, days: HostDay[], now = Date.now()): void {
  const today = new Date(now).toISOString().slice(0, 10);
  const body = table.tBodies[0] ?? table.createTBody();
  const rows = [...days]
    .reverse()
    .slice(0, HOST_DAYS_TOP)
    .map((d) => {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = d.day === today ? `${dayWords(d.day)} (so far)` : d.estimated ? `${dayWords(d.day)} ≈` : dayWords(d.day);
      if (d.estimated) th.title = 'estimated from the plc directory, from before i kept count';
      tr.append(th);
      const cell = (text: string, trend?: 'up' | 'down') => {
        const td = document.createElement('td');
        td.textContent = text;
        if (trend) td.dataset.trend = trend;
        tr.append(td);
      };
      cell(d.active === null ? '–' : formatCount(d.active));
      cell(signed(d.change), d.change === null || d.change === 0 ? undefined : d.change > 0 ? 'up' : 'down');
      cell(d.joined === null ? '–' : d.joined === 0 ? '0' : `+${formatCount(d.joined)}`, d.joined ? 'up' : undefined);
      cell(d.left === null ? '–' : d.left === 0 ? '0' : `−${formatCount(d.left)}`, d.left ? 'down' : undefined);
      return tr;
    });
  body.replaceChildren(...rows);
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
  const pts = (v: (r: (typeof rows)[number]) => number): ChartPoint[] => [...lead, ...rows.map((r) => ({ t: r.t, v: v(r), ...(r.estimated ? { estimated: true } : {}) }))];
  const active = $(part, '[data-h-chart="active"]');
  const index = $(part, '[data-h-chart="index"]');
  setText(part, '[data-h-headline]', shareHeadline(h, range));
  const share = $(part, '[data-h-chart="share"]');
  if (share) renderChart(share, pts((r) => r.share), { label: 'share of accounts off bluesky', color: 'var(--weather-else)', format: pct, formatTick: (v) => `${Number(v.toFixed(3))}%`, formatTime, stepMs: step, fromZero: false });
  if (active) renderChart(active, pts((r) => r.active), { label: 'active pds hosts', color: 'var(--weather-bsky)', format: formatCount, formatTick: compactCount, formatTime, stepMs: step });
  if (index) renderChart(index, pts((r) => r.index), { label: 'hosting diversity', color: 'var(--weather-else)', format: formatIndex, formatTick: (v) => String(Number(v.toFixed(2))), formatTime, stepMs: step });

  renderActive(part, h, drawBars, now);

  // day by day, in the table
  const days = $(part, '[data-h-days-wrap]');
  if (days) days.hidden = h.daily.length === 0;
  const table = $<HTMLTableElement>(part, '[data-h-days]');
  if (table) renderHostDays(table, h.daily, now);

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
    const words: string[] = [];
    if (from > start) words.push(`i started keeping track of hosts on ${new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(from)).toLowerCase()}, so new hosts count from the day after.`);
    since.hidden = words.length === 0;
    since.textContent = words.join(' ');
  }
}

/**
 * Follows the lens: the range's hosts on load, on a window change, and every 5 minutes
 * while the tab is visible, into the hosts tile's trends part and the identity tiles.
 */
export function initHostTrends(report: ParentNode, feed: HostFeed, lens: Lens, drawBars: (list: HTMLElement, bars: Bar[]) => void, onHosts?: (h: HostHistory | undefined) => void): void {
  const part = $(report, '[data-h-trends]');
  let asked = 0;
  const load = async (quietly = false) => {
    const range = hostRange(lens.get().window);
    const mine = ++asked;
    const history = await feed.get(range, quietly ? 295_000 : 30_000);
    if (mine !== asked) return; // the lens moved on
    if (history) {
      if (part) renderHostTrends(part, history.hosts, range, drawBars);
      renderIdentities(report, history.hosts?.identities ?? [], Date.now(), drawBars, range);
      onHosts?.(history.hosts);
    } else if (!quietly && part) part.hidden = true;
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

// ---------- the identity tiles: new arrivals (with air quality), migration winds ----------

/** "today so far", "yesterday" or the day, for the identity tiles' asides. */
export function identityDayWords(day: string, now = Date.now()): string {
  const today = new Date(now).toISOString().slice(0, 10);
  if (day === today) return 'today so far (utc)';
  if (day === new Date(now - 86_400_000).toISOString().slice(0, 10)) return 'yesterday (utc)';
  return dayWords(day);
}

/** How many of the PLC directory's days each range adds up: its UTC days, today's so far. */
export const IDENTITY_SPAN: Record<HostRange, number> = { day: 1, week: 7, month: 30 };

/**
 * The days a range shows: the latest for a day (today so far, or the last one counted),
 * the days in the last 7 or 30 for a week or a month.
 */
export function identityView(days: IdentityDay[], range: HostRange, now = Date.now()): IdentityDay[] {
  if (range === 'day') return days.slice(-1);
  const from = new Date(now - (IDENTITY_SPAN[range] - 1) * 86_400_000).toISOString().slice(0, 10);
  return days.filter((d) => d.day >= from);
}

/** The identity tiles' aside for a view: "today so far (utc)", "the last 7 days (utc)", or since the first day kept when that's later. */
export function identityViewWords(view: IdentityDay[], range: HostRange, now = Date.now()): string {
  const first = view[0];
  if (!first) return '';
  if (range === 'day') return identityDayWords(first.day, now);
  const from = new Date(now - (IDENTITY_SPAN[range] - 1) * 86_400_000).toISOString().slice(0, 10);
  return first.day > from ? `since ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${first.day}T00:00:00Z`)).toLowerCase()} (utc)` : `${WINDOW_INFO[range].words} (utc)`;
}

/** Hosts by name, added up over days, busiest first. */
function mergeHosts(lists: Array<Array<{ hostname: string; accounts: number }>>, top = HOST_LIST_TOP): Array<{ hostname: string; accounts: number }> {
  const by = new Map<string, number>();
  for (const list of lists) for (const h of list) by.set(h.hostname, (by.get(h.hostname) ?? 0) + h.accounts);
  return [...by]
    .map(([hostname, accounts]) => ({ hostname, accounts }))
    .sort((a, b) => b.accounts - a.accounts || (a.hostname < b.hostname ? -1 : 1))
    .slice(0, top);
}

/** The bulk hosts over days, each one's accounts, runs and seconds added up, the most first. */
function mergeBulk(lists: BulkHost[][]): BulkHost[] {
  const by = new Map<string, BulkHost>();
  for (const list of lists)
    for (const h of list) {
      const b = by.get(h.hostname) ?? { hostname: h.hostname, accounts: 0, bursts: 0, seconds: 0 };
      by.set(h.hostname, { ...b, accounts: b.accounts + h.accounts, bursts: b.bursts + h.bursts, seconds: b.seconds + h.seconds });
    }
  return [...by.values()].sort((a, b) => b.accounts - a.accounts || (a.hostname < b.hostname ? -1 : 1)).slice(0, 10);
}

/** A view's days added up into one: the latest day's date, every count summed, the bulk hosts and destinations merged. */
export function sumDays(view: IdentityDay[]): IdentityDay | null {
  const last = view[view.length - 1];
  if (!last) return null;
  const sums = Object.fromEntries(IDENTITY_SUMS.map((k) => [k, view.reduce((t, d) => t + d[k], 0)])) as Record<(typeof IDENTITY_SUMS)[number], number>;
  return { day: last.day, ...sums, bulk: mergeBulk(view.map((d) => d.bulk)), destinations: mergeHosts(view.map((d) => d.destinations), 10) };
}

/** New accounts on independent hosts, less the ones made in bulk: people signing up somewhere else. */
export const independentOf = (d: IdentityDay): number => Math.max(0, d.createdIndependent - d.createdBulk);

/** How smoggy a day was: the share of its sign-ups that went to hosts no relay carries. */
export const SMOG_LEVELS = [
  ['thick smog', 90],
  ['smoggy', 50],
  ['hazy', 10],
] as const;

export function smogOf(d: IdentityDay): { share: number; level: string } {
  const all = d.createdBluesky + d.createdIndependent + d.createdUnlisted;
  const share = all > 0 ? (d.createdUnlisted / all) * 100 : 0;
  return { share, level: SMOG_LEVELS.find(([, from]) => share >= from)?.[0] ?? 'clear' };
}

const plural = (v: number, one: string, many = `${one}s`) => `${formatCount(v)} ${v === 1 ? one : many}`;

/** "over the last 7 days: 1 in 4 started outside bluesky", from the last week's listed sign-ups, leaving out the bulk ones. */
export function oddsWords(days: IdentityDay[]): string {
  const week = days.slice(-7);
  const indep = week.reduce((t, d) => t + independentOf(d), 0);
  const listed = week.reduce((t, d) => t + d.createdBluesky + independentOf(d), 0);
  if (indep === 0 || listed === 0) return '';
  if (week.length === 1) return '';
  return `over the last ${week.length} days: 1 in ${formatCount(Math.max(1, Math.round(listed / indep)))} started outside bluesky.`;
}

/** How long runs lasted: "40 seconds", "a minute", "32 minutes", "3.6 hours". */
export function lastedWords(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} second${Math.round(seconds) === 1 ? '' : 's'}`;
  if (seconds < 90) return 'a minute';
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes`;
  return `${Number((seconds / 3600).toFixed(1))} hours`;
}

/**
 * "plus 5,101 made in bulk on goodmkt.id (2 bursts, 32 minutes in all), left out above. ...":
 * what the numbers above leave out and why, or '' when nothing was.
 */
export function bulkWords(d: IdentityDay): string {
  if (d.createdBulk === 0 || d.bulk.length === 0) return '';
  const why = "sign-ups coming faster than all of bluesky's, or too evenly spaced to be people, look like a service making accounts.";
  const [first, second] = d.bulk;
  if (d.bulk.length === 1) {
    const runs = first!.bursts === 1 ? `one burst, ${lastedWords(first!.seconds)}` : `${formatCount(first!.bursts)} bursts, ${lastedWords(first!.seconds)} in all`;
    return `plus ${formatCount(d.createdBulk)} made in bulk on ${first!.hostname} (${runs}), left out above. ${why}`;
  }
  const on = (h: BulkHost) => `${formatCount(h.accounts)} on ${h.hostname}`;
  const rest = d.bulk.slice(2);
  const where = rest.length === 0 ? `${on(first!)} and ${on(second!)}` : `${on(first!)}, ${on(second!)} and ${formatCount(rest.reduce((t, h) => t + h.accounts, 0))} on ${rest.length === 1 ? 'one other host' : `${rest.length} other hosts`}`;
  return `plus ${formatCount(d.createdBulk)} made in bulk, left out above: ${where}. ${why}`;
}

/** Where movers went over the given days, busiest first, adding up each day's top destinations. */
export function destinationsOf(days: IdentityDay[]): Array<{ hostname: string; accounts: number }> {
  return mergeHosts(days.map((d) => d.destinations));
}

/**
 * The identity tiles from the PLC directory's days (new arrivals with its air quality,
 * migration winds), added up over the range: today so far for a day, or the last 7 or
 * 30 days. Each stays hidden without a day to show. New accounts made in bulk are counted
 * apart, so they don't swell the share that started outside bluesky. `drawBars` draws
 * the movers' destinations.
 */
export function renderIdentities(report: ParentNode, days: IdentityDay[], now = Date.now(), drawBars?: (list: HTMLElement, bars: Bar[]) => void, range: HostRange = 'day'): void {
  const tiles = ['[data-p-arrivals]', '[data-p-winds]', '[data-p-smog]'].map((sel) => $(report, sel));
  const view = identityView(days, range, now);
  const d = sumDays(view);
  for (const tile of tiles) if (tile) tile.hidden = !d;
  if (!d) return;
  const span = identityViewWords(view, range, now);
  for (const el of Array.from(report.querySelectorAll<HTMLElement>('[data-p-day]'))) el.textContent = span;
  // a day on its own is set against the last 7; a week or a month says it all itself
  const single = range === 'day';

  // new arrivals: on listed hosts only, less the bulk ones; unlisted sign-ups are the smog
  const indep = independentOf(d);
  const listed = d.createdBluesky + indep;
  setText(report, '[data-p-signups]', formatCount(listed));
  setText(report, '[data-p-bsky]', formatCount(d.createdBluesky));
  setText(report, '[data-p-indep]', formatCount(indep));
  renderShare($(report, '[data-p-bar-bsky]'), $(report, '[data-p-bar-else]'), listed > 0 ? (indep / listed) * 100 : 0);
  setText(
    report,
    '[data-p-own]',
    listed > 0
      ? `${formatIndex((indep / listed) * 100)}% started outside bluesky, and ${formatCount(d.createdCustomHandle)} with a handle on their own domain.`
      : 'nobody has signed up yet.',
  );
  const bulk = bulkWords(d);
  const bulkLine = $(report, '[data-p-bulk]');
  if (bulkLine) {
    bulkLine.hidden = !bulk;
    bulkLine.textContent = bulk;
  }
  const card = $(report, '[data-p-arrivals-card]');
  const chart = $(report, '[data-p-chart="arrivals"]');
  if (card) card.hidden = days.length < 2;
  if (chart && days.length >= 2) {
    const dayFmt = (t: number) => DAY_FORMAT.format(new Date(t)).toLowerCase();
    const shareOf = (x: IdentityDay) => (x.createdBluesky + independentOf(x) > 0 ? (independentOf(x) / (x.createdBluesky + independentOf(x))) * 100 : null);
    renderChart(chart, days.map((x) => ({ t: Date.parse(`${x.day}T00:00:00Z`), v: shareOf(x) })), { label: 'new accounts starting outside bluesky each day, as a share', color: 'var(--weather-else)', format: (v) => `${formatIndex(v)}%`, formatTick: (v) => `${Number(v.toFixed(1))}%`, formatTime: dayFmt, stepMs: 86_400_000 });
  }
  const odds = single ? oddsWords(days) : '';
  const oddsLine = $(report, '[data-p-odds]');
  if (oddsLine) {
    oddsLine.hidden = !odds;
    oddsLine.textContent = odds;
  }

  // migration winds
  setText(report, '[data-p-out]', formatCount(d.movedOut));
  setText(report, '[data-p-in]', formatCount(d.movedIn));
  setText(report, '[data-p-between]', formatCount(d.movedBetween));
  const week = days.slice(-7);
  const sum = (k: 'movedOut' | 'movedIn') => week.reduce((t, x) => t + x[k], 0);
  const windsCard = $(report, '[data-p-winds-card]');
  const windsChart = $(report, '[data-p-chart="winds"]');
  if (windsCard) windsCard.hidden = days.length < 2;
  if (windsChart && days.length >= 2) {
    const dayFmt = (t: number) => DAY_FORMAT.format(new Date(t)).toLowerCase();
    renderChart(windsChart, days.map((x) => ({ t: Date.parse(`${x.day}T00:00:00Z`), v: x.movedOut })), { label: 'accounts moving out of bluesky each day', color: 'var(--weather-bsky)', format: formatCount, formatTime: dayFmt, stepMs: 86_400_000 });
  }
  setText(report, '[data-p-week]', single && week.length > 1 ? `over the last ${week.length} days: ${plural(sum('movedOut'), 'account')} moved out, ${formatCount(sum('movedIn'))} moved back.` : '');
  // where they went: a day's movers are few, so a day shows the last week's
  const movers = single ? week : view;
  const went = destinationsOf(movers);
  const dest = $(report, '[data-p-dest-wrap]');
  if (dest) dest.hidden = went.length === 0 || !drawBars;
  const destList = $(report, '[data-p-dest]');
  if (destList && drawBars && went.length) drawBars(destList, went.map((h) => ({ label: h.hostname, perSecond: h.accounts, count: h.accounts, value: plural(h.accounts, 'mover') })));
  setText(report, '[data-p-dest-note]', movers.length > 1 ? `over the last ${movers.length} days. tap one to see how it's grown.` : `today. tap one to see how it's grown.`);

  // air quality
  const smog = smogOf(d);
  setText(report, '[data-p-smog-level]', smog.level);
  // against every sign-up, not the arrivals above, so the share doesn't read as theirs
  const all = d.createdBluesky + d.createdIndependent + d.createdUnlisted;
  setText(
    report,
    '[data-p-smog-words]',
    d.createdUnlisted === 0
      ? 'every sign-up went somewhere the relay listens.'
      : `${formatIndex(smog.share)}% of all ${plural(all, 'sign-up')} went to hosts no relay carries, so they're not in the new arrivals above.`,
  );
  setText(report, '[data-p-deleted]', `${plural(d.deleted, 'account')} deleted ${d.deleted === 1 ? 'itself' : 'themselves'}.`);
}

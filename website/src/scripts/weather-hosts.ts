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
}

export interface IdentityDay {
  day: string;
  ops: number;
  createdBluesky: number;
  createdIndependent: number;
  createdUnlisted: number;
  createdCustomHandle: number;
  movedOut: number;
  movedIn: number;
  movedBetween: number;
  deleted: number;
}

const IDENTITY_COUNTS = ['ops', 'createdBluesky', 'createdIndependent', 'createdUnlisted', 'createdCustomHandle', 'movedOut', 'movedIn', 'movedBetween', 'deleted'] as const;

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
    identities: Array.isArray(x.identities) ? x.identities.filter((d): d is IdentityDay => obj(d) && typeof d.day === 'string' && DAY_RE.test(d.day) && IDENTITY_COUNTS.every((k) => n(d[k]))) : [],
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
  const pts = (v: (r: (typeof rows)[number]) => number): ChartPoint[] => [...lead, ...rows.map((r) => ({ t: r.t, v: v(r) }))];
  const active = $(part, '[data-h-chart="active"]');
  const index = $(part, '[data-h-chart="index"]');
  if (active) renderChart(active, pts((r) => r.active), { label: 'active pds hosts', color: 'var(--weather-bsky)', format: formatCount, formatTick: compactCount, formatTime, stepMs: step });
  if (index) renderChart(index, pts((r) => r.index), { label: 'hosting diversity', color: 'var(--weather-else)', format: formatIndex, formatTick: (v) => String(Number(v.toFixed(2))), formatTime, stepMs: step });

  // day by day: joined each day as a chart (from the second day kept), everything in the table
  const counted = h.daily.filter((d) => d.joined !== null);
  const joinedCard = $(part, '[data-h-chart="joined"]')?.closest<HTMLElement>('.weather-chart-card');
  const joined = $(part, '[data-h-chart="joined"]');
  if (joinedCard) joinedCard.hidden = counted.length < 2;
  if (joined && counted.length >= 2) {
    const dayFmt = (t: number) => DAY_FORMAT.format(new Date(t)).toLowerCase();
    renderChart(joined, counted.map((d) => ({ t: Date.parse(`${d.day}T00:00:00Z`), v: d.joined })), { label: 'independent hosts joining each day', color: 'var(--weather-else)', format: formatCount, formatTime: dayFmt, stepMs: 86_400_000 });
  }
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
    since.hidden = !(from > start);
    if (from > start) since.textContent = `i started keeping track of hosts on ${new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(from)).toLowerCase()}, so new hosts count from the day after.`;
  }
}

/**
 * Follows the lens: the range's hosts on load, on a window change, and every 5 minutes
 * while the tab is visible, into the hosts tile's trends part and the identity tiles.
 */
export function initHostTrends(report: ParentNode, feed: HostFeed, lens: Lens, drawBars: (list: HTMLElement, bars: Bar[]) => void): void {
  const part = $(report, '[data-h-trends]');
  let asked = 0;
  const load = async (quietly = false) => {
    const range = hostRange(lens.get().window);
    const mine = ++asked;
    const history = await feed.get(range, quietly ? 295_000 : 30_000);
    if (mine !== asked) return; // the lens moved on
    if (history) {
      if (part) renderHostTrends(part, history.hosts, range, drawBars);
      renderIdentities(report, history.hosts?.identities ?? []);
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

// ---------- the identity tiles: new arrivals, migration winds, air quality ----------

/** "today so far", "yesterday" or the day, for the identity tiles' asides. */
export function identityDayWords(day: string, now = Date.now()): string {
  const today = new Date(now).toISOString().slice(0, 10);
  if (day === today) return 'today so far (utc)';
  if (day === new Date(now - 86_400_000).toISOString().slice(0, 10)) return 'yesterday (utc)';
  return dayWords(day);
}

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

/** Which way the migration wind blows: out of Bluesky's hosts, back in, or calm. */
export function compassOf(out: number, back: number): string {
  if (out === 0 && back === 0) return 'still air: nobody moved between bluesky and an independent host';
  if (out === back) return `calm: ${formatCount(out)} each way`;
  return out > back ? `blowing out of bluesky, ${formatCount(out)} to ${formatCount(back)}` : `blowing back to bluesky, ${formatCount(back)} to ${formatCount(out)}`;
}

const plural = (v: number, one: string, many = `${one}s`) => `${formatCount(v)} ${v === 1 ? one : many}`;

/** The three identity tiles from the PLC directory's days; each stays hidden without a day to show. */
export function renderIdentities(report: ParentNode, days: IdentityDay[], now = Date.now()): void {
  const tiles = ['[data-p-arrivals]', '[data-p-winds]', '[data-p-smog]'].map((sel) => $(report, sel));
  const d = days[days.length - 1];
  for (const tile of tiles) if (tile) tile.hidden = !d;
  if (!d) return;
  for (const el of Array.from(report.querySelectorAll<HTMLElement>('[data-p-day]'))) el.textContent = identityDayWords(d.day, now);

  // new arrivals: on listed hosts only; unlisted sign-ups are the smog
  const listed = d.createdBluesky + d.createdIndependent;
  setText(report, '[data-p-signups]', formatCount(listed));
  setText(report, '[data-p-bsky]', formatCount(d.createdBluesky));
  setText(report, '[data-p-indep]', formatCount(d.createdIndependent));
  renderShare($(report, '[data-p-bar-bsky]'), $(report, '[data-p-bar-else]'), listed > 0 ? (d.createdIndependent / listed) * 100 : 0);
  setText(
    report,
    '[data-p-own]',
    listed > 0
      ? `${formatIndex((d.createdIndependent / listed) * 100)}% signed up somewhere other than bluesky, and ${plural(d.createdCustomHandle, 'new account')} started out with a handle on their own domain.`
      : 'nobody has signed up yet.',
  );
  const card = $(report, '[data-p-arrivals-card]');
  const chart = $(report, '[data-p-chart="arrivals"]');
  if (card) card.hidden = days.length < 2;
  if (chart && days.length >= 2) {
    const dayFmt = (t: number) => DAY_FORMAT.format(new Date(t)).toLowerCase();
    renderChart(chart, days.map((x) => ({ t: Date.parse(`${x.day}T00:00:00Z`), v: x.createdIndependent })), { label: 'new accounts on independent hosts each day', color: 'var(--weather-else)', format: formatCount, formatTick: compactCount, formatTime: dayFmt, stepMs: 86_400_000 });
  }

  // migration winds
  setText(report, '[data-p-compass]', compassOf(d.movedOut, d.movedIn));
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
  setText(report, '[data-p-week]', week.length > 1 ? `over the last ${week.length} days: ${plural(sum('movedOut'), 'account')} moved out, ${formatCount(sum('movedIn'))} moved back.` : '');

  // air quality
  const smog = smogOf(d);
  setText(report, '[data-p-smog-level]', smog.level);
  setText(report, '[data-p-smog-words]', `${formatIndex(smog.share)}% of sign-ups went to hosts no relay carries`);
  setText(
    report,
    '[data-p-smog-line]',
    d.createdUnlisted === 0
      ? 'every new account went somewhere the relay listens. clear skies.'
      : listed > 0
        ? `for every account that signed up where the relay listens, ${formatCount(Math.round(d.createdUnlisted / listed))} signed up somewhere it doesn't: test servers, typos, and bulk sign-ups nobody relays (${compactCount(d.createdUnlisted)} in all).`
        : `${compactCount(d.createdUnlisted)} sign-ups on hosts nobody relays, and none anywhere else.`,
  );
  setText(report, '[data-p-deleted]', `${plural(d.deleted, 'account')} deleted ${d.deleted === 1 ? 'itself' : 'themselves'}.`);
}

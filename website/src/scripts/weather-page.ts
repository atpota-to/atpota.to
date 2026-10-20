/**
 * The atmosphere weather report (weather/index.html, /weather): the home page's
 * "atmospheric conditions" tile, at full size. One reading from /api/atmosphere
 * (server/atmosphere.ts) fills every tile: how busy Bluesky is, the diversity index (the
 * share of new records written outside Bluesky) on a UV-index-style scale, the split as a
 * bar, the busiest apps elsewhere, Bluesky's busiest collections, and the last minute:
 * every kind of event and the accounts active, as counts. When the reading is the weather station's rolling 60 seconds it checks
 * again every 5 seconds (with a sparkline of those 60 seconds), otherwise once a minute,
 * always only while the tab is visible; a failed check keeps the last reading on screen.
 *
 * Trends come from /api/weather-history (server/weather-history.ts): the station's
 * minute rows for the last hour, 24 hours, 7 days or 30 days, as three charts
 * (weather-chart.ts: records a second, the diversity index, apps heard), and the busiest
 * apps over the range, each with an arrow for how it did against the same span a day
 * (or a week, or 30 days) earlier.
 *
 * Records or accounts: a toggle on the trends and on the apps elsewhere (the same one,
 * remembered in this browser) switches them from new records to active accounts, the
 * different DIDs that wrote anything, so a bot writing a thousand records counts once.
 * The station counts those with HyperLogLog sketches (atmosphere/src/accounts.js); the
 * live reading has them for its 60 seconds, /api/weather-history for each range.
 *
 * The almanac tiles (today so far, new in the atmosphere, when the sky is busiest) are
 * weather-almanac.ts; the header's clouds, weather-sky.ts; and the weather alerts that
 * pop up when something changes between readings, weather-alerts.ts.
 *
 * Collection names and app domains come from other people's records, so they only reach
 * the DOM through textContent (weather.ts has already dropped any that don't look right).
 *
 * States live on the report as data-state="loading" | "ready" | "error".
 */

import { alertsFor, createAlertDesk, newAppAlert, type AlertDesk, type Watch } from './weather-alerts';
import { clock, initAlmanac, readerTimeZone, type Almanac } from './weather-almanac';
import { renderChart, smoothPath, type ChartPoint } from './weather-chart';
import { cloudCount, renderClouds } from './weather-sky';
import {
  CONDITION_TEXT,
  ERROR_TEXT,
  LEVEL_TEXT,
  REFRESH_MS,
  countTo,
  fetchReading,
  formatIndex,
  ratioText,
  recordsPerSecond,
  renderRatio,
  spinRays,
  type Reading,
} from './weather';

export const LIVE_REFRESH_MS = 5_000;
export const HISTORY_ENDPOINT = '/api/weather-history';

/** Where the scale ends: "extreme" starts at 11 and gets two more points of room. */
export const SCALE_MAX = 13;

/** Plain names for Bluesky's collections; anything else shows its NSID. */
export const BLUESKY_NAMES: Record<string, string> = {
  'app.bsky.feed.like': 'likes',
  'app.bsky.feed.post': 'posts',
  'app.bsky.feed.repost': 'reposts',
  'app.bsky.graph.follow': 'follows',
  'app.bsky.graph.block': 'blocks',
  'app.bsky.feed.threadgate': 'who-can-reply settings',
  'app.bsky.feed.postgate': 'quote settings',
  'app.bsky.graph.listitem': 'people added to lists',
  'app.bsky.graph.list': 'new lists',
  'app.bsky.graph.listblock': 'lists blocked',
  'app.bsky.graph.starterpack': 'starter packs',
  'app.bsky.graph.verification': 'verifications',
  'app.bsky.feed.generator': 'new feeds',
  'app.bsky.actor.profile': 'new profiles',
  'app.bsky.actor.status': 'live statuses',
  'app.bsky.notification.declaration': 'notification settings',
  'chat.bsky.actor.declaration': 'chat settings',
};

/** Records a second as people read them: one decimal under 100, whole after that. */
export function formatRate(n: number): string {
  return n < 100 ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : Math.round(n).toLocaleString('en-US');
}

/** Accounts as people read them: 21,345. */
export const formatCount = (n: number) => Math.round(n).toLocaleString('en-US');

/** Accounts on an axis: 21k, 1.2m. */
export function compactCount(n: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n).toLowerCase();
}

export type Measure = 'records' | 'accounts';

export const MEASURE_KEY = 'weather-measure';

export interface MeasureToggle {
  get(): Measure;
  onChange(fn: (m: Measure) => void): void;
}

/**
 * Every records / accounts toggle on the page ([data-measure] buttons), as one: pressing
 * one presses its twin, and the choice is remembered in this browser if it can be.
 */
export function createMeasure(root: ParentNode): MeasureToggle {
  let current: Measure = 'records';
  try {
    if (localStorage.getItem(MEASURE_KEY) === 'accounts') current = 'accounts';
  } catch {
    // no storage: records it is
  }
  const listeners: Array<(m: Measure) => void> = [];
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-measure]')];
  const show = () => {
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.measure === current));
  };
  for (const b of buttons) {
    b.addEventListener('click', () => {
      const next = b.dataset.measure;
      if ((next !== 'records' && next !== 'accounts') || next === current) return;
      current = next;
      try {
        localStorage.setItem(MEASURE_KEY, next);
      } catch {
        // remembered for this visit only
      }
      show();
      for (const fn of listeners) fn(current);
    });
  }
  show();
  return { get: () => current, onChange: (fn) => listeners.push(fn) };
}

function formatShare(part: number, whole: number): string {
  if (whole <= 0) return '';
  const pct = (part / whole) * 100;
  return `(${pct > 0 && pct < 0.01 ? '<0.01' : pct < 1 || pct > 99 ? pct.toFixed(2) : pct.toFixed(1)}%)`;
}

const $ = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T>(sel);

function setText(root: ParentNode, sel: string, text: string): void {
  const el = $(root, sel);
  if (el) el.textContent = text;
}

function count(root: ParentNode, sel: string, value: number | undefined, format: (n: number) => string = formatRate): void {
  const el = $(root, sel);
  if (el && value !== undefined) countTo(el, value, format);
}

export interface Bar {
  label: string;
  /** Smaller text under the label: an NSID, or an app's collections. */
  sub?: string;
  perSecond: number;
  count: number;
  /** What to print beside the bar; default its rate a second. */
  value?: string;
  /** A short change beside the value ("↑ 42%"), and what it means in words for screen readers. */
  change?: { text: string; words: string; trend: 'up' | 'down' | 'steady' | 'new' };
}

/** A list of horizontal bars, each as long as its share of the busiest one, its value in words beside it. */
export function renderBars(list: HTMLElement, bars: Bar[], seconds: number | undefined): void {
  const max = Math.max(...bars.map((b) => b.perSecond), 0);
  list.replaceChildren(
    ...bars.map((b) => {
      const li = document.createElement('li');
      li.className = 'weather-bars__row';
      if (seconds) li.title = `${b.count.toLocaleString('en-US')} in ${seconds} seconds`;
      const label = document.createElement('span');
      label.className = 'weather-bars__label';
      label.textContent = b.label;
      const value = document.createElement('span');
      value.className = 'weather-bars__value';
      value.textContent = b.value ?? formatRate(b.perSecond);
      const track = document.createElement('span');
      track.className = 'weather-bars__track';
      track.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('span');
      fill.className = 'weather-bars__fill';
      fill.style.width = `${max > 0 ? Math.max(1.5, (b.perSecond / max) * 100) : 0}%`;
      track.append(fill);
      const change = document.createElement('span');
      change.className = 'weather-bars__change';
      if (b.change) {
        change.dataset.trend = b.change.trend;
        const shown = document.createElement('span');
        shown.setAttribute('aria-hidden', 'true');
        shown.textContent = b.change.text;
        const said = document.createElement('span');
        said.className = 'visually-hidden';
        said.textContent = b.change.words;
        change.append(shown, said);
      }
      li.append(label, change, value, track);
      if (b.sub) {
        const sub = document.createElement('span');
        sub.className = 'weather-bars__sub';
        sub.textContent = b.sub;
        li.append(sub);
      }
      return li;
    }),
  );
}

export function renderReport(report: HTMLElement, r: Reading, measure: Measure = 'records'): void {
  // now
  count(report, '[data-r-records]', recordsPerSecond(r), (n) => String(Math.round(n)));
  setText(report, '[data-r-cond]', CONDITION_TEXT[r.condition]);
  const live = r.source === 'station';
  spinRays(report, recordsPerSecond(r));
  const acct = r.accounts;
  const sky = $(report, '[data-weather-sky]');
  if (sky && r.diversity) renderClouds(sky, cloudCount(r.diversity.index));
  const spark = $(report, '[data-r-spark]');
  if (spark) {
    const records = (r.series ?? []).map((p) => p?.creates ?? null);
    spark.hidden = !live || records.filter((p) => p !== null).length < 2;
    if (!spark.hidden) renderSparkline(spark, records);
  }

  // diversity
  if (r.diversity) {
    count(report, '[data-r-index]', r.diversity.index, formatIndex);
    setText(report, '[data-r-level]', r.diversity.level);
    setText(report, '[data-r-level-text]', LEVEL_TEXT[r.diversity.level]);
    const marker = $(report, '[data-r-marker]');
    if (marker) marker.style.left = `${(Math.min(r.diversity.index, SCALE_MAX) / SCALE_MAX) * 100}%`;
    setText(report, '[data-r-collections]', r.diversity.collections.toLocaleString('en-US'));
  }
  const byAccounts = $(report, '[data-r-acct-index]');
  if (byAccounts) {
    byAccounts.hidden = !acct || acct.active <= 0;
    if (acct && acct.active > 0)
      byAccounts.textContent = `by accounts: ${formatIndex(acct.index)}% of the ${formatCount(acct.active)} accounts active just now wrote somewhere other than bluesky.`;
  }

  // bluesky and everyone else
  if (r.records) {
    setText(report, '[data-r-ratio]', ratioText(r.records));
    renderRatio($(report, '[data-r-bar-bsky]'), $(report, '[data-r-bar-else]'), r.records);
    count(report, '[data-r-bsky]', r.records.bluesky);
    count(report, '[data-r-else]', r.records.elsewhere);
    count(report, '[data-r-total]', r.records.perSecond);
    setText(report, '[data-r-bsky-share]', formatShare(r.records.bluesky, r.records.perSecond));
    setText(report, '[data-r-else-share]', formatShare(r.records.elsewhere, r.records.perSecond));
  }

  // elsewhere, by records or by accounts
  const byAcct = measure === 'accounts' && acct !== undefined;
  const apps = r.apps ?? [];
  const appsList = $(report, '[data-r-apps]');
  if (appsList) {
    if (byAcct) {
      renderBars(
        appsList,
        acct.apps.map((a) => ({ label: a.domain, sub: a.collections.join(', '), perSecond: a.accounts, count: a.accounts, value: formatCount(a.accounts) })),
        undefined,
      );
    } else renderBars(appsList, apps.map((a) => ({ label: a.domain, sub: a.collections.join(', '), perSecond: a.perSecond, count: a.count })), r.seconds);
  }
  const shown = byAcct ? acct.apps.length : apps.length;
  const empty = $(report, '[data-r-apps-empty]');
  if (empty) empty.hidden = shown > 0;
  const n = r.diversity?.apps ?? apps.length;
  setText(report, '[data-r-apps-count]', n === 0 ? '' : `${n} app${n === 1 ? '' : 's'} heard${n > shown ? `, top ${shown}` : ''}`);

  // bluesky
  const bskyList = $(report, '[data-r-bsky-list]');
  if (bskyList && r.bluesky) {
    renderBars(
      bskyList,
      r.bluesky.map((b) => ({ label: BLUESKY_NAMES[b.nsid] ?? b.nsid, sub: b.nsid, perSecond: b.perSecond, count: b.count })),
      r.seconds,
    );
  }

  // the last minute: each kind of event as a count, and who wrote (the station's reading only)
  if (r.events) for (const [key, value] of Object.entries(r.events)) count(report, `[data-r-event="${key}"]`, value * 60, formatCount);
  const minuteAccounts = $(report, '[data-r-minute-accounts]');
  if (minuteAccounts) minuteAccounts.hidden = !acct;
  count(report, '[data-r-active]', acct?.active, formatCount);

  if (report.dataset.state !== 'ready') setText(report, '[data-r-status]', `${CONDITION_TEXT[r.condition]}. diversity index ${r.diversity ? `${formatIndex(r.diversity.index)}, ${r.diversity.level}` : 'unknown'}.`);
  report.dataset.state = 'ready';
}

/**
 * A bare line of the last 60 seconds: decorative (aria-hidden), the reading says it in
 * words. It spans its own lowest to highest second, so a minute that only wobbles around
 * 450 still shows its shape.
 */
export function renderSparkline(host: HTMLElement, values: Array<number | null>): void {
  const w = 240;
  const h = 36;
  const heard = values.filter((v): v is number => v !== null);
  const max = Math.max(...heard);
  const min = Math.min(...heard);
  const span = max - min;
  const step = values.length > 1 ? w / (values.length - 1) : w;
  // one smooth run per stretch of seconds the station heard
  const runs: Array<Array<[number, number]>> = [[]];
  values.forEach((v, i) => {
    if (v === null) runs.push([]);
    else runs[runs.length - 1]!.push([i * step, span > 0 ? h - 3 - ((v - min) / span) * (h - 6) : h / 2]);
  });
  const d = runs.filter((r) => r.length).map(smoothPath).join('');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(path);
  host.replaceChildren(svg);
}

// ---------- trends ----------

export type Range = 'hour' | 'day' | 'week' | 'month';

export interface HistoryPoint {
  t: string;
  seconds: number;
  creates: number;
  bluesky: number;
  elsewhere: number;
  posts: number;
}

export interface HistoryApp {
  domain: string;
  creates: number;
  /** Its records in the earlier window (compare), when the server had them. */
  prevCreates?: number;
  collections: string[];
}

export interface History {
  range: Range;
  points: HistoryPoint[];
  total: HistoryPoint;
  /** The busiest apps outside Bluesky over the range, when the server could get them. */
  apps?: HistoryApp[];
  /** How much of the range, and of the earlier window the apps are compared with, the station heard. */
  compare?: { seconds: number; prevSeconds: number; lagMs: number };
  /** Apps outside Bluesky heard each minute, hour, day or month. */
  appsOverTime?: { bucket: Bucket; points: Array<{ t: string; apps: number }> };
  /** Active accounts over the range and each bucket (server/weather-accounts.ts). */
  accounts?: HistoryAccounts;
}

export interface AccountCounts {
  active: number;
  bluesky: number;
  elsewhere: number;
}

export interface HistoryAccounts {
  /** How much of the range, and of the earlier window, the station heard counting accounts. */
  seconds: number;
  prevSeconds: number;
  /** Everyone active over the whole range: fewer than the buckets add up to. */
  total: AccountCounts;
  points: Array<AccountCounts & { t: string; seconds: number }>;
  apps: Array<{ domain: string; active: number; prevActive: number; collections: string[] }>;
}

export type Bucket = 'minute' | 'hour' | 'day' | 'month';
const BUCKET_MS: Record<Bucket, number> = { minute: 60_000, hour: 3600_000, day: 86_400_000, month: 32 * 86_400_000 };

export const RANGE_INFO: Record<Range, { spanMs: number; stepMs: number; words: string; earlier: string; time: Intl.DateTimeFormatOptions }> = {
  hour: { spanMs: 3600_000, stepMs: 60_000, words: 'the last hour', earlier: 'the same hour yesterday', time: { hour: 'numeric', minute: '2-digit' } },
  day: { spanMs: 24 * 3600_000, stepMs: 3600_000, words: 'the last 24 hours', earlier: 'the day before', time: { weekday: 'short', hour: 'numeric', minute: '2-digit' } },
  week: { spanMs: 7 * 86_400_000, stepMs: 3600_000, words: 'the last 7 days', earlier: 'the week before', time: { weekday: 'short', hour: 'numeric' } },
  month: { spanMs: 30 * 86_400_000, stepMs: 86_400_000, words: 'the last 30 days', earlier: 'the 30 days before', time: { month: 'short', day: 'numeric' } },
};

const BUCKET_WORDS: Record<Bucket, string> = { minute: 'minute', hour: 'hour', day: 'day', month: 'month' };
const BUCKET_OF: Record<Range, Bucket> = { hour: 'minute', day: 'hour', week: 'hour', month: 'day' };

const RANGES = Object.keys(RANGE_INFO) as Range[];

function isPoint(p: unknown): p is HistoryPoint {
  const r = p as Record<string, unknown>;
  const n = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  return typeof r === 'object' && r !== null && typeof r.t === 'string' && Number.isFinite(Date.parse(r.t)) && n(r.seconds) && n(r.creates) && n(r.bluesky) && n(r.elsewhere) && n(r.posts);
}

const APP_NAME_RE = /^[a-z0-9][a-z0-9.-]{0,252}$/i;

function isApp(a: unknown): a is HistoryApp {
  const r = a as Record<string, unknown>;
  const n = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.domain === 'string' &&
    APP_NAME_RE.test(r.domain) &&
    n(r.creates) &&
    (r.prevCreates === undefined || n(r.prevCreates)) &&
    Array.isArray(r.collections) &&
    r.collections.every((c) => typeof c === 'string' && APP_NAME_RE.test(c))
  );
}

export async function fetchHistory(range: Range, fetchImpl: typeof fetch = fetch): Promise<History | null> {
  try {
    const res = await fetchImpl(`${HISTORY_ENDPOINT}?range=${range}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { range?: unknown; points?: unknown; total?: unknown; apps?: unknown; compare?: unknown; appsOverTime?: unknown; accounts?: unknown };
    if (body.range !== range || !Array.isArray(body.points) || !isPoint(body.total)) return null;
    const history: History = { range, points: body.points.filter(isPoint), total: body.total };
    if (Array.isArray(body.apps)) history.apps = body.apps.filter(isApp);
    const n = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
    const c = body.compare as Record<string, unknown> | undefined;
    if (c && n(c.seconds) && n(c.prevSeconds) && n(c.lagMs)) history.compare = { seconds: c.seconds, prevSeconds: c.prevSeconds, lagMs: c.lagMs };
    const o = body.appsOverTime as Record<string, unknown> | undefined;
    if (o && typeof o.bucket === 'string' && Object.hasOwn(BUCKET_MS, o.bucket) && Array.isArray(o.points)) {
      history.appsOverTime = {
        bucket: o.bucket as Bucket,
        points: o.points.filter((p): p is { t: string; apps: number } => typeof p === 'object' && p !== null && typeof p.t === 'string' && Number.isFinite(Date.parse(p.t)) && n(p.apps)),
      };
    }
    const accounts = toAccounts(body.accounts);
    if (accounts) history.accounts = accounts;
    return history;
  } catch {
    return null;
  }
}

/** The accounts part of a history answer, checked field by field, or null. */
function toAccounts(x: unknown): HistoryAccounts | null {
  const n = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const r = x as Record<string, unknown> | undefined;
  const isCounts = (c: unknown): c is AccountCounts => typeof c === 'object' && c !== null && n((c as AccountCounts).active) && n((c as AccountCounts).bluesky) && n((c as AccountCounts).elsewhere);
  if (typeof r !== 'object' || r === null || !n(r.seconds) || !n(r.prevSeconds) || !isCounts(r.total) || !Array.isArray(r.points) || !Array.isArray(r.apps)) return null;
  return {
    seconds: r.seconds,
    prevSeconds: r.prevSeconds,
    total: { active: r.total.active, bluesky: r.total.bluesky, elsewhere: r.total.elsewhere },
    points: r.points.filter((p): p is HistoryAccounts['points'][number] => {
      const v = p as Record<string, unknown>;
      return isCounts(p) && typeof v.t === 'string' && Number.isFinite(Date.parse(v.t)) && n(v.seconds);
    }),
    apps: r.apps
      .filter((a): a is HistoryAccounts['apps'][number] => {
        const v = a as Record<string, unknown>;
        return typeof v === 'object' && v !== null && typeof v.domain === 'string' && APP_NAME_RE.test(v.domain) && n(v.active) && n(v.prevActive) && Array.isArray(v.collections);
      })
      .map((a) => ({ ...a, collections: a.collections.filter((c) => typeof c === 'string' && APP_NAME_RE.test(c)) })),
  };
}

/**
 * How an app's accounts did against the earlier window. Accounts don't scale with time
 * (two hours hold far fewer than twice an hour's), so only when the station heard both
 * windows about as well; null otherwise.
 */
export function accountChange(app: HistoryAccounts['apps'][number], a: HistoryAccounts, earlier: string): Bar['change'] | null {
  if (a.seconds <= 0 || a.prevSeconds < a.seconds * 0.9 || a.prevSeconds > a.seconds * 1.1) return null;
  if (app.prevActive === 0) return { text: 'new', words: `nobody at all in ${earlier}`, trend: 'new' };
  const pct = Math.round((app.active / app.prevActive - 1) * 100);
  if (pct >= 15) return { text: `↑ ${pct > 999 ? '999+' : pct}%`, words: `up ${pct}% on ${earlier}`, trend: 'up' };
  if (pct <= -15) return { text: `↓ ${-pct}%`, words: `down ${-pct}% on ${earlier}`, trend: 'down' };
  return { text: '→', words: `about the same as ${earlier}`, trend: 'steady' };
}

/**
 * How an app did against the earlier window, by rate (the station may have heard more of
 * one window than the other). null when the earlier window is too thin to say.
 */
export function appChange(app: HistoryApp, compare: History['compare'], earlier: string): Bar['change'] | null {
  if (!compare || app.prevCreates === undefined || compare.seconds <= 0 || compare.prevSeconds < compare.seconds * 0.5) return null;
  if (app.prevCreates === 0) return { text: 'new', words: `none at all in ${earlier}`, trend: 'new' };
  const ratio = app.creates / compare.seconds / (app.prevCreates / compare.prevSeconds);
  const pct = Math.round((ratio - 1) * 100);
  if (pct >= 15) return { text: `↑ ${pct > 999 ? '999+' : pct}%`, words: `up ${pct}% on ${earlier}`, trend: 'up' };
  if (pct <= -15) return { text: `↓ ${-pct}%`, words: `down ${-pct}% on ${earlier}`, trend: 'down' };
  return { text: '→', words: `about the same as ${earlier}`, trend: 'steady' };
}

/** Records a second and the diversity index of a point (null when it covers nothing). */
export function ratesOf(p: HistoryPoint): { records: number | null; posts: number | null; index: number | null } {
  if (p.seconds <= 0) return { records: null, posts: null, index: null };
  return { records: p.creates / p.seconds, posts: p.posts / p.seconds, index: p.creates > 0 ? (p.elsewhere / p.creates) * 100 : null };
}

/** How much of a range the station covered, in words: "13 minutes", "2 days". */
export function coverageWords(seconds: number): string {
  const units: Array<[string, number]> = [
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return `${n} ${unit}${n === 1 ? '' : 's'}`;
  }
  return 'under a minute';
}

export function trendSummary(h: History): string {
  const info = RANGE_INFO[h.range];
  const { records, index } = ratesOf(h.total);
  if (records === null) return `no readings yet for ${info.words}. the station fills this in as it goes.`;
  const covered = h.total.seconds < (info.spanMs / 1000) * 0.9 ? ` (from ${coverageWords(h.total.seconds)} of readings so far)` : '';
  const idx = index === null ? '' : `, diversity index ${formatIndex(index)}`;
  return `${info.words}${covered}: ${formatRate(records)} new records a second${idx}.`;
}

export function accountSummary(h: History): string {
  const info = RANGE_INFO[h.range];
  const a = h.accounts;
  if (!a) return 'the account counts are hard to read right now. the records are still here.';
  if (a.seconds <= 0 || a.total.active <= 0) return `no account counts yet for ${info.words}. the station only just started counting accounts, and fills this in as it goes.`;
  const covered = a.seconds < (info.spanMs / 1000) * 0.9 ? ` (from ${coverageWords(a.seconds)} of counting so far)` : '';
  const share = (a.total.elsewhere / a.total.active) * 100;
  return `${info.words}${covered}: ${formatCount(a.total.active)} different accounts wrote something, ${formatIndex(share)}% of them somewhere other than bluesky.`;
}

type TimeFormat = (t: number) => string;

function setChartTitle(section: HTMLElement, chart: string, title: string): void {
  setText(section, `[data-t-chart-title="${chart}"]`, title);
}

/** Starts the axis where the range starts, so a station that's new shows as a gap, not a short range. */
function lead(h: History, firstT: number | undefined, now: number, stepMs: number): ChartPoint[] {
  const start = now - RANGE_INFO[h.range].spanMs;
  return (firstT ?? now) - start > stepMs ? [{ t: start, v: null }] : [];
}

/** The trends, by records or by accounts: the summary (for screen readers), two charts, apps heard and the busiest apps. */
export function renderTrends(section: HTMLElement, h: History, now = Date.now(), measure: Measure = 'records'): void {
  const info = RANGE_INFO[h.range];
  const fmt = new Intl.DateTimeFormat(undefined, info.time);
  const formatTime = (t: number) => fmt.format(new Date(t)).toLowerCase();
  section.dataset.measure = measure;
  if (measure === 'accounts') renderAccountTrends(section, h, now, formatTime);
  else renderRecordTrends(section, h, now, formatTime);
  renderAppsOverTime(section, h, now, formatTime);
  // The charts say it all on screen; the sentence stays for screen readers, read out when the range changes.
  $(section, '[data-t-summary]')?.classList.add('visually-hidden');
  section.dataset.state = 'ready';
}

function renderRecordTrends(section: HTMLElement, h: History, now: number, formatTime: TimeFormat): void {
  const info = RANGE_INFO[h.range];
  setText(section, '[data-t-summary]', trendSummary(h));
  setChartTitle(section, 'records', 'new records a second');
  setChartTitle(section, 'index', 'diversity index');
  const rows = h.points.map((p) => ({ t: Date.parse(p.t), ...ratesOf(p) }));
  const pts = (key: 'records' | 'index'): ChartPoint[] => [...lead(h, rows[0]?.t, now, info.stepMs), ...rows.map((r) => ({ t: r.t, v: r[key] }))];
  const records = $(section, '[data-t-chart="records"]');
  const index = $(section, '[data-t-chart="index"]');
  if (records) renderChart(records, pts('records'), { label: 'new records a second', color: 'var(--weather-bsky)', format: formatRate, formatTime, stepMs: info.stepMs });
  if (index) renderChart(index, pts('index'), { label: 'diversity index', color: 'var(--weather-else)', format: formatIndex, formatTick: (v) => String(Number(v.toFixed(2))), formatTime, stepMs: info.stepMs });
  const wrap = $(section, '[data-t-apps-wrap]');
  const list = $(section, '[data-t-apps]');
  const apps = h.apps ?? [];
  if (wrap && list) {
    wrap.hidden = apps.length === 0 || h.total.seconds <= 0;
    setText(section, '[data-t-apps-title]', `busiest apps elsewhere, ${info.words}: new records`);
    if (!wrap.hidden) {
      const changes = apps.map((a) => appChange(a, h.compare, info.earlier));
      renderBars(
        list,
        apps.map((a, i) => ({
          label: a.domain,
          sub: a.collections.join(', '),
          perSecond: a.creates / h.total.seconds,
          count: a.creates,
          value: a.creates.toLocaleString('en-US'),
          change: changes[i] ?? undefined,
        })),
        h.total.seconds,
      );
      setText(
        section,
        '[data-t-apps-note]',
        changes.some(Boolean)
          ? `arrows compare each app's records a second with ${info.earlier}.`
          : `once the station has heard ${info.earlier}, arrows show who's rising and falling.`,
      );
    }
  }
}

function renderAccountTrends(section: HTMLElement, h: History, now: number, formatTime: TimeFormat): void {
  const info = RANGE_INFO[h.range];
  const a = h.accounts;
  const bucket = BUCKET_OF[h.range];
  const step = BUCKET_MS[bucket];
  const each = `each ${BUCKET_WORDS[bucket]}`;
  setText(section, '[data-t-summary]', accountSummary(h));
  setChartTitle(section, 'records', `active accounts ${each}`);
  setChartTitle(section, 'index', 'share of accounts writing elsewhere');
  const rows = (a?.points ?? []).map((p) => ({ ...p, t: Date.parse(p.t), share: p.active > 0 ? (p.elsewhere / p.active) * 100 : null }));
  // the newest bucket is still filling up
  const last = rows[rows.length - 1]?.t;
  const when = (t: number) => (t === last && now - t < step ? `${formatTime(t)} (so far)` : formatTime(t));
  const pts = (v: (r: (typeof rows)[number]) => number | null): ChartPoint[] => [...lead(h, rows[0]?.t, now, step), ...rows.map((r) => ({ t: r.t, v: v(r) }))];
  const active = $(section, '[data-t-chart="records"]');
  const share = $(section, '[data-t-chart="index"]');
  const percent = (v: number) => `${formatIndex(v)}%`;
  if (active) renderChart(active, pts((r) => r.active), { label: `active accounts ${each}`, color: 'var(--weather-bsky)', format: formatCount, formatTick: compactCount, formatTime, formatTipTime: when, stepMs: step });
  if (share) renderChart(share, pts((r) => r.share), { label: 'share of accounts writing elsewhere', color: 'var(--weather-else)', format: percent, formatTick: (v) => `${Number(v.toFixed(2))}%`, formatTime, formatTipTime: when, stepMs: step });
  const wrap = $(section, '[data-t-apps-wrap]');
  const list = $(section, '[data-t-apps]');
  if (wrap && list) {
    wrap.hidden = !a || a.apps.length === 0 || a.seconds <= 0;
    setText(section, '[data-t-apps-title]', `busiest apps elsewhere, ${info.words}: active accounts`);
    if (a && !wrap.hidden) {
      const changes = a.apps.map((app) => accountChange(app, a, info.earlier));
      renderBars(
        list,
        a.apps.map((app, i) => ({ label: app.domain, sub: app.collections.join(', '), perSecond: app.active, count: app.active, value: formatCount(app.active), change: changes[i] ?? undefined })),
        undefined,
      );
      setText(
        section,
        '[data-t-apps-note]',
        changes.some(Boolean)
          ? `arrows compare each app's active accounts with ${info.earlier}.`
          : `once the station has counted accounts through ${info.earlier}, arrows show who's rising and falling.`,
      );
    }
  }
}

/** The third chart: apps outside Bluesky heard each minute, hour, day or month. */
function renderAppsOverTime(section: HTMLElement, h: History, now: number, formatTime: (t: number) => string): void {
  const host = $(section, '[data-t-chart="apps"]');
  const card = host?.closest<HTMLElement>('.weather-chart-card');
  const o = h.appsOverTime;
  if (!host || !card) return;
  card.hidden = !o;
  if (!o) return;
  const step = BUCKET_MS[o.bucket];
  setText(card, '[data-t-apps-chart-title]', `apps heard each ${BUCKET_WORDS[o.bucket]}`);
  const points: ChartPoint[] = o.points.map((p) => ({ t: Date.parse(p.t), v: p.apps }));
  const start = now - RANGE_INFO[h.range].spanMs;
  if ((points[0]?.t ?? now) - start > step) points.unshift({ t: start, v: null });
  // The newest bucket is still filling up, so the tooltip says so.
  const last = o.points.length ? Date.parse(o.points[o.points.length - 1]!.t) : NaN;
  const time = (t: number) => (t === last && now - t < step ? `${formatTime(t)} (so far)` : formatTime(t));
  renderChart(host, points, { label: `apps heard each ${BUCKET_WORDS[o.bucket]}`, color: 'var(--weather-else)', format: (v) => String(Math.round(v)), formatTime, formatTipTime: time, stepMs: step });
}

/**
 * The range buttons, the first load, and a refresh while the tab is visible (every minute
 * for the last hour, else every 5). Switching records and accounts redraws what's loaded:
 * one answer has both.
 */
export function initTrends(section: HTMLElement, fetchImpl: typeof fetch = fetch, measure?: MeasureToggle): void {
  const buttons = [...section.querySelectorAll<HTMLButtonElement>('[data-range]')];
  let range: Range = (buttons.find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.range as Range) ?? 'day';
  let asked = 0;
  let shown: History | null = null;
  measure?.onChange((m) => {
    if (shown) renderTrends(section, shown, Date.now(), m);
  });
  const load = async () => {
    const mine = ++asked;
    section.dataset.state = section.dataset.state === 'ready' ? 'refreshing' : 'loading';
    const history = await fetchHistory(range, fetchImpl);
    if (mine !== asked) return; // a newer range took over
    shown = history;
    if (history) renderTrends(section, history, Date.now(), measure?.get());
    else {
      section.dataset.state = 'error';
      const summary = $(section, '[data-t-summary]');
      if (summary) {
        summary.textContent = 'the records are hard to read right now. try again in a bit.';
        summary.classList.remove('visually-hidden');
      }
    }
  };
  for (const b of buttons) {
    b.addEventListener('click', () => {
      const next = b.dataset.range as Range;
      if (!RANGES.includes(next) || next === range) return;
      range = next;
      for (const other of buttons) other.setAttribute('aria-pressed', String(other === b));
      void load();
    });
  }
  void load();
  const tick = () =>
    window.setTimeout(
      () => {
        if (document.visibilityState !== 'hidden') void load();
        tick();
      },
      range === 'hour' ? 60_000 : 300_000,
    );
  tick();
}

export function renderReportError(report: HTMLElement): void {
  if (report.dataset.state === 'ready') return;
  setText(report, '[data-r-cond]', ERROR_TEXT);
  setText(report, '[data-r-status]', ERROR_TEXT);
  report.dataset.state = 'error';
}

export function init(root: ParentNode = document, fetchImpl: typeof fetch = fetch): void {
  const report = $(root, '[data-weather-report]');
  if (!report || report.dataset.weatherBound === 'true') return;
  report.dataset.weatherBound = 'true';
  let every = REFRESH_MS;
  const region = $(root, '[data-weather-alerts]');
  const desk = region ? createAlertDesk(region) : null;
  if (desk) bindHush(root, desk);
  let watch: Watch | null = null;
  const measure = createMeasure(root);
  let shown: Reading | null = null;
  measure.onChange((m) => {
    if (shown) renderReport(report, shown, m);
  });
  const load = async () => {
    const reading = await fetchReading(fetchImpl);
    if (reading) {
      shown = reading;
      renderReport(report, reading, measure.get());
      const next = alertsFor(watch, reading);
      watch = next.watch;
      for (const a of next.alerts) desk?.push(a);
    } else renderReportError(report);
    every = reading?.source === 'station' ? LIVE_REFRESH_MS : REFRESH_MS;
  };
  const tick = () =>
    window.setTimeout(async () => {
      if (document.visibilityState !== 'hidden') await load();
      tick();
    }, every);
  void load().then(tick);
  const trends = $(report, '[data-r-trends]');
  if (trends) initTrends(trends, fetchImpl, measure);
  initAlmanac(report, fetchImpl, desk ? watchNewApps(desk) : undefined);
}

/** Alerts for apps the almanac lists as new that it didn't list last time (the first load only sets the scene). */
export function watchNewApps(desk: AlertDesk, tz = readerTimeZone()): (a: Almanac) => void {
  let known: Set<string> | null = null;
  return (a) => {
    const apps = a.newApps && !a.newApps.warmingUp ? a.newApps.apps : null;
    if (!apps) return;
    if (known) for (const app of apps) if (!known.has(app.domain)) desk.push(newAppAlert(app.domain, clock(app.firstSeen, tz)));
    known = new Set([...(known ?? []), ...apps.map((app) => app.domain)]);
  };
}

/** The "hush weather alerts" button in "how it's measured", kept in step with the desk. */
function bindHush(root: ParentNode, desk: AlertDesk): void {
  const button = $<HTMLButtonElement>(root, '[data-alerts-toggle]');
  if (!button) return;
  const show = (hushed: boolean) => {
    button.textContent = hushed ? 'turn weather alerts back on' : 'hush weather alerts';
  };
  show(desk.hushed);
  desk.onHushChange(show);
  button.addEventListener('click', () => (desk.hushed ? desk.unhush() : desk.hush()));
}

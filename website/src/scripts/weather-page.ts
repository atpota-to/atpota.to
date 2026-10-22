/**
 * The atmosphere weather report (weather/index.html, /weather): the home page's
 * "atmospheric conditions" tile, at full size. One reading from /api/atmosphere
 * (server/atmosphere.ts) fills every tile: how busy Bluesky is, the diversity index (the
 * share of active accounts writing outside Bluesky, scaled by how many apps they're spread
 * across) on a UV-index-style scale, the split of new records as a bar, the busiest apps
 * elsewhere, Bluesky's busiest collections, and the last minute:
 * every kind of event and the accounts active, as counts. When the reading is the weather station's rolling 60 seconds it checks
 * again every 5 seconds (with a sparkline of those 60 seconds, weather-spark.ts), otherwise
 * once a minute, always only while the tab is visible; a failed check keeps the last
 * reading on screen. Coming from another page in the same tab, the reading it last saw
 * (storedReading, under two minutes old) is on screen at once, and rolls on to a fresh one.
 * Numbers roll to each new reading (roll.ts), the bars grow, shrink and trade places
 * rather than being drawn afresh, and the sparkline scrolls along, so nothing on the page
 * jumps while it's live.
 *
 * A window comes from /api/weather-history (server/weather-history.ts): the station's
 * rows for the last hour, 24 hours, 7 days or 30 days, one answer shared by the tiles and
 * the trends (createHistoryFeed). The trends draw it as three charts (weather-chart.ts:
 * records, the diversity index from the station's accounts, apps heard), the last hour's
 * while the lens is on now; the apps elsewhere list the busiest over it, each with an
 * arrow for how it did against the same span a day (or a week, or 30 days) earlier.
 *
 * The lens (weather-lens.ts, floating along the bottom: weather-dock.ts) says what the
 * page shows: a window (now, or the last hour, 24 hours, 7 days or 30 days), new records
 * or active accounts, and what a rate is per. The tiles that follow it (the header's
 * reading, the diversity index, bluesky and everyone else, the apps elsewhere, bluesky,
 * the trends and the stats tile) are drawn from a Sky: the live reading's (skyOfReading) for now, a history's
 * (skyOfHistory) for a window, so each tile is drawn the same way from either. A tile that
 * can't count what the lens asks (bluesky's collections have no accounts; the diversity
 * index is always by accounts) says what it counts instead, in a tag by its title.
 * Active accounts are the different DIDs that wrote anything, so a bot writing a thousand
 * records counts once; the station counts them with HyperLogLog sketches
 * (atmosphere/src/accounts.js), the live reading for its 60 seconds, /api/weather-history
 * for each range.
 *
 * The almanac tiles (today so far, new in the atmosphere, when the sky is busiest) are
 * weather-almanac.ts, and with the forecast they keep their own times, following only the
 * lens's unit; the header's clouds, weather-sky.ts; and the weather alerts Poe
 * pipes up with when something changes between readings, weather-alerts.ts.
 *
 * Collection names and app domains come from other people's records, so they only reach
 * the DOM through textContent (weather.ts has already dropped any that don't look right).
 *
 * States live on the report as data-state="loading" | "ready" | "error".
 */

import { alertsFor, createAlertDesk, newAppAlert, recordAlert, watchHosts, type AlertDesk, type Watch } from './weather-alerts';
import { clock, initAlmanac, readerTimeZone, recordHigh, type Almanac } from './weather-almanac';
import { initLensDock } from './weather-dock';
import { initHostPanel } from './weather-host-panel';
import { initForecast } from './weather-forecast';
import { initHostTrends, toHostHistory, type HostHistory } from './weather-hosts';
import { chip, initSpan, percentChange, showLive, spanFor, type Change, type ChangeKey } from './weather-span';
import {
  bindLens,
  createLens,
  formatAmount,
  LENS_DEFAULT,
  nextUnit,
  perUnit,
  rateIn,
  recordsPer,
  UNIT_INFO,
  UNIT_SECONDS,
  WINDOW_INFO,
  type Lens,
  type LensState,
  type Measure,
  type RateUnit,
  type Unit,
  type Window,
} from './weather-lens';
import { motionOK, ROLL_EASE, ROLL_MS, rollText } from './roll';
import { projectLast, renderChart, type ChartPoint } from './weather-chart';
import { explain, type PoeExplanation } from '../poe/say';
import { airNow, clearedUp, initHero, RAINBOW_COOLDOWN_MS, renderAir, showRainbow } from './weather-hero';
import { cloudCount, renderClouds } from './weather-sky';
import { renderSpark, renderSparkline } from './weather-spark';
import {
  CONDITION_TEXT,
  DIVERSITY_SCALE,
  ERROR_TEXT,
  LEVEL_TEXT,
  REFRESH_MS,
  compactCount,
  countTo,
  coverageWords,
  fetchReading,
  formatCount,
  formatIndex,
  formatRate,
  ratioText,
  recordsPerSecond,
  renderRatio,
  renderShare,
  spinRays,
  storedReading,
  type DiversityLevel,
  type Hosts,
  type Reading,
} from './weather';

export { compactCount, coverageWords, formatCount, formatRate };

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

export type { Measure };

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

/** Like setText, rolling the numbers in it. */
function roll(root: ParentNode, sel: string, text: string): void {
  const el = $(root, sel);
  if (el) rollText(el, text);
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

/** How many rows each list shows: the busiest, and only ones with something to show. */
export const LIST_TOP = 5;

/** The busiest LIST_TOP bars, leaving out any whose number would read 0. */
export function topBars(bars: Bar[]): Bar[] {
  return bars.filter((b) => (b.value ?? formatRate(b.perSecond)) !== '0').slice(0, LIST_TOP);
}

export const APPS_EMPTY = 'nobody but bluesky was writing just then. other apps come and go, so check back in a minute.';
export const APPS_TRICKLE = 'other apps only wrote a record or two just then, too few to make a bar. check back in a minute.';

/**
 * A list of horizontal bars, each as long as its share of the busiest one, its value in
 * words beside it. Rows are kept by label from one reading to the next: the bars grow and
 * shrink, the values roll, and a row that changes place slides there.
 */
export function renderBars(list: HTMLElement, bars: Bar[], seconds: number | undefined): void {
  const max = Math.max(...bars.map((b) => b.perSecond), 0);
  const motion = motionOK();
  const had = new Map<string, HTMLElement>();
  for (const li of list.children) if (li instanceof HTMLElement && li.dataset.key !== undefined) had.set(li.dataset.key, li);
  const tops = motion ? new Map([...had.values()].map((li) => [li, li.getBoundingClientRect().top])) : null;
  const rows = bars.map((b) => {
    const li = had.get(b.label);
    had.delete(b.label); // a second bar with the same label gets its own row
    return li ?? barRow(b.label);
  });
  // in order, moving as few rows as it can; anything left over has gone
  rows.forEach((li, i) => {
    if (list.children[i] !== li) list.insertBefore(li, list.children[i] ?? null);
  });
  while (list.children.length > rows.length) list.lastElementChild!.remove();
  void list.offsetHeight; // a width for moved and new bars to grow from
  rows.forEach((li, i) => fillBar(li, bars[i]!, max, seconds));
  if (!tops) return;
  for (const li of rows) {
    const was = tops.get(li);
    if (was === undefined) li.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: ROLL_MS / 2, easing: ROLL_EASE });
    else {
      const dy = was - li.getBoundingClientRect().top;
      if (Math.abs(dy) > 0.5) li.animate?.([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: ROLL_MS, easing: ROLL_EASE });
    }
  }
}

function barRow(key: string): HTMLElement {
  const li = document.createElement('li');
  li.className = 'weather-bars__row';
  li.dataset.key = key;
  const part = (className: string) => {
    const span = document.createElement('span');
    span.className = className;
    return span;
  };
  const track = part('weather-bars__track');
  track.setAttribute('aria-hidden', 'true');
  const fill = part('weather-bars__fill');
  fill.style.width = '0%';
  track.append(fill);
  li.append(part('weather-bars__label'), part('weather-bars__change'), part('weather-bars__value'), track);
  return li;
}

function fillBar(li: HTMLElement, b: Bar, max: number, seconds: number | undefined): void {
  if (seconds) li.title = `${b.count.toLocaleString('en-US')} in ${seconds} seconds`;
  else li.removeAttribute('title');
  const label = $(li, '.weather-bars__label')!;
  if (label.textContent !== b.label) label.textContent = b.label;
  const change = $(li, '.weather-bars__change')!;
  if (b.change) {
    change.dataset.trend = b.change.trend;
    const shown = document.createElement('span');
    shown.setAttribute('aria-hidden', 'true');
    shown.textContent = b.change.text;
    const said = document.createElement('span');
    said.className = 'visually-hidden';
    said.textContent = b.change.words;
    change.replaceChildren(shown, said);
  } else {
    delete change.dataset.trend;
    change.replaceChildren();
  }
  rollText($(li, '.weather-bars__value')!, b.value ?? formatRate(b.perSecond));
  $(li, '.weather-bars__fill')!.style.width = `${max > 0 ? Math.max(1.5, (b.perSecond / max) * 100) : 0}%`;
  let sub = $(li, '.weather-bars__sub');
  if (b.sub) {
    if (!sub) {
      sub = document.createElement('span');
      sub.className = 'weather-bars__sub';
      li.append(sub);
    }
    sub.textContent = b.sub;
    sub.title = b.sub;
  } else sub?.remove();
}

// ---------- the sky: what the tiles that follow the lens show ----------

/** An app outside Bluesky, by its records (a second, and counted) and, when the sky has them, its accounts. */
export interface SkyApp {
  domain: string;
  collections: string[];
  perSecond: number;
  count: number;
  change?: Bar['change'];
}

export interface Sky {
  window: Window;
  /** The seconds the counts are over, as the station heard them. */
  seconds: number;
  /** New records a second: every app's, Bluesky's and everyone else's. */
  records: { perSecond: number; bluesky: number; elsewhere: number } | null;
  /** Different accounts over the window. */
  accounts: { active: number; bluesky: number; elsewhere: number } | null;
  diversity: { index: number; level: DiversityLevel; share?: number; spread?: number; change?: Change } | null;
  /** Apps outside Bluesky heard, and collections written to, when the sky knows. */
  appsHeard: number | null;
  collections: number | null;
  apps: SkyApp[];
  /** The apps by active accounts (perSecond and count are both accounts), or null when there are no account counts. */
  appsByAccounts: SkyApp[] | null;
  bluesky: Array<{ nsid: string; perSecond: number; count: number }>;
  /** What the apps' arrows compare with, for a window. */
  earlier: string | null;
  /** The live reading itself, for now. */
  reading?: Reading;
  /** A window's line for the header, oldest first: records a second and active accounts in each bucket, the last of those an estimate while its bucket fills up (accountsProjected). */
  line?: { records: Array<number | null>; accounts: Array<number | null> | null; accountsProjected?: boolean };
  /** " (from 3 hours of readings so far)" while the station hasn't heard most of the window. */
  coverage: string;
}

/** A diversity index's level, by where it starts on the scale (weather.ts DIVERSITY_SCALE). */
export function levelOf(index: number): DiversityLevel {
  let level: DiversityLevel = 'low';
  for (const [name, from] of DIVERSITY_SCALE) if (index >= from) level = name;
  return level;
}

/** The live reading as a sky: its 60 seconds (or a few, sampled). */
export function skyOfReading(r: Reading): Sky {
  const a = r.accounts;
  return {
    window: 'now',
    seconds: r.seconds ?? 60,
    records: r.records ?? null,
    accounts: a ? { active: a.active, bluesky: a.bluesky, elsewhere: a.elsewhere } : null,
    diversity: r.diversity ?? null,
    appsHeard: r.diversity?.apps ?? r.apps?.length ?? null,
    collections: r.diversity?.collections ?? null,
    apps: (r.apps ?? []).map((x) => ({ domain: x.domain, collections: x.collections, perSecond: x.perSecond, count: x.count })),
    appsByAccounts: a ? a.apps.map((x) => ({ domain: x.domain, collections: x.collections, perSecond: x.accounts, count: x.accounts })) : null,
    bluesky: r.bluesky ?? [],
    earlier: null,
    reading: r,
    coverage: '',
  };
}

/** Bluesky's four big kinds of record, from a history's counts (it has no others). */
const HISTORY_BLUESKY = [
  ['posts', 'app.bsky.feed.post'],
  ['likes', 'app.bsky.feed.like'],
  ['reposts', 'app.bsky.feed.repost'],
  ['follows', 'app.bsky.graph.follow'],
] as const;

/** A history as a sky: the whole window, as rates over the seconds the station heard of it. */
export function skyOfHistory(h: History, now: number = Date.now()): Sky {
  const info = RANGE_INFO[h.range];
  const t = h.total;
  const secs = t.seconds;
  const a = h.accounts && h.accounts.seconds > 0 && h.accounts.total.active > 0 ? h.accounts : null;
  const share = a ? (a.total.elsewhere / a.total.active) * 100 : undefined;
  const n = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  return {
    window: h.range,
    seconds: secs,
    records: secs > 0 ? { perSecond: t.creates / secs, bluesky: t.bluesky / secs, elsewhere: t.elsewhere / secs } : null,
    accounts: a ? { active: a.total.active, bluesky: a.total.bluesky, elsewhere: a.total.elsewhere } : null,
    diversity: a && a.total.index !== undefined ? { index: a.total.index, level: levelOf(a.total.index), share, change: indexChange(a, info.earlier) ?? undefined } : null,
    appsHeard: null,
    collections: null,
    apps:
      secs > 0
        ? (h.apps ?? []).map((x) => ({ domain: x.domain, collections: x.collections, perSecond: x.creates / secs, count: x.creates, change: appChange(x, h.compare, info.earlier) ?? undefined }))
        : [],
    appsByAccounts: a ? a.apps.map((x) => ({ domain: x.domain, collections: x.collections, perSecond: x.active, count: x.active, change: accountChange(x, a, info.earlier) ?? undefined })) : null,
    bluesky:
      secs > 0
        ? HISTORY_BLUESKY.flatMap(([key, nsid]) => {
            const c = (t as unknown as Record<string, unknown>)[key];
            return n(c) ? [{ nsid, perSecond: c / secs, count: c }] : [];
          }).sort((x, y) => y.count - x.count)
        : [],
    earlier: info.earlier,
    line: { records: h.points.map((p) => ratesOf(p).records), ...accountsLine(a, h.range, now) },
    coverage: secs > 0 && secs < (info.spanMs / 1000) * 0.9 ? ` (from ${coverageWords(secs)} of readings so far)` : '',
  };
}

/**
 * How active accounts grow with time, from the history itself: everyone over the whole
 * range against the average bucket, as D(n buckets) = D(1) × n^k. People come back, so k
 * is under 1 (about 0.6 by the hour over a day); projectLast uses it to guess a bucket
 * still filling up, where a straight scale-up guessed well over the buckets before.
 */
export function accountsExponent(a: HistoryAccounts): number {
  const full = a.points.slice(0, -1).filter((p) => p.seconds > 0 && p.active > 0);
  if (full.length < 2) return 1;
  const mean = full.reduce((sum, p) => sum + p.active, 0) / full.length;
  const k = Math.log(a.total.active / mean) / Math.log(a.points.length);
  return Number.isFinite(k) ? Math.min(1, Math.max(0.3, k)) : 1;
}

/** The header's line of active accounts, its newest bucket an estimate while it fills up (projectLast), so it doesn't dip. */
function accountsLine(a: HistoryAccounts | null, range: Range, now: number): { accounts: Array<number | null> | null; accountsProjected?: boolean } {
  if (!a) return { accounts: null };
  const last = a.points[a.points.length - 1];
  const points = projectLast(a.points.map((p) => ({ t: Date.parse(p.t), v: p.active })), now, BUCKET_MS[BUCKET_OF[range]], { heardMs: (last?.seconds ?? 0) * 1000, exponent: accountsExponent(a) });
  return { accounts: points.map((p) => p.v), accountsProjected: points[points.length - 1]?.soFar !== undefined };
}

/** A rate a second as the lens shows it: per its unit, or for "total" the count over `seconds`. */
export function amountIn(perSecond: number, unit: Unit, seconds: number): number {
  return unit === 'total' ? perSecond * seconds : perUnit(perSecond, unit);
}

/** What a rate is per, in words after a number: "a second", "in all". */
const perWords = (unit: Unit) => UNIT_INFO[unit].words;

/** A tile's tag by its title, saying what it counts when that isn't what the lens asks for ("by accounts"). */
function tag(tile: Element | null, counts: Measure, lens: LensState): void {
  const el = tile ? $(tile, '[data-tag]') : null;
  if (!el) return;
  el.hidden = counts === lens.measure;
  el.textContent = `by ${counts}`;
}

/** The header's number, short enough for a phone: 21,345, then 222k, 1.23m. */
export function bigAmount(v: number): string {
  if (v < 100_000) return formatAmount(v);
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 }).format(v).toLowerCase();
}

/** The header's reading: how busy it is (or how many accounts), what that is per, and the line under it. */
function renderHeadline(report: HTMLElement, sky: Sky, lens: LensState): void {
  const words = WINDOW_INFO[sky.window].words;
  const byAcct = lens.measure === 'accounts' && sky.accounts !== null;
  report.dataset.headline = byAcct ? 'active' : 'creates';
  renderHeadlineChange(report);
  const value = byAcct ? sky.accounts!.active : sky.records ? amountIn(sky.records.perSecond, lens.unit, sky.seconds) : sky.reading ? amountIn(recordsPerSecond(sky.reading), lens.unit, sky.seconds) : undefined;
  if (value === undefined) setText(report, '[data-r-records]', '–');
  else count(report, '[data-r-records]', value, bigAmount);
  // the first number lands: no more bar in its place (weather.css)
  $(report, '[data-r-records]')?.removeAttribute('data-waiting');
  const unit = $<HTMLButtonElement>(report, '[data-r-unit]');
  if (unit) {
    // accounts are counted once over the window, so they have no rate to tap through; the
    // words for it are in [data-r-unit-words], so it's only for the eye
    unit.disabled = byAcct;
    unit.textContent = byAcct ? 'accounts' : lens.unit === 'total' ? 'records' : `rec/${UNIT_INFO[lens.unit].short}`;
    if (byAcct) {
      unit.removeAttribute('aria-label');
      unit.setAttribute('aria-hidden', 'true');
    } else {
      unit.removeAttribute('aria-hidden');
      unit.setAttribute('aria-label', `${perWords(lens.unit)}. change to ${perWords(nextUnit(lens.unit))}`);
    }
  }
  setText(report, '[data-r-unit-words]', byAcct ? `active accounts in ${words}` : lens.unit === 'total' ? `new records in ${words}` : recordsPer(lens.unit));
  const cond = byAcct ? `different accounts wrote something in ${words}` : lens.unit === 'total' ? `new records in ${words}` : `on average over ${words}`;
  if (sky.reading) setText(report, '[data-r-cond]', CONDITION_TEXT[sky.reading.condition]);
  else setText(report, '[data-r-cond]', `${cond}${sky.coverage}`);
  const spark = $(report, '[data-r-spark]');
  if (!spark) return;
  spark.removeAttribute('data-waiting');
  if (sky.reading) {
    if (byAcct) spark.hidden = true;
    else renderSpark(spark, sky.reading);
    return;
  }
  // a window's line: its own shape, so it doesn't scroll on from the live one
  const values = (byAcct ? sky.line?.accounts : sky.line?.records) ?? [];
  delete spark.dataset.end;
  spark.hidden = values.filter((v) => v !== null).length < 2;
  if (!spark.hidden) renderSparkline(spark, values, undefined, byAcct && sky.line?.accountsProjected);
}

/** The last chips the "last hour" tile drew, for the header's (initSpan's onChanges). */
const headlineChanges = new WeakMap<HTMLElement, Record<ChangeKey, Change | null> | null>();

/** The header's chip: its number against the span before, as the "last hour" tile has it. */
export function renderHeadlineChange(report: HTMLElement, changes?: Record<ChangeKey, Change | null> | null): void {
  if (changes !== undefined) headlineChanges.set(report, changes);
  const el = $(report, '[data-r-headline-change]');
  if (!el) return;
  // its pill stays until the "last hour" tile has its answer, or gives up on it (weather.css)
  if (changes !== undefined && $(report, '[data-s-tile]')?.dataset.state !== 'loading') el.removeAttribute('data-waiting');
  const key = report.dataset.headline === 'active' ? 'active' : 'creates';
  chip(el, headlineChanges.get(report)?.[key] ?? null);
}

function renderDiversity(report: HTMLElement, sky: Sky, lens: LensState): void {
  const tile = $(report, '.weather-diversity');
  tag(tile, 'accounts', lens);
  const d = sky.diversity;
  const marker = $(report, '[data-r-marker]');
  if (d) {
    count(report, '[data-r-index]', d.index, formatIndex);
    setText(report, '[data-r-level]', d.level);
    setText(report, '[data-r-level-text]', LEVEL_TEXT[d.level]);
    const change = $(report, '[data-r-index-change]');
    if (change) chip(change, d.change ?? null);
    const note = $(report, '[data-r-index-note]');
    if (note) {
      note.hidden = !d.change || !sky.earlier;
      note.textContent = sky.earlier ? `the arrow compares with ${sky.earlier}.` : '';
    }
    if (marker) {
      marker.hidden = false;
      marker.style.left = `${(Math.min(d.index, SCALE_MAX) / SCALE_MAX) * 100}%`;
    }
  } else if (sky.window !== 'now') {
    const el = $(report, '[data-r-index]');
    if (el) {
      delete el.dataset.value;
      rollText(el, '–');
    }
    setText(report, '[data-r-level]', '');
    setText(report, '[data-r-level-text]', `no account counts for ${WINDOW_INFO[sky.window].words} yet.`);
    const change = $(report, '[data-r-index-change]');
    if (change) chip(change, null);
    const note = $(report, '[data-r-index-note]');
    if (note) note.hidden = true;
    if (marker) marker.hidden = true;
  }
  const parts = $(report, '[data-r-acct-index]');
  if (!parts) return;
  if (sky.window === 'now') {
    parts.hidden = d?.share === undefined || d.spread === undefined;
    if (d?.share !== undefined && d.spread !== undefined) rollText(parts, diversityParts(d.share, d.spread, sky.accounts?.active));
  } else {
    parts.hidden = d?.share === undefined || !sky.accounts;
    if (d?.share !== undefined && sky.accounts) rollText(parts, `${formatIndex(d.share)}% of ${formatCount(sky.accounts.active)} active accounts over ${WINDOW_INFO[sky.window].words} wrote outside bluesky.`);
  }
}

/** Bluesky and everyone else: new records, or active accounts. */
function renderMix(report: HTMLElement, sky: Sky, lens: LensState): void {
  const tile = $(report, '.weather-mix');
  const a = lens.measure === 'accounts' ? sky.accounts : null;
  tag(tile, a ? 'accounts' : 'records', lens);
  const units = tile ? [...tile.querySelectorAll<HTMLElement>('[data-r-mix-unit]')] : [];
  const collections = $(report, '[data-r-collections-wrap]');
  if (a) {
    roll(report, '[data-r-ratio]', a.elsewhere <= 0 ? 'nobody active wrote outside bluesky' : a.elsewhere * 2 > a.active ? 'most active accounts wrote outside bluesky' : `1 in ${Math.round(a.active / a.elsewhere).toLocaleString('en-US')} active accounts wrote outside bluesky`);
    renderShare($(report, '[data-r-bar-bsky]'), $(report, '[data-r-bar-else]'), a.active > 0 ? (a.elsewhere / a.active) * 100 : 0);
    count(report, '[data-r-bsky]', a.bluesky, formatCount);
    count(report, '[data-r-else]', a.elsewhere, formatCount);
    count(report, '[data-r-total]', a.active, formatCount);
    roll(report, '[data-r-bsky-share]', formatShare(a.bluesky, a.active));
    roll(report, '[data-r-else-share]', formatShare(a.elsewhere, a.active));
    for (const u of units) u.textContent = 'accounts';
    setText(report, '[data-r-total-words]', 'different accounts wrote something in all');
    if (collections) collections.hidden = true;
    return;
  }
  const r = sky.records;
  if (!r) return;
  const v = (x: number) => amountIn(x, lens.unit, sky.seconds);
  roll(report, '[data-r-ratio]', ratioText(r));
  renderRatio($(report, '[data-r-bar-bsky]'), $(report, '[data-r-bar-else]'), r);
  count(report, '[data-r-bsky]', v(r.bluesky), formatAmount);
  count(report, '[data-r-else]', v(r.elsewhere), formatAmount);
  count(report, '[data-r-total]', v(r.perSecond), formatAmount);
  roll(report, '[data-r-bsky-share]', formatShare(r.bluesky, r.perSecond));
  roll(report, '[data-r-else-share]', formatShare(r.elsewhere, r.perSecond));
  for (const u of units) u.textContent = perWords(lens.unit);
  setText(report, '[data-r-total-words]', lens.unit === 'total' ? 'new records in all' : `${recordsPer(lens.unit)} in all`);
  if (collections) collections.hidden = sky.collections === null;
  if (sky.collections !== null) roll(report, '[data-r-collections]', sky.collections.toLocaleString('en-US'));
}

/** Elsewhere in the atmosphere: the busiest apps outside Bluesky, by records or by accounts. */
function renderElsewhere(report: HTMLElement, sky: Sky, lens: LensState): void {
  const tile = $(report, '.weather-apps');
  const byAcct = lens.measure === 'accounts' && sky.appsByAccounts !== null;
  tag(tile, byAcct ? 'accounts' : 'records', lens);
  const bars = topBars(
    byAcct
      ? sky.appsByAccounts!.map((x) => ({ label: x.domain, sub: x.collections.join(', '), perSecond: x.perSecond, count: x.count, value: formatCount(x.count), change: x.change }))
      : sky.apps.map((x) => ({ label: x.domain, sub: x.collections.join(', '), perSecond: x.perSecond, count: x.count, value: formatAmount(lens.unit === 'total' ? x.count : perUnit(x.perSecond, lens.unit)), change: x.change })),
  );
  const list = $(report, '[data-r-apps]');
  if (list) renderBars(list, bars, sky.window === 'now' && !byAcct ? sky.seconds : undefined);
  const shown = bars.length;
  const empty = $(report, '[data-r-apps-empty]');
  const n = sky.appsHeard;
  if (empty) {
    empty.hidden = shown > 0;
    empty.textContent = sky.window !== 'now' ? `the station hasn't heard any other apps over ${WINDOW_INFO[sky.window].words} yet.` : (n ?? 0) > 0 ? APPS_TRICKLE : APPS_EMPTY;
  }
  roll(report, '[data-r-apps-count]', n === null ? (shown ? `top ${shown}` : '') : n === 0 ? '' : `${n} app${n === 1 ? '' : 's'} heard${n > shown ? `, top ${shown}` : ''}`);
  const what = byAcct ? 'active accounts' : lens.unit === 'total' ? 'new records in all' : recordsPer(lens.unit);
  const arrows = !shown || !sky.earlier ? '' : bars.some((b) => b.change) ? ` arrows compare with ${sky.earlier}.` : ` once the station has heard ${sky.earlier}, arrows show who's rising and falling.`;
  setText(report, '[data-r-apps-note]', shown ? `${what}.${arrows}` : '');
}

/** Bluesky's busiest kinds of record: always records (the station doesn't count accounts by collection). */
function renderBluesky(report: HTMLElement, sky: Sky, lens: LensState): void {
  const tile = $(report, '.weather-bsky');
  tag(tile, 'records', lens);
  const list = $(report, '[data-r-bsky-list]');
  if (list && (sky.bluesky.length || sky.window !== 'now')) {
    renderBars(
      list,
      topBars(sky.bluesky.map((b) => ({ label: BLUESKY_NAMES[b.nsid] ?? b.nsid, sub: b.nsid, perSecond: b.perSecond, count: b.count, value: formatAmount(lens.unit === 'total' ? b.count : perUnit(b.perSecond, lens.unit)) }))),
      sky.window === 'now' ? sky.seconds : undefined,
    );
  }
  setText(
    report,
    '[data-r-bsky-note]',
    sky.window === 'now' ? `bluesky's busiest kinds of record, ${perWords(lens.unit)}.` : `posts, likes, reposts and follows over ${WINDOW_INFO[sky.window].words}, ${perWords(lens.unit)}.`,
  );
}

/** Every tile that follows the lens, from one sky. */
export function renderSky(report: HTMLElement, sky: Sky, lens: LensState = LENS_DEFAULT): void {
  renderHeadline(report, sky, lens);
  renderDiversity(report, sky, lens);
  renderMix(report, sky, lens);
  renderElsewhere(report, sky, lens);
  renderBluesky(report, sky, lens);
}

/**
 * A live reading: the weather you can see (the sky, the wind, the sun's rays) always, and
 * the tiles that follow the lens when it's on now. The stats tile keeps it for its minute.
 */
export function renderReport(report: HTMLElement, r: Reading, lens: LensState = LENS_DEFAULT): void {
  spinRays(report, recordsPerSecond(r));
  const sky = $(report, '[data-weather-sky]');
  if (sky && r.diversity) renderClouds(sky, cloudCount(r.diversity.index));
  // the weather you can see: wind, rain or snow (weather-hero.ts)
  const hero = $(report, '[data-weather-hero]');
  if (hero) hero.dataset.condition = r.condition;
  const air = $(report, '[data-weather-air]');
  if (air) renderAir(air, airNow(r.condition));
  if (lens.window === 'now') renderSky(report, skyOfReading(r), lens);
  renderHosts(report, r.hosts);

  // the last minute, unless the lens has moved its tile on to a longer window (weather-span.ts)
  const minute = $(report, '[data-s-tile]');
  if (minute) showLive(minute, r);

  if (report.dataset.state !== 'ready') setText(report, '[data-r-status]', `${CONDITION_TEXT[r.condition]}. diversity index ${r.diversity ? `${formatIndex(r.diversity.index)}, ${r.diversity.level}` : 'unknown'}.`);
  report.dataset.state = 'ready';
}

/** "1,797 independent, 90 bluesky's own": the active hosts, split. */
export function hostsSplit(h: Hosts): string {
  return `${formatCount(h.independent)} independent, ${formatCount(h.bluesky)} run by bluesky, of ${formatCount(h.listed)} the relay knows.`;
}

/** What the hosting diversity is made of, in a line: the share of accounts on independent hosts, and how spread out they are. */
export function hostsShare(h: Hosts): string {
  const total = h.accounts.bluesky + h.accounts.independent;
  if (h.accounts.independent <= 0) return `all ${formatCount(total)} accounts live on bluesky's hosts.`;
  const hosts = Math.max(1, Math.round(h.diversity.spread));
  return `${formatIndex(h.diversity.share)}% of ${compactCount(total)} accounts live on independent hosts, ${hosts === 1 ? 'nearly all on one' : `spread across about ${hosts} hosts' worth`}.`;
}

/** How long ago the station counted them: "counted just now", "counted 7 minutes ago". */
export function hostsAge(measuredAt: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(measuredAt)) / 60_000));
  return minutes < 1 ? 'counted just now' : `counted ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
}

/**
 * Where accounts live: the PDS hosts on the network, from the station's census of the
 * relay's list (every 10 minutes). It's a census, not a window, so it stays the latest
 * whatever the lens says, and the tile stays hidden until a reading carries one.
 */
export function renderHosts(report: HTMLElement, h: Hosts | undefined, now = Date.now()): void {
  const tile = $(report, '[data-r-hosts]');
  if (!tile || !h) return;
  tile.hidden = false;
  count(tile, '[data-h-active]', h.active, formatCount);
  roll(tile, '[data-h-split]', hostsSplit(h));
  setText(tile, '[data-h-age]', hostsAge(h.measuredAt, now));
  count(tile, '[data-h-index]', h.diversity.index, formatIndex);
  const writing = $(tile, '[data-h-writing-wrap]');
  if (writing) writing.hidden = h.writing === null;
  if (h.writing) {
    count(tile, '[data-h-writing]', h.writing.bluesky + h.writing.independent, formatCount);
    setText(tile, '[data-h-writing-words]', h.writing.minutes >= 60 ? 'wrote in the last hour' : `wrote in the last ${h.writing.minutes} minutes`);
  }
  renderShare($(tile, '[data-h-bar-bsky]'), $(tile, '[data-h-bar-else]'), h.diversity.share);
  roll(tile, '[data-h-share]', hostsShare(h));
  const list = $(tile, '[data-h-top]');
  if (list) renderBars(list, h.top.slice(0, LIST_TOP).map((x) => ({ label: x.hostname, perSecond: x.accounts, count: x.accounts, value: compactCount(x.accounts) })), undefined);
  renderHostCensus(report, h);
}

/** The size buckets' names, smallest first (server/atmosphere.ts HOST_SIZE_BOUNDS: 0, 1, ≤10, ≤100, ≤1,000, ≤10,000, more). */
export const HOST_SIZE_NAMES = ['empty', 'just one person', 'a household (2 to 10)', 'a village (11 to 100)', 'a town (101 to 1,000)', 'a city (1,001 to 10,000)', 'a metropolis (10,000+)'] as const;
const STATUS_NAMES: Record<string, string> = { active: 'active', idle: 'idle', offline: 'offline', throttled: 'throttled', banned: 'banned', other: 'something else' };

/** The ten biggest independent hosts' share of the accounts on independent hosts (null without any). */
export function topTenShare(h: Hosts): number | null {
  if (h.accounts.independent <= 0 || h.top.length === 0) return null;
  return (h.top.slice(0, 10).reduce((t, x) => t + x.accounts, 0) / h.accounts.independent) * 100;
}

/**
 * The census tiles in where the atmosphere lives: the accounts by the size of host they
 * live on (or the hosts, from a station that doesn't send accounts yet), and the census
 * strip: hosts by top-level domain, and the relay's roll call. Each stays hidden without its part.
 */
export function renderHostCensus(report: HTMLElement, h: Hosts): void {
  const bar = (label: string, v: number, value = formatCount(v)): Bar => ({ label, perSecond: v, count: v, value });
  const sizes = $(report, '[data-p-sizes]');
  if (sizes) sizes.hidden = !h.sizes;
  if (h.sizes) {
    const list = $(report, '[data-p-size-list]');
    const by = h.sizeAccounts;
    // empty hosts hold nobody and aren't much to look at; the rest, smallest first
    if (list) {
      renderBars(
        list,
        h.sizes.slice(1).map((hosts, i) => {
          const label = HOST_SIZE_NAMES[i + 1]!;
          if (!by) return bar(label, hosts, `${formatCount(hosts)} hosts`);
          const accounts = by[i + 1] ?? 0;
          return { ...bar(label, accounts, `${compactCount(accounts)} accounts`), sub: `${formatCount(hosts)} host${hosts === 1 ? '' : 's'}` };
        }),
        undefined,
      );
    }
    setText(report, '[data-p-size-note]', by ? "the accounts on independent hosts, by how big a host they live on. bluesky's own hosts hold hundreds of thousands each." : "independent hosts by how many accounts live on them. bluesky's own hosts hold hundreds of thousands each.");
    const top = topTenShare(h);
    const ten = Math.min(10, h.top.length);
    setText(report, '[data-p-top10]', top === null ? '' : `the ${ten} biggest independent hosts hold ${formatIndex(top)}% of the accounts on independent hosts; the other ${formatCount(Math.max(0, h.independent - ten))} share the rest.`);
    const solo = h.sizes[1] ?? 0;
    setText(report, '[data-p-solo]', `${formatCount(solo)} independent host${solo === 1 ? ' holds' : 's hold'} just one account: someone running their own.`);
  }
  const tlds = $(report, '[data-p-tlds]');
  if (tlds) tlds.hidden = !h.tlds?.length;
  if (h.tlds?.length) {
    const list = $(report, '[data-p-tld-list]');
    if (list) renderBars(list, h.tlds.map((t) => ({ ...bar(`.${t.tld}`, t.hosts, `${formatCount(t.hosts)} hosts`), sub: `${compactCount(t.accounts)} accounts` })), undefined);
    const top = h.tlds[0]!;
    setText(report, '[data-p-tld-lede]', `.${top.tld} is the most popular ending, on ${formatCount(top.hosts)} of ${formatCount(h.independent)} independent hosts.`);
  }
  const roll = $(report, '[data-p-rollcall]');
  if (roll) roll.hidden = !h.statuses;
  if (h.statuses) {
    const list = $(report, '[data-p-roll-list]');
    const entries = Object.entries(h.statuses).filter(([, v]) => v > 0);
    if (list) renderBars(list, entries.map(([k, v]) => bar(STATUS_NAMES[k] ?? k, v)), undefined);
    setText(report, '[data-p-roll-lede]', `the relay has heard of ${formatCount(h.listed)} hosts. ${formatCount(h.statuses.active)} are up and about right now.`);
  }
  const census = $(report, '[data-p-census]');
  if (census) census.hidden = !h.tlds?.length && !h.statuses;
}

/** A window's tiles, from its history. */
export function renderWindow(report: HTMLElement, h: History, lens: LensState, now: number = Date.now()): void {
  renderSky(report, skyOfHistory(h, now), lens);
}

/** What a diversity index is made of, in a line: its share of accounts, and how spread out they are (Poe has the rest, EXPLAINERS). */
export function diversityParts(share: number, spread: number, active?: number): string {
  const who = active ? `of ${formatCount(active)} active accounts` : 'of the accounts heard just now';
  if (share <= 0) return `none ${who} wrote outside bluesky.`;
  const apps = Math.max(1, Math.round(spread));
  return `${formatIndex(share)}% ${who} wrote outside bluesky, ${apps === 1 ? 'all in about one app' : `across about ${apps} apps`}.`;
}

/**
 * What the tiles' "what's this?" buttons ask Poe ([data-poe-explain]), and its answers,
 * written ahead of time in its voice: the chat opens on them (src/poe/say.ts explain).
 * They're Poe's own words, so they follow its copy rules (src/poe/copy.ts): lowercase, no
 * em dashes, no emoji; a kaomoji only at the very end.
 */
export const EXPLAINERS: Record<string, Pick<PoeExplanation, 'question' | 'answer'>> = {
  diversity: {
    question: "what's the diversity index?",
    answer: [
      "it's how much of the atmosphere isn't bluesky, going by who's writing rather than how much. one account dumping a thousand records still only counts once.",
      '',
      'i multiply two things:',
      '- the percent of accounts active in the last minute that wrote with lexicons outside `app.bsky.*` and `chat.bsky.*`',
      '- the square root of how many apps they\'re spread across. ten apps with the same number of people each count as ten, and one app with nearly everyone counts as about one',
      '',
      'so a crowd spread over lots of apps scores higher than the same crowd piled into one.',
      '',
      "it reads like the uv index: 0 to 2 is low, 3 to 5 moderate, 6 and 7 high, 8 to 10 very high, and 11 and up extreme. a usual minute sits around 2 right now, so it's mostly bluesky out there. for now (◕‿◕)",
    ].join('\n'),
  },
  hosts: {
    question: 'what are pds hosts?',
    answer: [
      "a pds (personal data server) is where an account's records actually live. bluesky runs about ninety of them, and anyone else can run one too: a community, a company, or one person with a little server in a cupboard.",
      '',
      "every ten minutes i read the relay's list of every host it knows about:",
      '- active hosts are the ones the relay is happily listening to right now',
      "- wrote lately means a host sent the relay anything since i last looked, within the hour",
      "- hosting diversity works like the diversity index: the percent of accounts living outside bluesky's hosts, times the square root of how many hosts they're spread across. bluesky's own hosts count as one place",
      '',
      "it goes by where accounts live, not who's writing this minute, so it's its own number and moves slowly. a bigger number means more of the network lives somewhere other than bluesky (◕‿◕)",
    ].join('\n'),
  },
  arrivals: {
    question: 'where do new accounts come from?',
    answer: [
      "every account in the atmosphere gets an identity in the plc directory, a public log that says which pds it lives on. i read that log as it goes, so i can count new accounts as they arrive.",
      '',
      "- on bluesky's hosts: people signing up through the bluesky app",
      "- on independent hosts: people signing up anywhere else the relay listens to, like a community's own server or one somebody runs for themselves",
      "- own domain: new accounts that start out with a handle like yourname.com instead of one their host hands out",
      '',
      "sign-ups to hosts the relay doesn't carry don't count here. they go in the air quality instead (◕‿◕)",
    ].join('\n'),
  },
  winds: {
    question: 'what are migration winds?',
    answer: [
      "in the atmosphere you can pack up your account and move it to a different pds, and keep your handle, your posts and everyone who follows you. the plc directory notes every move, so i count them:",
      '',
      "- out of bluesky: an account moving from bluesky's hosts to an independent one",
      '- back in: the other way round',
      '- host to host: moving between two independent hosts',
      '',
      "when more blow out than back in, the wind is blowing out of bluesky. i only count moves between hosts the relay listens to (◕‿◕)",
    ].join('\n'),
  },
  smog: {
    question: "what's the air quality?",
    answer: [
      "anyone can make an identity in the plc directory pointing at any server at all, so lots of new accounts land on hosts the relay doesn't carry: test servers, typos, and bulk sign-ups to one-off domains.",
      '',
      "air quality is the share of each day's sign-ups that went somewhere like that. under 10% is clear, then hazy, smoggy from half, and thick smog from 90%.",
      '',
      "it's not the network's real weather, more like dust in the air. none of it reaches your feed (◕‿◕)",
    ].join('\n'),
  },
  readouts: {
    question: 'what do feels like, gusts, humidity and visibility mean?',
    answer: [
      "they're my take on a weather app's details, from the last minute, or whichever window the bar up top is on: the last hour, day, week or month:",
      '',
      "- feels like: new posts a second. likes and follows are most of the records, but posts are what you actually feel when you scroll",
      '- gusts: the busiest single second of the minute, or the busiest minute of the hour, or hour of the day or week. when a bot dumps a pile of records at once, it shows up here first',
      '- humidity: edits and deletions as a share of everything written. a muggy minute is one where people are second-guessing themselves',
      "- visibility: how many apps outside bluesky wrote anything. on a clear day you can see a long way past bluesky",
      '',
      "the little arrows say how each number did against the minute, hour, day, week or month before. none of these are official anything. i made them up, but the numbers are real (◕‿◕)",
    ].join('\n'),
  },
  forecast: {
    question: 'how does the forecast work?',
    answer: [
      "it's a real forecast, not just what's usual. three things go into it:",
      '',
      "- usual: what each hour of the day has looked like over the last two weeks, nudged toward that hour of the week once i've heard a few of them. i take the middle value, so one bot's burst doesn't become normal",
      "- running: how far the last day has run from usual. if the whole network is having a busy day, the forecast stays busy too",
      "- memory: how long a busy or quiet spell tends to last. right now's difference from usual fades out hour by hour, as fast as it has in the past",
      '',
      "then i play the next 12 hours forward a few hundred times, each hour wobbling by as much as my own past misses did. the shaded band is where 8 runs in 10 land, and the chance of a storm is how many runs went past 600 new records a second.",
      '',
      "network sunrise is when the usual day climbs past halfway between its quietest and busiest hours, and sunset is when it falls back. underneath, i keep score: how far off my forecasts for the next hour have been, against just going by usual (◕‿◕)",
    ].join('\n'),
  },
};

/** The tiles' "what's this?" buttons: Poe opens its chat on the answer. A button with no answer here stays hidden. */
export function bindExplainers(root: ParentNode): void {
  for (const button of Array.from(root.querySelectorAll<HTMLElement>('[data-poe-explain]'))) {
    const answer = EXPLAINERS[button.dataset.poeExplain ?? ''];
    button.hidden = !answer;
    if (!answer) continue;
    button.addEventListener('click', (event) => {
      explain({ ...answer, opener: button, via: event.detail === 0 ? 'keyboard' : 'pointer' });
    });
  }
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
  /** Bluesky's other big kinds of record, when the server sent them. */
  likes?: number;
  reposts?: number;
  follows?: number;
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
  /** The PDS hosts over the range, from the station's censuses (server/weather-hosts.ts). */
  hosts?: HostHistory;
}

export interface AccountCounts {
  active: number;
  bluesky: number;
  elsewhere: number;
  /** The diversity index these accounts make (server/weather-accounts.ts), when the server sent it. */
  index?: number;
}

export interface HistoryAccounts {
  /** How much of the range, and of the earlier window, the station heard counting accounts. */
  seconds: number;
  prevSeconds: number;
  /** Everyone active over the whole range: fewer than the buckets add up to. */
  total: AccountCounts;
  /** Everyone active in the earlier window, and the seconds the station heard of it, when it kept their sketches. */
  prev?: AccountCounts & { seconds: number };
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
    const body = (await res.json()) as { range?: unknown; points?: unknown; total?: unknown; apps?: unknown; compare?: unknown; appsOverTime?: unknown; accounts?: unknown; hosts?: unknown };
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
    const hosts = toHostHistory(body.hosts);
    if (hosts) history.hosts = hosts;
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
  const withIndex = (c: AccountCounts): AccountCounts => ({ active: c.active, bluesky: c.bluesky, elsewhere: c.elsewhere, ...(n(c.index) ? { index: c.index } : {}) });
  const prevSeconds = typeof r.prev === 'object' && r.prev !== null ? (r.prev as Record<string, unknown>).seconds : undefined;
  const prev = isCounts(r.prev) && n(prevSeconds) ? { seconds: prevSeconds, ...withIndex(r.prev) } : null;
  return {
    seconds: r.seconds,
    prevSeconds: r.prevSeconds,
    total: withIndex(r.total),
    ...(prev ? { prev } : {}),
    points: r.points
      .filter((p): p is HistoryAccounts['points'][number] => {
        const v = p as Record<string, unknown>;
        return isCounts(p) && typeof v.t === 'string' && Number.isFinite(Date.parse(v.t)) && n(v.seconds);
      })
      .map((p) => ({ t: p.t, seconds: p.seconds, ...withIndex(p) })),
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

/** A diversity index within this of the earlier one reads as about the same. */
export const INDEX_STEADY = 0.05;

/**
 * The diversity index against the earlier window's, in percent. Like accounts, only when
 * the station heard both windows about as well; null otherwise.
 */
export function indexChange(a: HistoryAccounts, earlier: string): Change | null {
  const p = a.prev;
  if (!p || a.total.index === undefined || p.index === undefined) return null;
  if (a.seconds <= 0 || p.seconds < a.seconds * 0.9 || p.seconds > a.seconds * 1.1) return null;
  const c = percentChange(a.total.index, p.index, earlier);
  // the index wanders a few percent on its own, so that much is the same sky
  return c && Math.abs(a.total.index / p.index - 1) < INDEX_STEADY ? { text: '→', words: `about the same as ${earlier}`, trend: 'steady' } : c;
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

/** Records and posts a second of a point (null when it covers nothing). */
export function ratesOf(p: HistoryPoint): { records: number | null; posts: number | null } {
  if (p.seconds <= 0) return { records: null, posts: null };
  return { records: p.creates / p.seconds, posts: p.posts / p.seconds };
}

export function trendSummary(h: History, unit: Unit = 'second'): string {
  const info = RANGE_INFO[h.range];
  const { records } = ratesOf(h.total);
  if (records === null) return `no readings yet for ${info.words}. the station fills this in as it goes.`;
  const covered = h.total.seconds < (info.spanMs / 1000) * 0.9 ? ` (from ${coverageWords(h.total.seconds)} of readings so far)` : '';
  const index = h.accounts && h.accounts.seconds > 0 ? h.accounts.total.index : undefined;
  const idx = index === undefined ? '' : `, diversity index ${formatIndex(index)}`;
  const amount = unit === 'total' ? `${formatAmount(h.total.creates)} new records` : `${rateIn(records, unit)} ${recordsPer(unit)}`;
  return `${info.words}${covered}: ${amount}${idx}.`;
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

/** The range the trends draw for the lens's window: now has no history of its own, so it's the last hour. */
export const trendsRange = (window: Window): Range => (window === 'now' ? 'hour' : window);

/** A chart's step as a unit, for "total": each point's own count. */
const BUCKET_UNIT: Record<Bucket, RateUnit> = { minute: 'minute', hour: 'hour', day: 'day', month: 'day' };

/** The trends, by records or by accounts: the summary (for screen readers), two charts and apps heard. */
export function renderTrends(section: HTMLElement, h: History, now = Date.now(), measure: Measure = 'records', unit: Unit = 'second'): void {
  const info = RANGE_INFO[h.range];
  const fmt = new Intl.DateTimeFormat(undefined, info.time);
  const formatTime = (t: number) => fmt.format(new Date(t)).toLowerCase();
  section.dataset.measure = measure;
  setText(section, '[data-t-range]', info.words);
  if (measure === 'accounts') renderAccountTrends(section, h, now, formatTime);
  else renderRecordTrends(section, h, now, formatTime, unit);
  renderAppsOverTime(section, h, now, formatTime);
  // The charts say it all on screen; the sentence stays for screen readers, read out when the range changes.
  $(section, '[data-t-summary]')?.classList.add('visually-hidden');
  section.dataset.state = 'ready';
}

function renderRecordTrends(section: HTMLElement, h: History, now: number, formatTime: TimeFormat, unit: Unit): void {
  const info = RANGE_INFO[h.range];
  setText(section, '[data-t-summary]', trendSummary(h, unit));
  // "total" is each point's own count: new records each minute, hour or day
  const each = unit === 'total' ? BUCKET_UNIT[BUCKET_OF[h.range]] : null;
  const title = each ? `new records each ${each}` : recordsPer(unit as RateUnit);
  setChartTitle(section, 'records', title);
  setChartTitle(section, 'index', 'diversity index');
  const per = each ? null : UNIT_SECONDS[unit as RateUnit];
  const rows = h.points.map((p) => ({ t: Date.parse(p.t), v: per === null ? (p.seconds > 0 ? p.creates : null) : ratesOf(p).records === null ? null : ratesOf(p).records! * per }));
  // the index goes by accounts, which come in buckets of their own
  const step = BUCKET_MS[BUCKET_OF[h.range]];
  const indexes = (h.accounts?.points ?? []).map((p) => ({ t: Date.parse(p.t), v: p.index ?? null }));
  const records = $(section, '[data-t-chart="records"]');
  const index = $(section, '[data-t-chart="index"]');
  // each step's own count dips while the newest step fills up, so that one is an estimate; a rate doesn't
  const recordPoints = [...lead(h, rows[0]?.t, now, info.stepMs), ...rows];
  const heardMs = (h.points[h.points.length - 1]?.seconds ?? 0) * 1000;
  if (records) renderChart(records, each ? projectLast(recordPoints, now, info.stepMs, { heardMs }) : recordPoints, { label: title, color: 'var(--weather-bsky)', format: formatAmount, formatTick: (v) => (v >= 10_000 ? compactCount(v) : formatRate(v)), formatTime, stepMs: info.stepMs });
  if (index) renderChart(index, [...lead(h, indexes[0]?.t, now, step), ...indexes], { label: 'diversity index', color: 'var(--weather-else)', format: formatIndex, formatTick: (v) => String(Number(v.toFixed(2))), formatTime, stepMs: step });
}

function renderAccountTrends(section: HTMLElement, h: History, now: number, formatTime: TimeFormat): void {
  const a = h.accounts;
  const bucket = BUCKET_OF[h.range];
  const step = BUCKET_MS[bucket];
  const each = `each ${BUCKET_WORDS[bucket]}`;
  setText(section, '[data-t-summary]', accountSummary(h));
  setChartTitle(section, 'records', `active accounts ${each}`);
  setChartTitle(section, 'index', 'share of accounts writing elsewhere');
  const rows = (a?.points ?? []).map((p) => ({ ...p, t: Date.parse(p.t), share: p.active > 0 ? (p.elsewhere / p.active) * 100 : null }));
  // the newest bucket is still filling up: an estimate for its accounts, its share as it is so far
  const heardMs = (rows[rows.length - 1]?.seconds ?? 0) * 1000;
  const pts = (v: (r: (typeof rows)[number]) => number | null, scale: boolean): ChartPoint[] =>
    projectLast([...lead(h, rows[0]?.t, now, step), ...rows.map((r) => ({ t: r.t, v: v(r) }))], now, step, { scale, heardMs, exponent: a ? accountsExponent(a) : 1 });
  const active = $(section, '[data-t-chart="records"]');
  const share = $(section, '[data-t-chart="index"]');
  const percent = (v: number) => `${formatIndex(v)}%`;
  if (active) renderChart(active, pts((r) => r.active, true), { label: `active accounts ${each}`, color: 'var(--weather-bsky)', format: formatCount, formatTick: compactCount, formatTime, stepMs: step });
  if (share) renderChart(share, pts((r) => r.share, false), { label: 'share of accounts writing elsewhere', color: 'var(--weather-else)', format: percent, formatTick: (v) => `${Number(v.toFixed(2))}%`, formatTime, stepMs: step });
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
  // The newest bucket is still filling up; most apps turn up early in one, so it's not scaled, only marked so far.
  renderChart(host, projectLast(points, now, step, { scale: false }), { label: `apps heard each ${BUCKET_WORDS[o.bucket]}`, color: 'var(--weather-else)', format: (v) => String(Math.round(v)), formatTime, stepMs: step });
}

/** Histories by range, shared by the trends and the window's tiles: one request each, however many ask. */
export interface HistoryFeed {
  /** The range's history, from the last one if it's under `maxAgeMs` old. */
  get(range: Range, maxAgeMs?: number): Promise<History | null>;
}

export function createHistoryFeed(fetchImpl: typeof fetch = fetch): HistoryFeed {
  const kept = new Map<Range, { at: number; history: History }>();
  const asking = new Map<Range, Promise<History | null>>();
  return {
    get(range, maxAgeMs = 30_000) {
      const had = kept.get(range);
      if (had && Date.now() - had.at < maxAgeMs) return Promise.resolve(had.history);
      const already = asking.get(range);
      if (already) return already;
      const asked = fetchHistory(range, fetchImpl).then((h) => {
        asking.delete(range);
        if (h) kept.set(range, { at: Date.now(), history: h });
        return h;
      });
      asking.set(range, asked);
      return asked;
    },
  };
}

/** How often a window's history is asked for again: every minute for the last hour, else every 5. */
export const historyRefreshMs = (range: Range) => (range === 'hour' ? 60_000 : 300_000);

/**
 * The first load, the lens's window and measure, and a refresh while the tab is visible
 * (historyRefreshMs). Switching records and accounts, or the unit, redraws what's
 * loaded: one answer has both. A refresh is quiet: the charts don't dim while it's out,
 * and if it fails the charts already drawn stay.
 */
export function initTrends(section: HTMLElement, feed: HistoryFeed, lens?: Lens): void {
  const view = () => lens?.get() ?? LENS_DEFAULT;
  let asked = 0;
  let shown: History | null = null;
  const draw = (h: History) => renderTrends(section, h, Date.now(), view().measure, view().unit);
  const load = async (quietly = false) => {
    const range = trendsRange(view().window);
    const mine = ++asked;
    const ready = section.dataset.state === 'ready';
    if (!(quietly && ready)) section.dataset.state = ready ? 'refreshing' : 'loading';
    const history = await feed.get(range, quietly ? historyRefreshMs(range) - 5_000 : 30_000);
    if (mine !== asked) return; // a newer range took over
    if (!history && quietly && ready && shown?.range === range) return;
    shown = history;
    if (history) draw(history);
    else {
      section.dataset.state = 'error';
      const summary = $(section, '[data-t-summary]');
      if (summary) {
        summary.textContent = 'the records are hard to read right now. try again in a bit.';
        summary.classList.remove('visually-hidden');
      }
    }
  };
  lens?.onChange((l, was) => {
    if (trendsRange(l.window) !== trendsRange(was.window)) void load();
    else if (shown) draw(shown);
  });
  void load();
  const tick = () =>
    window.setTimeout(
      () => {
        if (document.visibilityState !== 'hidden') void load(true);
        tick();
      },
      historyRefreshMs(trendsRange(view().window)),
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
  const desk = createAlertDesk();
  bindHush(root, desk);
  bindExplainers(root);
  const lens = createLens();
  initLensDock(report, lens);
  initHostPanel(report, fetchImpl);
  bindLens(report, lens);
  const feed = createHistoryFeed(fetchImpl);
  let watch: Watch | null = null;
  const hero = $(report, '[data-weather-hero]');
  if (hero) initHero(hero);
  let rainbowAt = -Infinity;
  // the busiest minute on record, from the almanac, raised by any live minute that beats it
  let record: number | null = null;
  let shown: Reading | null = null;
  // the last page's reading, until this one's comes (alerts only ever compare fresh ones)
  const stored = storedReading();
  if (stored) {
    shown = stored;
    renderReport(report, stored, lens.get());
  }
  const load = async () => {
    const reading = await fetchReading(fetchImpl);
    if (reading) {
      shown = reading;
      renderReport(report, reading, lens.get());
      // a storm that clears leaves a rainbow, now and then
      if (hero && clearedUp(watch?.condition, reading.condition) && Date.now() - rainbowAt >= RAINBOW_COOLDOWN_MS) {
        rainbowAt = Date.now();
        showRainbow(hero);
      }
      const next = alertsFor(watch, reading);
      watch = next.watch;
      for (const a of next.alerts) desk.push(a);
      const beaten = recordAlert(record, reading);
      if (beaten) {
        desk.push(beaten);
        record = recordsPerSecond(reading);
      }
    } else if (lens.get().window === 'now') renderReportError(report);
    every = reading?.source === 'station' ? LIVE_REFRESH_MS : REFRESH_MS;
  };
  const tick = () =>
    window.setTimeout(async () => {
      if (document.visibilityState !== 'hidden') await load();
      tick();
    }, every);
  void load().then(tick);

  // a window: its history, shared with the trends, while the live reading keeps the sky turning
  let windowShown: History | null = null;
  let windowAsked = 0;
  const showWindow = async (quietly = false) => {
    const { window: w } = lens.get();
    const mine = ++windowAsked;
    if (w === 'now') {
      report.dataset.lensState = 'ready';
      if (shown) renderSky(report, skyOfReading(shown), lens.get());
      return;
    }
    if (!quietly) report.dataset.lensState = 'loading';
    const history = await feed.get(w, quietly ? historyRefreshMs(w) - 5_000 : 30_000);
    if (mine !== windowAsked) return; // the lens moved on
    if (history) {
      windowShown = history;
      renderWindow(report, history, lens.get());
      report.dataset.lensState = 'ready';
    } else if (!quietly || windowShown?.range !== w) {
      report.dataset.lensState = 'error';
      setText(report, '[data-r-cond]', `${WINDOW_INFO[w].words} is hard to read right now. try again in a bit.`);
    }
  };
  const minute = $(report, '[data-s-tile]');
  const span = minute ? initSpan(minute, fetchImpl, { span: spanFor(lens.get().window), unit: lens.get().unit, onChanges: (c) => renderHeadlineChange(report, c) }) : null;
  lens.onChange((l, was) => {
    span?.setSpan(spanFor(l.window));
    span?.setUnit(l.unit);
    if (l.window !== was.window) void showWindow();
    else if (l.window === 'now') {
      if (shown) renderSky(report, skyOfReading(shown), l);
    } else if (windowShown?.range === l.window) renderWindow(report, windowShown, l);
  });
  if (lens.get().window !== 'now') void showWindow();
  const windowTick = () =>
    window.setTimeout(
      async () => {
        if (document.visibilityState !== 'hidden' && lens.get().window !== 'now') await showWindow(true);
        windowTick();
      },
      historyRefreshMs(trendsRange(lens.get().window)),
    );
  windowTick();

  const trends = $(report, '[data-r-trends]');
  if (trends) initTrends(trends, feed, lens);
  initHostTrends(report, feed, lens, (list, bars) => renderBars(list, bars, undefined), watchHosts(desk));
  const newApps = watchNewApps(desk);
  initAlmanac(
    report,
    fetchImpl,
    (a) => {
      newApps(a);
      const best = recordHigh(a)?.perSecond;
      if (best !== undefined) record = Math.max(record ?? 0, best);
    },
    lens,
  );
  initForecast(report, fetchImpl, readerTimeZone(), lens);
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

/** The "hush weather alerts" button in "how i measure it", kept in step with the desk. */
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

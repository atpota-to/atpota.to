/**
 * The weather report's almanac (weather/index.html), from /api/weather-almanac
 * (server/weather-almanac.ts) in the reader's own time zone:
 *
 *   today so far          the last hour against usual, in words ("busier than usual for a
 *                         tuesday afternoon" once the station has heard a few of those, "for
 *                         this time of day" after a day) and on a little barometer; the high
 *                         and low (the busiest and quietest whole minute, by new records a
 *                         second, every app) as a range with the last hour on it; and the
 *                         day's totals
 *   new in the atmosphere apps heard for the first time in the last 24 hours, after the
 *                         station's first week (until then it says it's warming up), as a
 *                         word cloud sized by records, each name a link to its lexicons in
 *                         Aturi, with a card of details on hover
 *   when the sky is busiest
 *                         new records a second for every hour of the week, as a heat map;
 *                         it only names the busiest and quietest hours after a few weeks
 *   records               in today so far: the busiest minute the station has heard and the
 *                         most apps in a minute, since it started listening live; today's
 *                         high says so when it's the record (recordHigh)
 *
 * Checks again every minute while the tab is visible; the numbers roll to each new answer
 * (roll.ts). App and collection names are other people's text and only reach the DOM
 * through textContent.
 */

import { rollText } from './roll';
import { rateUnit, recordsPer, UNIT_INFO, wholeRate, type Lens, type RateUnit } from './weather-lens';

export const ALMANAC_ENDPOINT = '/api/weather-almanac';
export const ALMANAC_REFRESH_MS = 60_000;
/** Aturi's page for a namespace's lexicons (aturi.to, src/app/explore/lexicons/group). */
export const ATURI_LEXICONS = 'https://aturi.to/explore/lexicons/group/';
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** Weeks of readings before the heat map names its busiest and quietest hours. */
export const HEAT_READY_WEEKS = 3;
/** A cell needs this many seconds heard to get a colour. */
export const HEAT_MIN_SECONDS = 600;

interface Sums {
  seconds: number;
  posts: number;
  creates: number;
  elsewhere: number;
}

export interface Almanac {
  tz: string;
  today?: Sums & { start: string; high: Extreme | null; low: Extreme | null };
  normal?: { historyStart: string | null; now: Sums; days: Sums & { windows: number }; weeks: Sums & { windows: number }; diversity?: NormalDiversity };
  newApps?: { historyStart: string | null; readyAt: string | null; warmingUp: boolean; heard: number; apps: NewApp[] };
  heatmap?: { seconds: number; cells: HeatCell[] };
  records?: { since: string; busiest: Extreme | null; mostApps: { minute: string; apps: number } | null };
}

/** The diversity index of the last whole hour, and on average of the same hour on the days and weeks before (server/weather-almanac.ts readDiversity). */
export interface NormalDiversity {
  hour: string;
  now: { index: number; share: number; spread: number; elsewhere: number };
  days: { windows: number; index: number };
  weeks: { windows: number; index: number };
}

export interface Extreme {
  minute: string;
  perSecond: number;
}

export interface NewApp {
  domain: string;
  firstSeen: string;
  creates: number;
  collections: string[];
}

export interface HeatCell {
  dow: number;
  hour: number;
  seconds: number;
  posts: number;
  creates: number;
}

// ---------- reading the answer ----------

const n = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const obj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const date = (x: unknown): x is string => typeof x === 'string' && Number.isFinite(Date.parse(x));
const sums = (x: unknown): x is Sums => obj(x) && n(x.seconds) && n(x.posts) && n(x.creates) && n(x.elsewhere);
const NAME_RE = /^[a-z0-9][a-z0-9.-]{0,252}$/i;
const name = (x: unknown): x is string => typeof x === 'string' && NAME_RE.test(x);
const extreme = (x: unknown): Extreme | null => (obj(x) && date(x.minute) && n(x.perSecond) ? { minute: x.minute, perSecond: x.perSecond } : null);

/** Keeps the parts that check out; a part that doesn't is left out, like a part the server couldn't get. */
export function readAlmanac(body: unknown): Almanac | null {
  if (!obj(body) || typeof body.tz !== 'string') return null;
  const out: Almanac = { tz: body.tz };
  const t = body.today;
  if (obj(t) && sums(t) && date(t.start)) {
    out.today = { seconds: t.seconds, posts: t.posts, creates: t.creates, elsewhere: t.elsewhere, start: t.start, high: extreme(t.high), low: extreme(t.low) };
  }
  const nm = body.normal;
  const windows = (x: unknown): x is Sums & { windows: number } => sums(x) && n((x as unknown as Record<string, unknown>).windows);
  if (obj(nm) && sums(nm.now) && windows(nm.days) && windows(nm.weeks)) {
    out.normal = { historyStart: date(nm.historyStart) ? nm.historyStart : null, now: nm.now, days: nm.days, weeks: nm.weeks };
    const d = nm.diversity;
    const usual = (x: unknown): x is { windows: number; index: number } => obj(x) && n(x.windows) && n(x.index);
    if (obj(d) && date(d.hour) && obj(d.now) && n(d.now.index) && n(d.now.share) && n(d.now.spread) && n(d.now.elsewhere) && usual(d.days) && usual(d.weeks)) {
      const now = { index: d.now.index, share: d.now.share, spread: d.now.spread, elsewhere: d.now.elsewhere };
      out.normal.diversity = { hour: d.hour, now, days: { windows: d.days.windows, index: d.days.index }, weeks: { windows: d.weeks.windows, index: d.weeks.index } };
    }
  }
  const na = body.newApps;
  if (obj(na) && typeof na.warmingUp === 'boolean' && n(na.heard) && Array.isArray(na.apps)) {
    out.newApps = {
      historyStart: date(na.historyStart) ? na.historyStart : null,
      readyAt: date(na.readyAt) ? na.readyAt : null,
      warmingUp: na.warmingUp,
      heard: na.heard,
      apps: na.apps.filter(
        (a): a is NewApp => obj(a) && name(a.domain) && date(a.firstSeen) && n(a.creates) && Array.isArray(a.collections) && a.collections.every(name),
      ),
    };
  }
  const hm = body.heatmap;
  if (obj(hm) && n(hm.seconds) && Array.isArray(hm.cells)) {
    out.heatmap = {
      seconds: hm.seconds,
      cells: hm.cells.filter(
        (c): c is HeatCell => obj(c) && n(c.dow) && n(c.hour) && n(c.seconds) && n(c.posts) && n(c.creates) && c.dow >= 1 && c.dow <= 7 && c.hour <= 23,
      ),
    };
  }
  const rc = body.records;
  if (obj(rc) && date(rc.since)) {
    const most = rc.mostApps;
    out.records = { since: rc.since, busiest: extreme(rc.busiest), mostApps: obj(most) && date(most.minute) && n(most.apps) ? { minute: most.minute, apps: most.apps } : null };
  }
  return out;
}

export function readerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export async function fetchAlmanac(tz: string, fetchImpl: typeof fetch = fetch): Promise<Almanac | null> {
  try {
    const res = await fetchImpl(`${ALMANAC_ENDPOINT}?tz=${encodeURIComponent(tz)}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return readAlmanac(await res.json());
  } catch {
    return null;
  }
}

// ---------- words ----------

/** "3:14 pm" in the reader's zone. */
export function clock(iso: string, tz?: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).toLowerCase();
}

/** "1.6 million", "171,986". */
export function bigNumber(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)} billion`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} million`;
  return Math.round(v).toLocaleString('en-US');
}

/** The part of the day an hour falls in, for "a tuesday afternoon". */
export function daypart(hour: number): string {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

function local(nowMs: number, tz: string | undefined, opts: Intl.DateTimeFormatOptions): string {
  return new Date(nowMs).toLocaleString('en-US', { ...opts, timeZone: tz }).toLowerCase();
}

/** How long, in rough words: "3 days", "1 hour", "40 minutes". */
export function roughly(ms: number): string {
  const units: Array<[string, number]> = [
    ['day', DAY],
    ['hour', HOUR],
    ['minute', 60_000],
  ];
  for (const [unit, size] of units) {
    const v = Math.floor(ms / size);
    if (v >= 1) return `${v} ${unit}${v === 1 ? '' : 's'}`;
  }
  return 'under a minute';
}

export interface Usual {
  headline: string;
  detail: string;
  /** The last hour's records a second over usual's; null while there's nothing to compare with. */
  ratio: number | null;
}

/**
 * Where "much quieter", "quieter", "about as busy", "busier" and "much busier" than usual
 * meet, as the last hour over usual. The words and the barometer's zones both use them.
 */
export const USUAL_EDGES = [0.8, 0.93, 1.08, 1.25] as const;

/**
 * The last hour against usual, in words. "weeks" (the same weekday) once the station has
 * heard one; "days" (the same hour on other days) before that; null with a reason when
 * there's nothing to compare with yet.
 */
export function usualText(normal: NonNullable<Almanac['normal']>, nowMs: number, tz?: string, unit: RateUnit = 'second'): Usual {
  const now = normal.now;
  const basis = normal.weeks.windows > 0 ? 'weeks' : normal.days.windows > 0 ? 'days' : null;
  const listening = normal.historyStart ? nowMs - Date.parse(normal.historyStart) : 0;
  if (!basis || now.seconds < 1800) {
    return {
      headline: 'the station is still learning what usual looks like',
      detail: `it's been listening for ${roughly(listening)}. after a day it can compare with this time yesterday, and after a week with a usual ${local(nowMs, tz, { weekday: 'long' })}.`,
      ratio: null,
    };
  }
  const base = normal[basis];
  const rate = now.creates / now.seconds;
  const usual = base.creates / base.seconds;
  const ratio = usual > 0 ? rate / usual : 1;
  const [muchQuieter, quieter, busier, muchBusier] = USUAL_EDGES;
  const how =
    ratio >= muchBusier
      ? 'much busier than usual'
      : ratio >= busier
        ? 'busier than usual'
        : ratio <= muchQuieter
          ? 'much quieter than usual'
          : ratio <= quieter
            ? 'quieter than usual'
            : 'about as busy as usual';
  const weekday = local(nowMs, tz, { weekday: 'long' });
  const hour = Number(new Date(nowMs).toLocaleString('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }));
  const when = basis === 'weeks' ? `for a ${weekday} ${daypart(hour % 24)}` : 'for this time of day';
  const over =
    basis === 'weeks' ? (base.windows === 1 ? `last ${weekday}` : `the last ${base.windows} ${weekday}s`) : base.windows === 1 ? 'yesterday' : `the last ${base.windows} days`;
  let detail = `${wholeRate(rate, unit)} ${recordsPer(unit)} over the last hour; usually about ${wholeRate(usual, unit)} at this hour (${over}).`;
  // The diversity index against usual, by the hour, when both sides have enough to say.
  const d = normal.diversity;
  const was = d?.[basis];
  if (d && was && was.windows > 0 && was.index > 0 && d.now.elsewhere >= 50) {
    const mix = d.now.index / was.index;
    if (mix >= 1.3) detail += ' a more mixed sky than usual, too.';
    else if (mix <= 0.77) detail += ' a little less mixed than usual.';
  }
  if (basis === 'days') detail += ` in a week it'll compare with ${weekday}s.`;
  return { headline: `${how} ${when}`, detail, ratio };
}

// ---------- today so far ----------

const $ = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T>(sel);
function setText(root: ParentNode, sel: string, text: string): void {
  const el = $(root, sel);
  if (el) el.textContent = text;
}

/** Like setText, rolling the numbers in it. */
function roll(root: ParentNode, sel: string, text: string): void {
  const el = $(root, sel);
  if (el) rollText(el, text);
}

/**
 * Where a ratio to usual sits on the barometer, 0 (the left end) to 1 (the right): on a log
 * scale, so half as busy and twice as busy are as far from usual, and the ends are about
 * 30% quieter and 40% busier. Past those the needle rests on the stop.
 */
export function gaugeAt(ratio: number): number {
  return ratio > 0 ? Math.min(1, Math.max(0, Math.log2(ratio) + 0.5)) : 0;
}

/** "+18%", "−7%", "±0%". */
export function changeText(ratio: number): string {
  const pct = Math.round((ratio - 1) * 100);
  return pct > 0 ? `+${pct}%` : pct < 0 ? `−${-pct}%` : '±0%';
}

/** Where a value sits between today's low and high, 0 to 1; the middle when they're the same. */
export function rangeAt(v: number, low: number, high: number): number {
  if (!(high > low)) return 0.5;
  return Math.min(1, Math.max(0, (v - low) / (high - low)));
}

const SVG = 'http://www.w3.org/2000/svg';
/** The barometer's dial, in its own units: a half circle around (CX, CY). */
const CX = 60;
const CY = 58;
const R = 46;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** The dial's arc from a to b (0 to 1, left to right over the top). */
function arc(a: number, b: number): string {
  const at = (t: number) => {
    const angle = Math.PI * (1 - t);
    return `${(CX + R * Math.cos(angle)).toFixed(2)} ${(CY - R * Math.sin(angle)).toFixed(2)}`;
  };
  return `M${at(a)}A${R} ${R} 0 0 1 ${at(b)}`;
}

/**
 * The barometer: five zones, from much quieter to much busier than usual (USUAL_EDGES),
 * deeper for busier like the heat map, and a needle at the last hour. Drawn once; after
 * that only the needle moves. While there's nothing to compare with, it waits, needleless.
 */
export function renderGauge(host: HTMLElement, ratio: number | null): void {
  if (!host.firstElementChild) {
    const dial = svg('svg', { viewBox: '-8 0 136 78', class: 'weather-gauge__svg' });
    const edges = [0, ...USUAL_EDGES.map(gaugeAt), 1];
    const gap = 0.012;
    for (let i = 0; i < 5; i++) {
      const a = edges[i]! + (i > 0 ? gap : 0);
      const b = edges[i + 1]! - (i < 4 ? gap : 0);
      dial.append(svg('path', { d: arc(a, b), class: `weather-gauge__zone weather-gauge__zone--${i + 1}` }));
    }
    const needle = svg('g', { class: 'weather-gauge__needle' });
    needle.append(svg('line', { x1: CX, y1: CY, x2: CX, y2: CY - R + 4 }), svg('circle', { cx: CX, cy: CY, r: 5 }));
    const quieter = svg('text', { x: CX - R, y: 76, 'text-anchor': 'middle', class: 'weather-gauge__end' });
    quieter.textContent = 'quieter';
    const busier = svg('text', { x: CX + R, y: 76, 'text-anchor': 'middle', class: 'weather-gauge__end' });
    busier.textContent = 'busier';
    const change = svg('text', { x: CX, y: 77, 'text-anchor': 'middle', class: 'weather-gauge__change' });
    dial.append(needle, quieter, busier, change);
    host.append(dial);
  }
  const change = host.querySelector('.weather-gauge__change');
  if (ratio === null) {
    host.dataset.state = 'learning';
    if (change) change.textContent = '';
    return;
  }
  host.dataset.state = 'ready';
  host.style.setProperty('--turn', `${((gaugeAt(ratio) - 0.5) * 180).toFixed(1)}deg`);
  if (change) change.textContent = changeText(ratio);
}

export function renderToday(tile: HTMLElement, a: Almanac, nowMs = Date.now(), tz?: string, unit: RateUnit = 'second'): void {
  const r = (v: number) => wholeRate(v, unit);
  setText(tile, '[data-a-range-unit]', recordsPer(unit));
  if (a.normal) {
    const usual = usualText(a.normal, nowMs, tz, unit);
    setText(tile, '[data-a-usual]', usual.headline);
    setText(tile, '[data-a-usual-detail]', usual.detail);
    const gauge = $(tile, '[data-a-gauge]');
    if (gauge) renderGauge(gauge, usual.ratio);
  }
  const t = a.today;
  if (t) {
    const { high, low } = t;
    roll(tile, '[data-a-high]', high ? r(high.perSecond) : '–');
    setText(tile, '[data-a-high-at]', high ? `high at ${clock(high.minute, tz)}` : 'high');
    roll(tile, '[data-a-low]', low ? r(low.perSecond) : '–');
    setText(tile, '[data-a-low-at]', low ? `low at ${clock(low.minute, tz)}` : 'low');
    // the last hour on the range, once the station has heard enough of it to say
    const now = a.normal && a.normal.now.seconds >= 600 ? a.normal.now.creates / a.normal.now.seconds : null;
    const mark = $(tile, '[data-a-now]');
    const dot = $(tile, '[data-a-now-dot]');
    const placed = high && low && now !== null;
    if (mark) mark.hidden = !placed;
    if (dot) dot.hidden = !placed;
    if (placed) {
      $(tile, '[data-a-range]')?.style.setProperty('--at', rangeAt(now, low.perSecond, high.perSecond).toFixed(3));
      roll(tile, '[data-a-now]', `last hour ${r(now)}`);
    }
    setText(
      tile,
      '[data-a-range-said]',
      high && low
        ? `today's low was ${r(low.perSecond)} ${recordsPer(unit)}, at ${clock(low.minute, tz)}, and the high ${r(high.perSecond)}, at ${clock(high.minute, tz)}.${placed ? ` the last hour averaged ${r(now)}.` : ''}`
        : 'no whole minute heard yet today.',
    );
    roll(tile, '[data-a-total]', bigNumber(t.creates));
    const share = t.creates > 0 ? (t.elsewhere / t.creates) * 100 : 0;
    roll(tile, '[data-a-else-share]', t.creates > 0 ? `${share < 1 ? share.toFixed(2) : share.toFixed(1)}%` : '–');
    roll(tile, '[data-a-else-total]', t.creates > 0 ? `${bigNumber(t.elsewhere)} new records` : '');
  }
  tile.dataset.state = 'ready';
}

// ---------- records ----------

/**
 * The record for new records a second: the busiest minute on record, or today's high if
 * that's beaten it (the high can count a minute the station heard 55 seconds of; the
 * record only whole ones). `today` says the record is today's. null until there's either.
 */
export function recordHigh(a: Almanac): (Extreme & { today: boolean }) | null {
  const best = a.records?.busiest ?? null;
  const high = a.today?.high ?? null;
  if (high && (!best || high.perSecond >= best.perSecond)) return { ...high, today: true };
  return best ? { ...best, today: Date.parse(best.minute) >= Date.parse(a.today?.start ?? '') } : null;
}

/** "oct 20, 7:50 pm", or "today, 7:50 pm". */
export function whenWords(iso: string, today: boolean, tz?: string): string {
  const day = today ? 'today' : new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz }).toLowerCase();
  return `${day}, ${clock(iso, tz)}`;
}

export function renderRecords(tile: HTMLElement, a: Almanac, tz?: string, unit: RateUnit = 'second'): void {
  const wrap = $(tile, '[data-a-records]');
  const best = recordHigh(a);
  const apps = a.records?.mostApps ?? null;
  if (wrap) wrap.hidden = !best && !apps;
  if (best) {
    roll(tile, '[data-a-record-busiest]', wholeRate(best.perSecond, unit));
    setText(tile, '[data-a-record-busiest-at]', `${UNIT_INFO[unit].words}, ${whenWords(best.minute, best.today, tz)}`);
  }
  if (apps) {
    const today = !!a.today && Date.parse(apps.minute) >= Date.parse(a.today.start);
    roll(tile, '[data-a-record-apps]', `${apps.apps}`);
    setText(tile, '[data-a-record-apps-at]', `apps, ${whenWords(apps.minute, today, tz)}`);
  }
  const since = a.records?.since;
  setText(tile, '[data-a-records-since]', since ? `records since the station started listening live, ${new Date(since).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz }).toLowerCase()}.` : '');
  // today's high, when it's the record (renderToday has just set both lines afresh)
  const high = a.today?.high;
  if (high && best?.today && best.minute === high.minute) {
    setText(tile, '[data-a-high-at]', `high at ${clock(high.minute, tz)} · a record!`);
    const said = $(tile, '[data-a-range-said]');
    if (said) said.textContent += ' the high is the busiest minute on record.';
  }
}

// ---------- new in the atmosphere ----------

/** An app's lexicons in Aturi. Its namespace is its domain the other way round: mado.blue writes blue.mado.*. */
export function aturiFor(domain: string): string {
  return ATURI_LEXICONS + encodeURIComponent(domain.split('.').reverse().join('.'));
}

/** "first heard at 3:14 pm · 4 records". */
function heardText(app: NewApp, tz?: string): string {
  return `first heard at ${clock(app.firstSeen, tz)} · ${app.creates.toLocaleString('en-US')} record${app.creates === 1 ? '' : 's'}`;
}

export function renderNewApps(tile: HTMLElement, a: Almanac, nowMs = Date.now(), tz?: string): void {
  const na = a.newApps;
  if (!na) return;
  const list = $(tile, '[data-a-new-list]');
  const note = $(tile, '[data-a-new-note]');
  const apps = na.warmingUp ? [] : na.apps;
  if (na.warmingUp) {
    const left = na.readyAt ? Math.max(0, Date.parse(na.readyAt) - nowMs) : WEEK;
    setText(tile, '[data-a-new-lede]', `the station is still getting to know the sky. after a week of listening it can tell a new app from a quiet one: ${roughly(left)} to go. so far today it's heard ${na.heard} apps outside bluesky.`);
    setText(tile, '[data-a-new-count]', '');
  } else if (apps.length === 0) {
    setText(tile, '[data-a-new-lede]', `nothing new in the last 24 hours: all ${na.heard} apps it heard, it had heard before. the sky's settled.`);
    setText(tile, '[data-a-new-count]', '');
  } else {
    setText(tile, '[data-a-new-lede]', `${apps.length === 1 ? 'one app' : `${apps.length} apps`} blew in for the first time in the last 24 hours.`);
    setText(tile, '[data-a-new-count]', `${apps.length} new`);
  }
  if (note) note.hidden = apps.length === 0;
  if (list) renderCloud(tile, list, apps, tz);
  tile.dataset.state = 'ready';
}

/**
 * Biggest in the middle, smallest at the ends: busiest first, then every other one either
 * side of it. Wrapped into centred lines, the big names land on the middle lines and the
 * small ones top and bottom, so the cloud bulges in the middle like a cloud.
 */
export function cloudOrder<T extends { domain: string; creates: number }>(apps: T[]): T[] {
  const busiest = [...apps].sort((a, b) => b.creates - a.creates || (a.domain < b.domain ? -1 : 1));
  const left = busiest.filter((_, i) => i % 2 === 1).reverse();
  const right = busiest.filter((_, i) => i % 2 === 0);
  return [...left, ...right];
}

/**
 * The new apps as a word cloud: each name sized by the records it's written (on a log
 * scale, so one busy app doesn't make the rest specks) and a link to its lexicons in
 * Aturi, the busiest in the middle (cloudOrder). It's only redrawn when the apps or their
 * counts change, and a newcomer pops in.
 */
function renderCloud(tile: HTMLElement, list: HTMLElement, apps: NewApp[], tz?: string): void {
  const drawn = apps.map((app) => `${app.domain} ${app.creates} ${app.firstSeen}`).join('\n');
  if (list.dataset.drawn === drawn) return;
  const before = list.dataset.drawn === undefined ? null : new Set([...list.querySelectorAll<HTMLElement>('[data-domain]')].map((el) => el.dataset.domain));
  list.dataset.drawn = drawn;
  const tip = $(tile, '[data-a-new-tip]');
  if (tip) tip.hidden = true;
  const most = Math.log(Math.max(1, ...apps.map((app) => app.creates)));
  list.replaceChildren(
    ...cloudOrder(apps).map((app) => {
      const li = document.createElement('li');
      li.className = before && !before.has(app.domain) ? 'weather-new__app is-new' : 'weather-new__app';
      li.style.setProperty('--w', (most > 0 ? Math.log(Math.max(1, app.creates)) / most : 0).toFixed(2));
      const link = document.createElement('a');
      link.className = 'weather-new__link';
      link.href = aturiFor(app.domain);
      link.target = '_blank';
      link.rel = 'noopener';
      link.dataset.domain = app.domain;
      link.dataset.heard = heardText(app, tz);
      link.dataset.collections = app.collections.join(', ');
      const name = document.createElement('span');
      name.className = 'weather-new__domain';
      name.textContent = app.domain;
      // what the card shows, for screen readers
      const said = document.createElement('span');
      said.className = 'visually-hidden';
      said.textContent = `, ${link.dataset.heard}${app.collections.length ? `: ${link.dataset.collections}` : ''}. opens aturi in a new tab`;
      link.append(name, said);
      li.append(link);
      return li;
    }),
  );
  if (tip && tile.dataset.newTip !== 'bound') {
    tile.dataset.newTip = 'bound';
    bindCloudTip(tile, list, tip);
  }
}

/**
 * The card over a name in the cloud: when it was first heard, how many records, which
 * collections, and that it opens in Aturi. For a mouse or a keyboard; a tap just follows
 * the link. It's decoration (the link says it all in words), kept inside the tile.
 */
function bindCloudTip(tile: HTMLElement, list: HTMLElement, tip: HTMLElement): void {
  const show = (link: HTMLElement) => {
    const heard = document.createElement('span');
    heard.textContent = link.dataset.heard ?? '';
    const parts: HTMLElement[] = [heard];
    if (link.dataset.collections) {
      const cols = document.createElement('span');
      cols.className = 'weather-new__tip-cols';
      cols.textContent = link.dataset.collections;
      parts.push(cols);
    }
    const go = document.createElement('span');
    go.className = 'weather-new__tip-go';
    go.textContent = 'explore it in aturi ↗';
    parts.push(go);
    tip.replaceChildren(...parts);
    tip.hidden = false;
    const box = tile.getBoundingClientRect();
    const at = link.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const edge = 12;
    const left = Math.min(Math.max(at.left - box.left + at.width / 2 - w / 2, edge), box.width - w - edge);
    const above = at.top - box.top - h - 6;
    tip.style.left = `${Math.max(edge, left)}px`;
    tip.style.top = `${above >= edge ? above : at.bottom - box.top + 6}px`;
  };
  const hide = () => {
    tip.hidden = true;
  };
  const linkOf = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>('.weather-new__link') : null);
  list.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const link = linkOf(e.target);
    if (link) show(link);
    else hide();
  });
  list.addEventListener('pointerleave', hide);
  list.addEventListener('focusin', (e) => {
    const link = linkOf(e.target);
    let keyboard = true;
    try {
      keyboard = !!link?.matches(':focus-visible');
    } catch {
      // no :focus-visible: show it
    }
    if (link && keyboard) show(link);
  });
  list.addEventListener('focusout', hide);
}

// ---------- when the sky is busiest ----------

export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

/** "3 pm", "12 am". */
export function hourWords(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${hour < 12 ? 'am' : 'pm'}`;
}

export interface HeatSummary {
  /** Posts a second per cell, by dow (1–7) and hour; null where it hasn't heard enough. */
  rate: (dow: number, hour: number) => number | null;
  heard: number;
  min: number;
  max: number;
  busiest: { dow: number; hour: number; rate: number } | null;
  quietest: { dow: number; hour: number; rate: number } | null;
  weeks: number;
}

export function summarizeHeat(h: NonNullable<Almanac['heatmap']>): HeatSummary {
  const rates = new Map<string, number>();
  for (const c of h.cells) if (c.seconds >= HEAT_MIN_SECONDS) rates.set(`${c.dow}:${c.hour}`, c.creates / c.seconds);
  let busiest: HeatSummary['busiest'] = null;
  let quietest: HeatSummary['quietest'] = null;
  for (const [key, rate] of rates) {
    const [dow, hour] = key.split(':').map(Number) as [number, number];
    if (!busiest || rate > busiest.rate) busiest = { dow, hour, rate };
    if (!quietest || rate < quietest.rate) quietest = { dow, hour, rate };
  }
  return {
    rate: (dow, hour) => rates.get(`${dow}:${hour}`) ?? null,
    heard: rates.size,
    min: quietest?.rate ?? 0,
    max: busiest?.rate ?? 0,
    busiest,
    quietest,
    weeks: h.seconds / (WEEK / 1000),
  };
}

/** One of five steps, by where `rate` sits between the quietest and busiest hours. */
export function heatStep(rate: number, min: number, max: number): number {
  if (max <= min) return 3;
  return Math.min(5, 1 + Math.floor(((rate - min) / (max - min)) * 5));
}

export function renderHeatmap(tile: HTMLElement, a: Almanac, nowMs = Date.now(), tz?: string, unit: RateUnit = 'second'): void {
  const h = a.heatmap;
  const table = $(tile, '[data-a-heat-grid]');
  if (!h || !table) return;
  const s = summarizeHeat(h);
  const nowDow = (['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(local(nowMs, tz, { weekday: 'short' })) + 1) || 0;
  const nowHour = Number(new Date(nowMs).toLocaleString('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz })) % 24;

  const head = document.createElement('thead');
  const hr = document.createElement('tr');
  const corner = document.createElement('td');
  hr.append(corner);
  for (let hour = 0; hour < 24; hour++) {
    const th = document.createElement('th');
    th.scope = 'col';
    const short = hour === 0 ? '12a' : hour === 12 ? '12p' : hour % 6 === 0 ? `${hour % 12}${hour < 12 ? 'a' : 'p'}` : '';
    const label = document.createElement('span');
    label.textContent = hourWords(hour);
    label.className = 'visually-hidden';
    th.append(label);
    if (short) {
      const mark = document.createElement('span');
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = short;
      th.append(mark);
    }
    hr.append(th);
  }
  head.append(hr);
  const body = document.createElement('tbody');
  WEEKDAYS.forEach((day, i) => {
    const dow = i + 1;
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = day.slice(0, 3);
    tr.append(th);
    for (let hour = 0; hour < 24; hour++) {
      const td = document.createElement('td');
      const rate = s.rate(dow, hour);
      const words = rate === null ? 'not heard yet' : `${wholeRate(rate, unit)} ${recordsPer(unit)}`;
      td.className = `weather-heat__cell${rate === null ? ' weather-heat__cell--empty' : ` weather-heat__cell--${heatStep(rate, s.min, s.max)}`}${dow === nowDow && hour === nowHour ? ' weather-heat__cell--now' : ''}`;
      td.title = `${day}s at ${hourWords(hour)}: ${words}`;
      const v = document.createElement('span');
      v.className = 'visually-hidden';
      v.textContent = rate === null ? 'not heard yet' : wholeRate(rate, unit);
      td.append(v);
      tr.append(td);
    }
    body.append(tr);
  });
  const caption = table.querySelector('caption');
  if (caption) caption.textContent = `${recordsPer(unit)} for each hour of the week, in your time`;
  table.replaceChildren(...(caption ? [caption] : []), head, body);

  setText(tile, '[data-a-heat-min]', s.heard ? wholeRate(s.min, unit) : '–');
  setText(tile, '[data-a-heat-max]', s.heard ? `${wholeRate(s.max, unit)} ${recordsPer(unit)}` : '–');
  if (s.weeks >= HEAT_READY_WEEKS && s.busiest && s.quietest) {
    setText(
      tile,
      '[data-a-heat-lede]',
      `busiest on ${WEEKDAYS[s.busiest.dow - 1]}s around ${hourWords(s.busiest.hour)}, quietest on ${WEEKDAYS[s.quietest.dow - 1]}s around ${hourWords(s.quietest.hour)}.`,
    );
  } else {
    const daysIn = Math.floor((h.seconds * 1000) / DAY);
    setText(
      tile,
      '[data-a-heat-lede]',
      `filling in: ${s.heard} of the week's 168 hours heard so far. the pattern settles after about ${HEAT_READY_WEEKS} weeks of listening${daysIn >= 1 ? ` (${daysIn} day${daysIn === 1 ? '' : 's'} in)` : ''}.`,
    );
  }
  setText(tile, '[data-a-heat-aside]', s.weeks >= 1 ? `${Math.floor(s.weeks)} week${Math.floor(s.weeks) === 1 ? '' : 's'} of readings` : `${roughly(h.seconds * 1000)} of readings`);
  tile.dataset.state = 'ready';
}

/**
 * The three tiles, a first load, and a check every minute while the tab is visible.
 * `onLoad` hears every almanac that arrives (the weather alerts watch it for new apps).
 * They keep their own times, but follow the lens's unit (an hour for "total": their
 * buckets are hours), drawn again from the almanac they have when it changes.
 */
export function initAlmanac(root: ParentNode = document, fetchImpl: typeof fetch = fetch, onLoad?: (a: Almanac) => void, lens?: Lens): void {
  const today = $(root, '[data-a-today]');
  const fresh = $(root, '[data-a-new]');
  const heat = $(root, '[data-a-heat]');
  if (!today && !fresh && !heat) return;
  const tz = readerTimeZone();
  let shown: Almanac | null = null;
  const unit = () => rateUnit(lens?.get().unit ?? 'second');
  const rates = (a: Almanac, now: number) => {
    if (today && (a.today || a.normal)) renderToday(today, a, now, tz, unit());
    if (today) renderRecords(today, a, tz, unit());
    if (heat) renderHeatmap(heat, a, now, tz, unit());
  };
  lens?.onChange((l, was) => {
    if (shown && l.unit !== was.unit) rates(shown, Date.now());
  });
  const load = async () => {
    const a = await fetchAlmanac(tz, fetchImpl);
    const now = Date.now();
    if (!a) {
      for (const tile of [today, fresh, heat]) if (tile && tile.dataset.state !== 'ready') tile.dataset.state = 'error';
      return;
    }
    shown = a;
    rates(a, now);
    if (fresh) renderNewApps(fresh, a, now, tz);
    onLoad?.(a);
  };
  void load();
  const tick = () =>
    window.setTimeout(async () => {
      if (document.visibilityState !== 'hidden') await load();
      tick();
    }, ALMANAC_REFRESH_MS);
  tick();
}

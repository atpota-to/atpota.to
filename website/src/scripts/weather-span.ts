/**
 * The weather report's "the last minute" tile (weather/index.html) over the lens's window
 * (weather-lens.ts): the last minute, hour, 24 hours, 7 days or 30 days, the title saying
 * which. Every number gets a chip for how it did against the span before it.
 *
 *   minute                    the live reading, handed over by weather-page.ts (showLive),
 *                             against the station's minute before it from /api/weather-span
 *   hour, day, week, month    /api/weather-span's stretch and the one before it
 *                             (server/weather-span.ts)
 *
 * The chips compare rates, not counts, so a stretch the station heard less of doesn't
 * pass for a quiet one. Apps and accounts don't scale with time (an hour has far fewer
 * than 60 minutes' worth), so they're compared only when the station heard both
 * stretches about as well. Humidity is a percent already, so its chip is in points.
 *
 * Feels like and gusts are rates, in the lens's unit; with "total", feels like is the
 * span's posts, and gusts, a peak, stay a second. The counts under them are counts
 * whatever the unit. Numbers roll (roll.ts), and big counts shorten ("1.6m") to fit a
 * phone's two columns.
 */

import { motionOK, rollText } from './roll';
import { compactCount, countTo, coverageWords, formatCount, type Reading } from './weather';
import { formatAmount, perUnit, UNIT_INFO, type Unit, type Window } from './weather-lens';

export type Span = 'minute' | 'hour' | 'day' | 'week' | 'month';
export const SPANS: readonly Span[] = ['minute', 'hour', 'day', 'week', 'month'];
export const SPAN_ENDPOINT = '/api/weather-span';

export const SPAN_INFO: Record<Span, { seconds: number; words: string; title: string; before: string; gust: string; refreshMs: number }> = {
  minute: { seconds: 60, words: 'the last minute', title: 'minute', before: 'the minute before', gust: 'the busiest single second of the minute', refreshMs: 60_000 },
  hour: { seconds: 3600, words: 'the last hour', title: 'hour', before: 'the hour before', gust: 'the busiest minute of the hour', refreshMs: 60_000 },
  day: { seconds: 86_400, words: 'the last 24 hours', title: '24 hours', before: 'the 24 hours before', gust: 'the busiest hour of the day', refreshMs: 5 * 60_000 },
  week: { seconds: 7 * 86_400, words: 'the last 7 days', title: '7 days', before: 'the week before', gust: 'the busiest hour of the week', refreshMs: 15 * 60_000 },
  month: { seconds: 30 * 86_400, words: 'the last 30 days', title: '30 days', before: 'the 30 days before', gust: 'the busiest hour of the 30 days', refreshMs: 30 * 60_000 },
};

/** The span for the lens's window: "now" is the live minute. */
export const spanFor = (window: Window): Span => (window === 'now' ? 'minute' : window);

export const EVENTS = ['creates', 'updates', 'deletes', 'identity', 'account'] as const;
export type EventKey = (typeof EVENTS)[number];

/** A stretch as /api/weather-span answers it: counts over the seconds the station heard. */
export type Stretch = {
  since: string;
  until: string;
  seconds: number;
  posts: number;
  gust: number | null;
  apps: number | null;
  active: number | null;
  activeSeconds: number;
} & Record<EventKey, number>;

export interface SpanAnswer {
  span: Span;
  now: Stretch | null;
  before: Stretch | null;
}

/** What the tile shows, from a live reading or a stretch. */
export interface Figures {
  /** What the counts are over. */
  seconds: number;
  /** How much of that the station heard: apps and accounts compare only when it's about even. */
  heard: number;
  /** Feels like: new posts a second. */
  posts: number;
  /** Gusts: records a second at the peak. */
  gust: number | null;
  /** Humidity: edits and deletions, a percent of everything written. */
  humidity: number | null;
  /** Visibility: apps outside Bluesky heard writing. */
  apps: number | null;
  active: number | null;
  activeSeconds: number;
  /** Each kind of event, counted over `seconds`. */
  events: Record<EventKey, number> | null;
}

/**
 * Humidity: edits and deletions, as a percent of everything written (new records, edits
 * and deletions). Counts or rates, it's the same. null when nothing was written.
 */
export function humidityOf(events: { creates: number; updates: number; deletes: number }): number | null {
  const writes = events.creates + events.updates + events.deletes;
  return writes > 0 ? ((events.updates + events.deletes) / writes) * 100 : null;
}

/** Gusts: the busiest single second in the station's 60, by new records. null for a sampled reading. */
export function gustOf(r: Reading): number | null {
  if (r.source !== 'station') return null;
  const heard = (r.series ?? []).flatMap((p) => (p ? [p.creates] : []));
  return heard.length ? Math.max(...heard) : null;
}

/** The live minute: its rates, counted over the minute as the tile always has. */
export function figuresOfReading(r: Reading): Figures {
  const heard = r.seconds ?? 60;
  return {
    seconds: 60,
    heard,
    posts: r.perSecond.posts,
    gust: gustOf(r),
    humidity: r.events ? humidityOf(r.events) : null,
    apps: r.diversity?.apps ?? null,
    active: r.accounts?.active ?? null,
    activeSeconds: r.accounts ? heard : 0,
    events: r.events ? (Object.fromEntries(EVENTS.map((k) => [k, r.events![k] * 60])) as Record<EventKey, number>) : null,
  };
}

export function figuresOf(s: Stretch): Figures {
  return {
    seconds: s.seconds,
    heard: s.seconds,
    posts: s.posts / s.seconds,
    gust: s.gust,
    humidity: humidityOf(s),
    apps: s.apps,
    active: s.active,
    activeSeconds: s.activeSeconds,
    events: Object.fromEntries(EVENTS.map((k) => [k, s[k]])) as Record<EventKey, number>,
  };
}

const n = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const date = (x: unknown): x is string => typeof x === 'string' && Number.isFinite(Date.parse(x));

/** A stretch that checks out field by field, or null. */
function toStretch(x: unknown): Stretch | null {
  if (typeof x !== 'object' || x === null) return null;
  const s = x as Record<string, unknown>;
  const orNull = (v: unknown) => (n(v) ? v : null);
  if (!date(s.since) || !date(s.until) || !n(s.seconds) || s.seconds <= 0 || !n(s.posts) || !n(s.activeSeconds) || !EVENTS.every((k) => n(s[k]))) return null;
  return {
    since: s.since,
    until: s.until,
    seconds: s.seconds,
    posts: s.posts,
    gust: orNull(s.gust),
    apps: orNull(s.apps),
    active: orNull(s.active),
    activeSeconds: s.activeSeconds,
    ...(Object.fromEntries(EVENTS.map((k) => [k, s[k]])) as Record<EventKey, number>),
  };
}

export function readSpan(body: unknown): SpanAnswer | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!SPANS.includes(b.span as Span)) return null;
  return { span: b.span as Span, now: toStretch(b.now), before: toStretch(b.before) };
}

export async function fetchSpan(span: Span, fetchImpl: typeof fetch = fetch): Promise<SpanAnswer | null> {
  try {
    const res = await fetchImpl(`${SPAN_ENDPOINT}?span=${span}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const answer = readSpan(await res.json());
    return answer?.span === span ? answer : null;
  } catch {
    return null;
  }
}

// ---------- chips ----------

export interface Change {
  text: string;
  words: string;
  trend: 'up' | 'down' | 'steady';
}

/** "↑ 12%": how far `now` is from `before`, to the nearest percent. */
export function percentChange(now: number, before: number, than: string): Change | null {
  if (!(before > 0) || !Number.isFinite(now)) return null;
  const pct = Math.round((now / before - 1) * 100);
  if (pct >= 1) return { text: `↑ ${pct > 999 ? '999+' : pct}%`, words: `up ${pct}% on ${than}`, trend: 'up' };
  if (pct <= -1) return { text: `↓ ${-pct}%`, words: `down ${-pct}% on ${than}`, trend: 'down' };
  return { text: '→ 0%', words: `about the same as ${than}`, trend: 'steady' };
}

/** "↑ 0.4 pts": a percent against a percent, in points. */
export function pointsChange(now: number, before: number, than: string): Change {
  const d = Math.round((now - before) * 10) / 10;
  if (d > 0) return { text: `↑ ${d} pts`, words: `up ${d} points on ${than}`, trend: 'up' };
  if (d < 0) return { text: `↓ ${-d} pts`, words: `down ${-d} points on ${than}`, trend: 'down' };
  return { text: '→ 0 pts', words: `about the same as ${than}`, trend: 'steady' };
}

export const CHANGE_KEYS = ['posts', 'gust', 'humidity', 'apps', 'active', ...EVENTS] as const;
export type ChangeKey = (typeof CHANGE_KEYS)[number];

/** Rates compare when the stretch before was heard for at least this much of this one's time. */
export const RATE_COVERAGE = 0.5;
/** Apps and accounts compare when both stretches were heard within this of each other. */
export const DISTINCT_COVERAGE = 0.1;

/** Each figure's chip against the span before, or null where it can't fairly say. */
export function changesOf(now: Figures, before: Figures | null, span: Span): Record<ChangeKey, Change | null> {
  const out = Object.fromEntries(CHANGE_KEYS.map((k) => [k, null])) as Record<ChangeKey, Change | null>;
  if (!before) return out;
  const than = SPAN_INFO[span].before;
  const even = (a: number, b: number) => a > 0 && b >= a * (1 - DISTINCT_COVERAGE) && b <= a * (1 + DISTINCT_COVERAGE);
  if (before.seconds >= now.seconds * RATE_COVERAGE) {
    out.posts = percentChange(now.posts, before.posts, than);
    if (now.events && before.events) for (const k of EVENTS) out[k] = percentChange(now.events[k] / now.seconds, before.events[k] / before.seconds, than);
    if (now.humidity !== null && before.humidity !== null) out.humidity = pointsChange(now.humidity, before.humidity, than);
  }
  if (now.gust !== null && before.gust !== null) out.gust = percentChange(now.gust, before.gust, than);
  if (now.apps !== null && before.apps !== null && even(now.heard, before.heard)) out.apps = percentChange(now.apps, before.apps, than);
  if (now.active !== null && before.active !== null && even(now.activeSeconds, before.activeSeconds)) out.active = percentChange(now.active, before.active, than);
  return out;
}

/** The line under the tile: what the arrows compare with, and how much the station heard. */
export function spanNote(span: Span, now: Figures | null, before: Figures | null, failed = false): string {
  const info = SPAN_INFO[span];
  const words = info.words;
  if (!now) return failed ? `${words} is hard to read right now. try again in a bit.` : `reading ${words}…`;
  const heard = span !== 'minute' && now.seconds < info.seconds * 0.9 ? ` the station has heard ${coverageWords(now.seconds)} of ${words} so far.` : '';
  const arrows = before ? `arrows compare with ${info.before}.` : span === 'minute' ? '' : `once the station has heard ${info.before}, arrows say what's up and down.`;
  return `${arrows}${heard}`.trim();
}

// ---------- drawing ----------

const $ = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T>(sel);

/** Counts as people read them, shortened past 100,000 so they fit: 27,000, 1.6m. */
export const tileCount = (v: number) => (v < 100_000 ? formatCount(v) : compactCount(v));

/** "3.4%", "0.48%". */
export function percent(v: number): string {
  return `${v < 1 ? v.toFixed(2) : v.toFixed(1)}%`;
}

function show(tile: HTMLElement, sel: string, v: number | null | undefined, format: (v: number) => string): void {
  const el = $(tile, sel);
  if (!el) return;
  if (v === null || v === undefined) {
    delete el.dataset.value;
    rollText(el, '–');
  } else countTo(el, v, format);
}

/** A number's chip: the arrow and percent on screen, in words for screen readers; nothing without a change. */
export function chip(el: HTMLElement, c: Change | null): void {
  if (!c) {
    delete el.dataset.trend;
    el.replaceChildren();
    return;
  }
  el.dataset.trend = c.trend;
  const shown = document.createElement('span');
  shown.setAttribute('aria-hidden', 'true');
  shown.textContent = c.text;
  const said = document.createElement('span');
  said.className = 'visually-hidden';
  said.textContent = c.words;
  el.replaceChildren(shown, said);
}

/** Feels like's and gusts' units: "posts a second", "records an hour, at the peak", "posts in all". */
export function unitWords(unit: Unit): { posts: string; gust: string } {
  return {
    posts: unit === 'total' ? 'posts in all' : `posts ${UNIT_INFO[unit].words}`,
    gust: `records ${UNIT_INFO[unit === 'total' ? 'second' : unit].words}, at the peak`,
  };
}

/** The tile for a span: its readouts and counts, each with its chip, and the note. null while it loads. */
export function renderFigures(tile: HTMLElement, span: Span, now: Figures | null, before: Figures | null, failed = false, unit: Unit = 'second'): void {
  tile.dataset.span = span;
  const words = unitWords(unit);
  const postsUnit = $(tile, '[data-s-unit="posts"]');
  if (postsUnit) postsUnit.textContent = words.posts;
  const gustUnit = $(tile, '[data-s-unit="gust"]');
  if (gustUnit) gustUnit.textContent = words.gust;
  tile.dataset.state = now ? 'ready' : failed ? 'error' : 'loading';
  const note = $(tile, '[data-s-note]');
  if (note) note.textContent = spanNote(span, now, before, failed);
  const gustNote = $(tile, '[data-r-gusts-note]');
  if (gustNote) gustNote.textContent = SPAN_INFO[span].gust;
  const changes = now ? changesOf(now, before, span) : null;
  for (const el of tile.querySelectorAll<HTMLElement>('[data-s-change]')) chip(el, changes?.[el.dataset.sChange as ChangeKey] ?? null);
  // loading: the last numbers stay, dimmed, until the span's come
  if (!now && !failed) return;
  const rate = unit === 'total' ? 'second' : unit;
  show(tile, '[data-r-feels]', now ? (unit === 'total' ? now.posts * now.seconds : perUnit(now.posts, unit)) : undefined, formatAmount);
  const gusts = $(tile, '[data-r-gusts-wrap]');
  if (gusts) gusts.hidden = now?.gust === null;
  show(tile, '[data-r-gusts]', now?.gust == null ? now?.gust : perUnit(now.gust, rate), formatAmount);
  const humidity = $(tile, '[data-r-humidity]');
  if (humidity) rollText(humidity, now?.humidity == null ? '–' : percent(now.humidity));
  show(tile, '[data-r-visibility]', now?.apps, formatCount);
  const apps = $(tile, '[data-r-visibility-unit]');
  if (apps) apps.textContent = now?.apps === 1 ? 'app' : 'apps';
  const accounts = $(tile, '[data-r-minute-accounts]');
  if (accounts) accounts.hidden = now?.active === null;
  show(tile, '[data-r-active]', now?.active, tileCount);
  for (const k of EVENTS) show(tile, `[data-r-event="${k}"]`, now?.events?.[k], tileCount);
}

interface TileState {
  span: Span;
  unit: Unit;
  live: Figures | null;
  answers: Partial<Record<Span, SpanAnswer>>;
  failed: Partial<Record<Span, boolean>>;
}

const states = new WeakMap<HTMLElement, TileState>();

function stateOf(tile: HTMLElement): TileState {
  let s = states.get(tile);
  if (!s) states.set(tile, (s = { span: 'minute', unit: 'second', live: null, answers: {}, failed: {} }));
  return s;
}

function draw(tile: HTMLElement, s: TileState): void {
  const answer = s.answers[s.span];
  const now = s.span === 'minute' ? s.live : answer?.now ? figuresOf(answer.now) : null;
  const before = answer?.before ? figuresOf(answer.before) : null;
  renderFigures(tile, s.span, now, before, s.span !== 'minute' && !answer && !!s.failed[s.span], s.unit);
}

/** A live reading for the tile: drawn when it's on the minute, kept for when it comes back. */
export function showLive(tile: HTMLElement, r: Reading): void {
  const s = stateOf(tile);
  s.live = figuresOfReading(r);
  if (s.span === 'minute') draw(tile, s);
}

export interface SpanTile {
  /** Moves the tile to a span (the title says which), loading it if it isn't already. */
  setSpan(span: Span): void;
  setUnit(unit: Unit): void;
}

/** The tile's first load and a refresh while the tab is visible (SPAN_INFO's refreshMs); the lens moves it on (weather-page.ts). */
export function initSpan(tile: HTMLElement, fetchImpl: typeof fetch = fetch, start: { span?: Span; unit?: Unit } = {}): SpanTile {
  const s = stateOf(tile);
  const word = $(tile, '[data-s-word]');
  const status = $(tile, '[data-s-status]');
  if (start.unit) s.unit = start.unit;
  if (start.span) s.span = start.span;
  const load = async () => {
    const span = s.span;
    const answer = await fetchSpan(span, fetchImpl);
    if (answer) {
      s.answers[span] = answer;
      s.failed[span] = false;
    } else s.failed[span] = true;
    if (span === s.span) draw(tile, s);
  };
  const label = () => {
    if (word) word.textContent = SPAN_INFO[s.span].title;
  };
  let timer: number | undefined;
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      if (document.visibilityState !== 'hidden') await load();
      schedule();
    }, SPAN_INFO[s.span].refreshMs);
  };
  label();
  draw(tile, s);
  void load();
  schedule();
  return {
    setSpan(span) {
      if (span === s.span) return;
      s.span = span;
      label();
      if (word && motionOK()) word.animate?.([{ opacity: 0, transform: 'translateY(40%)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' });
      if (status) status.textContent = `showing ${SPAN_INFO[span].words}`;
      draw(tile, s);
      void load();
      schedule();
    },
    setUnit(unit) {
      if (unit === s.unit) return;
      s.unit = unit;
      draw(tile, s);
    },
  };
}

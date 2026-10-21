/**
 * The forecast on the weather report (weather/index.html, the forecast tile), from
 * /api/weather-forecast (server/weather-forecast.ts): new records a second for each of the
 * next 12 hours, in the reader's own time.
 *
 *   the hours        a weather app's strip: each hour's time, a drawing of its weather, its
 *                    number, and its chance of a storm when there's much of one; under them
 *                    the forecast as a line, in a band where 8 runs in 10 land. Where the
 *                    strip doesn't fit (a phone), each hour is a row instead, its band a bar
 *   in words         the lede (forecastWords): "breezy until about 11 pm, then calming down
 *                    to a light breeze", and a storm's chance when it's worth a mention
 *   sunrise, sunset  when the network wakes and settles, the next of each
 *   how it's doing   how far off its next-hour forecasts have been, against going by usual
 *
 * Checks again every few minutes while the tab is visible. Everything it says comes from
 * numbers it checks here first; the drawings are static.
 */

import { rollText } from './roll';
import { timeOfDay } from './sky-clock';
import type { Condition } from './weather';
import { rateUnit, recordsPer, wholeRate, type Lens, type RateUnit } from './weather-lens';

export const FORECAST_ENDPOINT = '/api/weather-forecast';
export const FORECAST_REFRESH_MS = 5 * 60_000;
/** A chance of a storm this big gets a mention under its hour, and in the words. */
export const STORM_SHOWN = 0.15;
export const STORM_SAID = 0.25;

export interface ForecastHour {
  t: string;
  perSecond: number;
  low: number;
  high: number;
  condition: Condition;
  chance: { gusts: number; storm: number };
}

export interface Forecast {
  madeAt: string;
  basis: { hours: number; days: number };
  learning?: boolean;
  /** The hour going on (or the last one heard), as heard so far. */
  now?: { t: string; perSecond: number; seconds: number; condition: Condition };
  hours: ForecastHour[];
  sun: Array<{ kind: 'wakes' | 'settles'; at: string }>;
  skill?: { lead: number; hours: number; error: number; usualError: number };
}

const CONDITIONS: readonly Condition[] = ['calm', 'light', 'breezy', 'gusty', 'stormy'];
const n = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const obj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const date = (x: unknown): x is string => typeof x === 'string' && Number.isFinite(Date.parse(x));
const chance = (x: unknown): x is number => n(x) && x <= 1;

/** Keeps what checks out: a malformed hour is dropped, a malformed answer is null. */
export function readForecast(body: unknown): Forecast | null {
  if (!obj(body) || !date(body.madeAt) || !obj(body.basis) || !n(body.basis.hours) || !n(body.basis.days)) return null;
  const out: Forecast = { madeAt: body.madeAt, basis: { hours: body.basis.hours, days: body.basis.days }, hours: [], sun: [] };
  if (body.learning === true) return { ...out, learning: true };
  const now = body.now;
  if (obj(now) && date(now.t) && n(now.perSecond) && n(now.seconds) && CONDITIONS.includes(now.condition as Condition)) {
    out.now = { t: now.t, perSecond: now.perSecond, seconds: now.seconds, condition: now.condition as Condition };
  }
  if (Array.isArray(body.hours)) {
    out.hours = body.hours.filter(
      (h): h is ForecastHour =>
        obj(h) && date(h.t) && n(h.perSecond) && n(h.low) && n(h.high) && CONDITIONS.includes(h.condition as Condition) && obj(h.chance) && chance(h.chance.gusts) && chance(h.chance.storm),
    );
  }
  if (Array.isArray(body.sun)) out.sun = body.sun.filter((e): e is Forecast['sun'][number] => obj(e) && (e.kind === 'wakes' || e.kind === 'settles') && date(e.at));
  const s = body.skill;
  if (obj(s) && n(s.lead) && n(s.hours) && n(s.error) && n(s.usualError)) out.skill = { lead: s.lead, hours: s.hours, error: s.error, usualError: s.usualError };
  return out;
}

export async function fetchForecast(fetchImpl: typeof fetch = fetch): Promise<Forecast | null> {
  try {
    const res = await fetchImpl(FORECAST_ENDPOINT, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return readForecast(await res.json());
  } catch {
    return null;
  }
}

// ---------- words ----------

/** "3 pm", or "3:30 pm" where the reader's zone is off the hour. */
export function hourLabel(iso: string, tz?: string): string {
  const d = new Date(iso);
  const minutes = Number(d.toLocaleString('en-US', { minute: 'numeric', timeZone: tz }));
  return d.toLocaleTimeString('en-US', { hour: 'numeric', ...(minutes ? { minute: '2-digit' } : {}), timeZone: tz }).toLowerCase();
}

/** "8:05 am". */
export function timeLabel(iso: string, tz?: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).toLowerCase();
}

/** Each condition as a forecast says it. */
export const CONDITION_WORDS: Record<Condition, string> = {
  calm: 'calm',
  light: 'a light breeze',
  breezy: 'breezy',
  gusty: 'gusty',
  stormy: 'stormy',
};

/**
 * The next hours in a sentence: how it starts, and the first change from there, picking up
 * or calming down; and the likeliest storm when it has a fair chance (STORM_SAID).
 */
export function forecastWords(hours: ForecastHour[], tz?: string): string {
  const first = hours[0];
  if (!first) return '';
  const rank = (c: Condition) => CONDITIONS.indexOf(c);
  const turn = hours.findIndex((h) => h.condition !== first.condition);
  let words: string;
  if (turn < 0) words = `${CONDITION_WORDS[first.condition]} for the next ${hours.length === 1 ? 'hour' : `${hours.length} hours`}`;
  else {
    const next = hours[turn]!;
    const how = rank(next.condition) > rank(first.condition) ? 'picking up to' : 'calming down to';
    words = `${CONDITION_WORDS[first.condition]} until about ${hourLabel(next.t, tz)}, then ${how} ${CONDITION_WORDS[next.condition]}`;
  }
  const storm = hours.reduce<ForecastHour | null>((best, h) => (h.chance.storm > (best?.chance.storm ?? 0) ? h : best), null);
  if (storm && storm.chance.storm >= STORM_SAID) words += `. a ${chanceWords(storm.chance.storm)} chance of a storm around ${hourLabel(storm.t, tz)}`;
  return `${words}.`;
}

/** A chance as a weather app says it: to the nearest 10%, and never 0% or 100%. */
export function chanceWords(p: number): string {
  return `${Math.min(90, Math.max(10, Math.round(p * 10) * 10))}%`;
}

/** How it's been doing, in a line, or what it's made from while it can't say yet. */
export function skillWords(f: Forecast): string {
  const made = `made from ${f.basis.days >= 2 ? `${f.basis.days} days` : `${f.basis.hours} hours`} of readings`;
  const s = f.skill;
  if (!s) return `${made}. once it has a few days to check itself against, it'll say how close it's been.`;
  const pct = (v: number) => `${Math.max(1, Math.round(v * 100))}%`;
  const ahead = s.lead === 1 ? 'the next hour' : `${s.lead} hours ahead`;
  return `${made}. lately its forecasts for ${ahead} have been off by about ${pct(s.error)} on a typical hour, against ${pct(s.usualError)} going by usual alone.`;
}

// ---------- drawing ----------

const SUN = '<circle cx="12" cy="12" r="4.4" class="wf-sun"/><path d="M12 2.6v2.3M12 19.1v2.3M2.6 12h2.3M19.1 12h2.3M5.4 5.4 7 7M17 17l1.6 1.6M18.6 5.4 17 7M7 17l-1.6 1.6"/>';
const MOON = '<path d="M14.6 3.4a8.4 8.4 0 1 0 6 11.1 6.6 6.6 0 0 1-6-11.1z" class="wf-moon"/>';
const SMALL_SUN = '<circle cx="8" cy="8" r="3.4" class="wf-sun"/><path d="M8 1.6v1.6M1.6 8h1.6M3.5 3.5l1.1 1.1M12.5 3.5l-1.1 1.1"/>';
const SMALL_MOON = '<path d="M9.6 2.4a5.6 5.6 0 1 0 4 7.4 4.4 4.4 0 0 1-4-7.4z" class="wf-moon"/>';
const BREEZE = '<path d="M8 15.5h9a2.2 2.2 0 1 0-2.2-2.2"/>';
const WIND = '<path d="M3 9h10.5a2.6 2.6 0 1 0-2.6-2.6M3 13.5h14a2.6 2.6 0 1 1-2.6 2.6M3 18h6"/>';
const STORM = '<path d="M7 15.5h10a3.9 3.9 0 0 0 .4-7.8 5.4 5.4 0 0 0-10.4 1.2A3.3 3.3 0 0 0 7 15.5z" class="wf-cloud"/><path d="M9 18.5l-1 2.4M13 18.5l-1 2.4M17 18.5l-1 2.4" class="wf-rain"/>';

/** A drawing of an hour's weather (static markup), by night with the moon. */
export function iconFor(condition: Condition, night: boolean): string {
  const body =
    condition === 'calm'
      ? night
        ? MOON
        : SUN
      : condition === 'light'
        ? `${night ? SMALL_MOON : SMALL_SUN}${BREEZE}`
        : condition === 'breezy'
          ? `${night ? SMALL_MOON : SMALL_SUN}${WIND}`
          : condition === 'gusty'
            ? WIND
            : STORM;
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
}

const $ = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T>(sel);

/** Whether an hour is night by the reader's clock: the sky-clock's rule, in their zone. */
function nightAt(iso: string, tz?: string): boolean {
  const local = new Date(new Date(iso).toLocaleString('en-US', { timeZone: tz }));
  return timeOfDay(local) === 'night';
}

/** Where a value sits between the forecast's lowest low and highest high, 0 to 1. */
type Scale = (v: number) => number;

/** One hour of the strip, its words for screen readers in the same item. */
function hourItem(label: string, h: { perSecond: number; condition: Condition; low?: number; high?: number; storm?: number }, night: boolean, scale: Scale, now = false, unit: RateUnit = 'second'): HTMLLIElement {
  const li = document.createElement('li');
  li.className = now ? 'weather-forecast__hour is-now' : 'weather-forecast__hour';
  li.dataset.condition = h.condition;
  const time = document.createElement('span');
  time.className = 'weather-forecast__time';
  time.textContent = label;
  time.setAttribute('aria-hidden', 'true');
  const icon = document.createElement('span');
  icon.className = 'weather-forecast__icon';
  icon.innerHTML = iconFor(h.condition, night);
  const rate = document.createElement('span');
  rate.className = 'weather-forecast__rate';
  rate.textContent = wholeRate(h.perSecond, unit);
  rate.setAttribute('aria-hidden', 'true');
  const chance = document.createElement('span');
  chance.className = 'weather-forecast__chance';
  chance.setAttribute('aria-hidden', 'true');
  if (h.storm !== undefined && h.storm >= STORM_SHOWN) chance.textContent = chanceWords(h.storm);
  const said = document.createElement('span');
  said.className = 'visually-hidden';
  const range = h.low !== undefined && h.high !== undefined ? ` (likely ${wholeRate(h.low, unit)} to ${wholeRate(h.high, unit)})` : '';
  const storm = h.storm !== undefined && h.storm >= STORM_SHOWN ? `, a ${chanceWords(h.storm)} chance of a storm` : '';
  said.textContent = `${label}: ${CONDITION_WORDS[h.condition]}, about ${wholeRate(h.perSecond, unit)} ${recordsPer(unit)}${range}${storm}`;
  // on a phone each hour is a row, like a weather app's days: its likely range as a bar
  // across the forecast's whole range, with a dot for the forecast itself
  const band = document.createElement('span');
  band.className = 'weather-forecast__range';
  band.setAttribute('aria-hidden', 'true');
  band.style.setProperty('--lo', scale(h.low ?? h.perSecond).toFixed(3));
  band.style.setProperty('--hi', scale(h.high ?? h.perSecond).toFixed(3));
  band.style.setProperty('--v', scale(h.perSecond).toFixed(3));
  band.append(document.createElement('i'));
  li.append(time, icon, rate, chance, band, said);
  return li;
}

const SVG = 'http://www.w3.org/2000/svg';

/**
 * The forecast as a line through the middle of each hour's column, in a band from its low
 * to its high. Decoration: each hour says its numbers in words.
 */
export function renderBand(host: HTMLElement, points: Array<{ v: number; low: number; high: number }>): void {
  const w = points.length * 100;
  const h = 64;
  const top = Math.max(...points.map((p) => p.high));
  const bottom = Math.min(...points.map((p) => p.low));
  const span = top - bottom || 1;
  const x = (i: number) => i * 100 + 50;
  const y = (v: number) => (4 + (1 - (v - bottom) / span) * (h - 8)).toFixed(1);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)} ${y(p.v)}`).join('');
  const band = `${points.map((p, i) => `${i ? 'L' : 'M'}${x(i)} ${y(p.high)}`).join('')}${points
    .map((p, i) => [i, p] as const)
    .reverse()
    .map(([i, p]) => `L${x(i)} ${y(p.low)}`)
    .join('')}Z`;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('focusable', 'false');
  const area = document.createElementNS(SVG, 'path');
  area.setAttribute('d', band);
  area.setAttribute('class', 'weather-forecast__band');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', line);
  path.setAttribute('class', 'weather-forecast__line');
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(area, path);
  host.replaceChildren(svg);
}

export function renderForecast(tile: HTMLElement, f: Forecast, nowMs = Date.now(), tz?: string, unit: RateUnit = 'second'): void {
  const unitWords = $(tile, '[data-f-unit]');
  if (unitWords) unitWords.textContent = recordsPer(unit);
  const lede = $(tile, '[data-f-lede]');
  const list = $(tile, '[data-f-hours]');
  const band = $(tile, '[data-f-band]');
  const sun = $(tile, '[data-f-sun]');
  if (f.learning || !f.hours.length) {
    if (lede) lede.textContent = `the station needs a couple of days of listening before it can forecast. it has ${f.basis.hours} hours so far.`;
    list?.replaceChildren();
    band?.replaceChildren();
    if (sun) sun.hidden = true;
    tile.dataset.state = 'learning';
    return;
  }
  const hours = f.hours.filter((h) => Date.parse(h.t) + 3_600_000 > nowMs);
  if (lede) rollText(lede, forecastWords(hours, tz));
  if (list) {
    const values = [...hours.flatMap((h) => [h.low, h.high]), ...(f.now ? [f.now.perSecond] : [])];
    const lo = Math.min(...values);
    const span = Math.max(...values) - lo || 1;
    const scale: Scale = (v) => Math.min(1, Math.max(0, (v - lo) / span));
    const items = hours.map((h) => hourItem(hourLabel(h.t, tz), { ...h, storm: h.chance.storm }, nightAt(h.t, tz), scale, false, unit));
    if (f.now) items.unshift(hourItem('now', f.now, nightAt(new Date(nowMs).toISOString(), tz), scale, true, unit));
    list.replaceChildren(...items);
    list.style.setProperty('--hours', String(items.length));
  }
  if (band) {
    const points = hours.map((h) => ({ v: h.perSecond, low: h.low, high: h.high }));
    if (f.now) points.unshift({ v: f.now.perSecond, low: f.now.perSecond, high: f.now.perSecond });
    renderBand(band, points);
  }
  // the next sunrise and sunset, soonest first
  const next = (kind: 'wakes' | 'settles') => f.sun.find((e) => e.kind === kind && Date.parse(e.at) > nowMs);
  const wakes = next('wakes');
  const settles = next('settles');
  if (sun) {
    sun.hidden = !wakes || !settles;
    if (wakes && settles) {
      const [a, b] = Date.parse(wakes.at) < Date.parse(settles.at) ? [wakes, settles] : [settles, wakes];
      sun.replaceChildren(sunCard(a, tz), sunCard(b, tz));
    }
  }
  const note = $(tile, '[data-f-note]');
  if (note) note.textContent = skillWords(f);
  tile.dataset.state = 'ready';
}

const SUNRISE = '<path d="M3 17.5h18M7.5 17.5a4.5 4.5 0 0 1 9 0"/><path d="M12 4.5v5M9.5 7 12 4.5 14.5 7"/>';
const SUNSET = '<path d="M3 17.5h18M7.5 17.5a4.5 4.5 0 0 1 9 0"/><path d="M12 4.5v5M9.5 7 12 9.5 14.5 7"/>';

function sunCard(e: Forecast['sun'][number], tz?: string): HTMLElement {
  const div = document.createElement('div');
  div.className = 'weather-forecast__sun-card';
  const dt = document.createElement('dt');
  const icon = document.createElement('span');
  icon.className = 'weather-forecast__sun-icon';
  icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${e.kind === 'wakes' ? SUNRISE : SUNSET}</svg>`;
  const what = document.createElement('span');
  what.textContent = e.kind === 'wakes' ? 'network sunrise' : 'network sunset';
  dt.append(icon, what);
  const dd = document.createElement('dd');
  const at = document.createElement('strong');
  at.textContent = timeLabel(e.at, tz);
  const why = document.createElement('span');
  why.textContent = e.kind === 'wakes' ? 'the atmosphere wakes up' : 'the atmosphere settles down';
  dd.append(at, why);
  div.append(dt, dd);
  return div;
}

/**
 * The tile, a first load, and a check every FORECAST_REFRESH_MS while the tab is visible.
 * It follows the lens's unit (an hour for "total"), drawn again when that changes.
 */
export function initForecast(root: ParentNode = document, fetchImpl: typeof fetch = fetch, tz?: string, lens?: Lens): void {
  const tile = $(root, '[data-f-forecast]');
  if (!tile) return;
  let shown: Forecast | null = null;
  const unit = () => rateUnit(lens?.get().unit ?? 'second');
  lens?.onChange((l, was) => {
    if (shown && l.unit !== was.unit) renderForecast(tile, shown, Date.now(), tz, unit());
  });
  const load = async () => {
    const f = await fetchForecast(fetchImpl);
    if (f) shown = f;
    if (f) renderForecast(tile, f, Date.now(), tz, unit());
    else if (tile.dataset.state !== 'ready') {
      tile.dataset.state = 'error';
      const lede = $(tile, '[data-f-lede]');
      if (lede) lede.textContent = 'the forecast is hard to read right now. try again in a bit.';
    }
  };
  void load();
  const tick = () =>
    window.setTimeout(async () => {
      if (document.visibilityState !== 'hidden') await load();
      tick();
    }, FORECAST_REFRESH_MS);
  tick();
}

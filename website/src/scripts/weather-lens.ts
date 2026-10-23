/**
 * The weather report's lens (weather/index.html, the strip floating along the bottom): one
 * place to say what the page shows, for every tile that can follow it.
 *
 *   window   now (the station's live 60 seconds), or the last hour, 24 hours, 7 days or
 *            30 days, from /api/weather-history and /api/weather-span
 *   measure  active accounts, the default (the different DIDs that wrote anything, so a
 *            bot writing a thousand records counts once), or new records
 *   unit     what a rate is per: a second, a minute, an hour or a day, or "total" for
 *            the counts themselves
 *
 * Accounts don't scale with time (an hour has far fewer than 60 minutes' worth), so they
 * are never a rate: with accounts the unit stands aside, kept for when records come back.
 * On a chart or a grid, "total" means each point's own count (new records each hour); on
 * a single number, the window's.
 *
 * The lens lives in the address (?w=24h&m=accounts&u=hour), so a view can be shared, and
 * in this browser as the default for next time. The address wins.
 *
 * The tiles that keep their own times (today so far, the forecast, when the sky is
 * busiest) don't follow the window or the measure, only the unit, and a "total" there is
 * an hour's worth: their buckets are hours.
 */

import { compactCount, formatCount, formatRate } from './weather';

export type Window = 'now' | 'hour' | 'day' | 'week' | 'month';
export type Measure = 'records' | 'accounts';
export type Unit = 'second' | 'minute' | 'hour' | 'day' | 'total';
export type RateUnit = Exclude<Unit, 'total'>;

export const WINDOWS: readonly Window[] = ['now', 'hour', 'day', 'week', 'month'];
export const MEASURES: readonly Measure[] = ['records', 'accounts'];
export const UNITS: readonly Unit[] = ['second', 'minute', 'hour', 'day', 'total'];

export const WINDOW_INFO: Record<Window, { short: string; words: string; seconds: number }> = {
  now: { short: 'now', words: 'the last minute', seconds: 60 },
  hour: { short: '1h', words: 'the last hour', seconds: 3600 },
  day: { short: '24h', words: 'the last 24 hours', seconds: 86_400 },
  week: { short: '7d', words: 'the last 7 days', seconds: 7 * 86_400 },
  month: { short: '30d', words: 'the last 30 days', seconds: 30 * 86_400 },
};

export const UNIT_INFO: Record<Unit, { short: string; words: string; param: string }> = {
  second: { short: 'sec', words: 'a second', param: 'sec' },
  minute: { short: 'min', words: 'a minute', param: 'min' },
  hour: { short: 'hr', words: 'an hour', param: 'hour' },
  day: { short: 'day', words: 'a day', param: 'day' },
  total: { short: 'total', words: 'in all', param: 'total' },
};

export const UNIT_SECONDS: Record<RateUnit, number> = { second: 1, minute: 60, hour: 3600, day: 86_400 };

export interface LensState {
  window: Window;
  measure: Measure;
  unit: Unit;
}

export const LENS_DEFAULT: LensState = { window: 'hour', measure: 'accounts', unit: 'second' };

/** Where the lens is kept in this browser. */
export const LENS_KEY = 'weather-lens';

// ---------- numbers in a unit ----------

/** The unit a rate is shown in: "total" falls back to `bucket` (a chart's step, or an hour for the tiles that keep their own times). */
export function rateUnit(unit: Unit, bucket: RateUnit = 'hour'): RateUnit {
  return unit === 'total' ? bucket : unit;
}

/** A rate a second, per `unit`. */
export const perUnit = (perSecond: number, unit: RateUnit) => perSecond * UNIT_SECONDS[unit];

/** An amount as people read it: one decimal under 100, whole with commas under 100,000, then short ("38.9m"). */
export function formatAmount(v: number): string {
  return v < 100 ? formatRate(v) : v < 100_000 ? formatCount(v) : compactCount(v);
}

/** A rate a second, in `unit`, as people read it. */
export const rateIn = (perSecond: number, unit: RateUnit) => formatAmount(perUnit(perSecond, unit));

/**
 * A whole rate for the tiles that keep their own times: a second reads as it always has
 * ("457"), longer units shorten past 10,000 ("27.4k", "1.6m").
 */
export function wholeRate(perSecond: number, unit: RateUnit): string {
  const v = perUnit(perSecond, unit);
  return v < 10_000 ? String(Math.round(v)) : compactCount(v);
}

/** "new records a second", "new records an hour". */
export const recordsPer = (unit: RateUnit) => `new records ${UNIT_INFO[unit].words}`;

/** The unit after this one, round and back to a second. */
export const nextUnit = (unit: Unit): Unit => UNITS[(UNITS.indexOf(unit) + 1) % UNITS.length]!;

// ---------- the address ----------

const WINDOW_PARAM: Record<Window, string> = { now: 'now', hour: '1h', day: '24h', week: '7d', month: '30d' };

function pick<T extends string>(map: Record<T, string>, value: string | null): T | undefined {
  if (value === null) return undefined;
  const v = value.toLowerCase();
  return (Object.keys(map) as T[]).find((k) => map[k] === v || k === v);
}

/** What an address's ?w, ?m and ?u ask for; anything it doesn't know is left out. */
export function lensFromSearch(search: string): Partial<LensState> {
  const q = new URLSearchParams(search);
  const out: Partial<LensState> = {};
  const w = pick(WINDOW_PARAM, q.get('w'));
  if (w) out.window = w;
  const m = q.get('m');
  if (m === 'records' || m === 'accounts') out.measure = m;
  const u = pick(Object.fromEntries(UNITS.map((k) => [k, UNIT_INFO[k].param])) as Record<Unit, string>, q.get('u'));
  if (u) out.unit = u;
  return out;
}

/** The lens as an address's query, leaving out what's the default and keeping any other params. */
export function searchFor(lens: LensState, search = ''): string {
  const q = new URLSearchParams(search);
  const set = (key: string, value: string, fallback: string) => (value === fallback ? q.delete(key) : q.set(key, value));
  set('w', WINDOW_PARAM[lens.window], WINDOW_PARAM[LENS_DEFAULT.window]);
  set('m', lens.measure, LENS_DEFAULT.measure);
  set('u', UNIT_INFO[lens.unit].param, UNIT_INFO[LENS_DEFAULT.unit].param);
  const s = q.toString();
  return s ? `?${s}` : '';
}

function stored(): Partial<LensState> {
  try {
    const raw = localStorage.getItem(LENS_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<LensState> = {};
    if (WINDOWS.includes(data.window as Window)) out.window = data.window as Window;
    if (MEASURES.includes(data.measure as Measure)) out.measure = data.measure as Measure;
    if (UNITS.includes(data.unit as Unit)) out.unit = data.unit as Unit;
    return out;
  } catch {
    return {};
  }
}

/** The lens this browser keeps for the report (not the address's): what the home tile follows. */
export function savedLens(): LensState {
  return { ...LENS_DEFAULT, ...stored() };
}

function remember(lens: LensState): void {
  try {
    localStorage.setItem(LENS_KEY, JSON.stringify(lens));
  } catch {
    // remembered for this visit only
  }
}

// ---------- the lens ----------

export interface Lens {
  get(): LensState;
  /** Changes some of the lens; listeners hear only a real change. */
  set(change: Partial<LensState>): void;
  onChange(fn: (lens: LensState, was: LensState) => void): void;
}

/**
 * The page's lens: the address's, else this browser's, else the default. Each change is
 * remembered and put in the address (replaced, not pushed: the back button leaves the page).
 */
export function createLens(search = typeof location === 'undefined' ? '' : location.search): Lens {
  let current: LensState = { ...LENS_DEFAULT, ...stored(), ...lensFromSearch(search) };
  const listeners: Array<(lens: LensState, was: LensState) => void> = [];
  return {
    get: () => current,
    set(change) {
      const next = { ...current, ...change };
      if (next.window === current.window && next.measure === current.measure && next.unit === current.unit) return;
      const was = current;
      current = next;
      remember(current);
      try {
        const url = `${location.pathname}${searchFor(current, location.search)}${location.hash}`;
        history.replaceState(history.state, '', url);
      } catch {
        // no address to keep it in (tests)
      }
      for (const fn of listeners) fn(current, was);
    },
    onChange: (fn) => void listeners.push(fn),
  };
}

const UNIT_HINT = 'accounts are counted once over the whole window, so they have no rate';

/**
 * The lens's controls ([data-lens-window], [data-lens-measure] buttons and the [data-lens-unit]
 * select), and anything on the page that cycles the unit with a tap ([data-lens-cycle-unit]),
 * kept in step with the lens. The lens is also on `root` as data-window, data-measure and
 * data-unit, for the styles. On a page only the unit reaches (`unitAlone`: today's, whose
 * tiles always count records), the unit is never set aside for accounts.
 */
export function bindLens(root: HTMLElement, lens: Lens, opts: { unitAlone?: boolean } = {}): void {
  const windows = [...root.querySelectorAll<HTMLButtonElement>('[data-lens-window]')];
  const measures = [...root.querySelectorAll<HTMLButtonElement>('[data-lens-measure]')];
  const units = [...root.querySelectorAll<HTMLSelectElement>('[data-lens-unit]')];
  const show = (s: LensState) => {
    root.dataset.window = s.window;
    root.dataset.measure = s.measure;
    root.dataset.unit = s.unit;
    for (const b of windows) b.setAttribute('aria-pressed', String(b.dataset.lensWindow === s.window));
    for (const b of measures) b.setAttribute('aria-pressed', String(b.dataset.lensMeasure === s.measure));
    for (const unit of units) {
      unit.value = s.unit;
      unit.disabled = s.measure === 'accounts' && !opts.unitAlone;
      unit.title = unit.disabled ? UNIT_HINT : '';
    }
  };
  for (const b of windows) b.addEventListener('click', () => WINDOWS.includes(b.dataset.lensWindow as Window) && lens.set({ window: b.dataset.lensWindow as Window }));
  for (const b of measures) b.addEventListener('click', () => MEASURES.includes(b.dataset.lensMeasure as Measure) && lens.set({ measure: b.dataset.lensMeasure as Measure }));
  for (const unit of units) unit.addEventListener('change', () => UNITS.includes(unit.value as Unit) && lens.set({ unit: unit.value as Unit }));
  root.addEventListener('click', (event) => {
    const cycle = (event.target as Element | null)?.closest?.<HTMLButtonElement>('[data-lens-cycle-unit]');
    if (cycle && !cycle.disabled && root.contains(cycle)) lens.set({ unit: nextUnit(lens.get().unit) });
  });
  show(lens.get());
  lens.onChange((s) => show(s));
}

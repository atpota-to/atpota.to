/**
 * /api/weather-forecast: the weather report's forecast, new records a second for each of
 * the next FORECAST_HOURS hours, from the weather station's hours in Supabase (the
 * atmosphere_hour view, read like /api/weather-history reads it).
 *
 *   GET /api/weather-forecast  ->  { madeAt, basis, now, hours, sun, skill? }
 *                                  or { madeAt, basis, learning: true } until it has enough
 *
 * It's a forecast, not "what's usual": usual is where it starts, and the last few hours say
 * how far today is running from usual and for how long that tends to hold.
 *
 *   usual     each hour of the day's median over the last USUAL_DAYS days (UTC hours, with
 *             the hour either side), nudged toward that hour of the week on the weeks
 *             before as those come in (the more weeks heard, the more it counts). Medians,
 *             so a bot's burst doesn't become the usual.
 *   running   how far each hour ran from usual, on a log scale (10% busier is the same step
 *             at 3 am as at 3 pm). The last day's median of that is the level the sky runs
 *             at lately; the latest hour says how far it is from that level right now.
 *   memory    how much of an hour's difference is still there the hour after (phi, from
 *             the hours heard): the forecast eases from now back to the recent level by
 *             that much an hour.
 *   spread    its own misses, played forward: SIMULATIONS runs of the coming hours, each
 *             hour's miss drawn from the misses it made on the hours it has heard. The 10th
 *             and 90th percentile runs are the likely range, and the share of runs past a
 *             condition's line (CONDITIONS) its chance: a 30% chance of a storm.
 *
 * And it says how well it's been doing (skill): every hour of the last SKILL_HOURS that
 * the station heard, forecast SKILL_LEAD hours ahead from only what came before, against
 * what the station then heard; and the same for usual on its own, to show it does better.
 *
 * The network's sunrise and sunset (sun) come from the same usual day: when it climbs
 * past halfway between its quietest and busiest hours ("wakes"), and when it falls back
 * ("settles"). Times are absolute; the page says them in the reader's own zone.
 *
 * Cached at the CDN for a few minutes: the forecast moves with each hour, not each second.
 */

import { conditionFor, type Condition } from './atmosphere.js';
import { counts, iso, isRecord, json, methodNotAllowed, supabase, type Env, type Fetch } from './supabase-public.js';

export const CACHE = 'public, max-age=0, s-maxage=300, stale-while-revalidate=900';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How far back it reads: four weeks, for the weekday nudges. */
export const HISTORY_MS = 28 * DAY;
/** The usual day is the median of this many days. */
export const USUAL_DAYS = 14;
export const FORECAST_HOURS = 12;
export const SIMULATIONS = 400;
/** An hour counts once the station heard half of it; the hour going on now, once it's heard this much. */
export const MIN_SECONDS = 1800;
export const MIN_NOW_SECONDS = 600;
/** Each hour of the day needs this many days heard before there's a usual for it. */
const MIN_DAYS = 2;
/** Without this many hour-to-hour pairs it can't say how long a difference lasts. */
const MIN_PAIRS = 12;
export const SKILL_HOURS = 72;
export const SKILL_LEAD = 1;
/** The rates at which gusty and stormy start (server/atmosphere.ts CONDITIONS). */
const GUSTY = 500;
const STORMY = 600;

export interface Obs {
  /** The start of the hour, ms. */
  t: number;
  /** ln(new records a second). */
  v: number;
  seconds: number;
}

/** atmosphere_hour rows as hours heard well enough, oldest first. The hour going on at `at` needs less. */
export function toObs(rows: unknown, at: number): Obs[] {
  if (!Array.isArray(rows)) return [];
  const current = Math.floor(at / HOUR) * HOUR;
  return rows
    .flatMap((r): Obs[] => {
      const t = isRecord(r) ? iso(r.hour) : null;
      const c = counts(r, ['seconds_covered', 'creates'] as const);
      if (!t || !c || c.creates <= 0) return [];
      const ms = Date.parse(t);
      if (c.seconds_covered < (ms === current ? MIN_NOW_SECONDS : MIN_SECONDS)) return [];
      return [{ t: ms, v: Math.log(c.creates / c.seconds_covered), seconds: c.seconds_covered }];
    })
    .sort((a, b) => a.t - b.t);
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const hourOfDay = (t: number) => new Date(t).getUTCHours();
const hourOfWeek = (t: number) => new Date(t).getUTCDay() * 24 + hourOfDay(t);

export interface Model {
  /** ln(new records a second) usually, at the hour starting `t`; null when it can't say. */
  usual(t: number): number | null;
  /** The level the sky has run at lately, against usual (log). */
  level: number;
  /** How much of a difference from that level is left an hour later. */
  phi: number;
  /** Its one-hour misses, for playing forward. */
  misses: number[];
  /** The latest hour heard, and how far it ran from usual and the level (log). */
  start: Obs;
  away: number;
  hours: number;
}

/**
 * The model, from the hours heard before `cutoff`. null while there isn't enough: each hour
 * of the day heard on MIN_DAYS days, MIN_PAIRS hour-to-hour pairs, and an hour heard in the
 * last three.
 */
export function fit(all: Obs[], cutoff: number): Model | null {
  const heard = all.filter((o) => o.t < cutoff && o.t >= cutoff - HISTORY_MS);
  const recent = heard.filter((o) => o.t >= cutoff - USUAL_DAYS * DAY);
  const byHour = new Map<number, number[]>();
  for (const o of recent) byHour.set(hourOfDay(o.t), [...(byHour.get(hourOfDay(o.t)) ?? []), o.v]);
  // each hour's median takes in the hour either side too: the day's shape barely moves in
  // an hour, and a burst that lands on the same hour two days running stays a burst
  const daily = new Map<number, number>();
  for (const [h, vs] of byHour) {
    if (vs.length < MIN_DAYS) continue;
    daily.set(h, median([...vs, ...(byHour.get((h + 23) % 24) ?? []), ...(byHour.get((h + 1) % 24) ?? [])]));
  }
  if (daily.size < 20) return null;
  // an hour without enough days takes after its nearest neighbours
  const dayAt = (h: number): number | null => {
    if (daily.has(h)) return daily.get(h)!;
    for (let d = 1; d < 12; d++) {
      const a = daily.get((h + 24 - d) % 24);
      const b = daily.get((h + d) % 24);
      if (a !== undefined && b !== undefined) return (a + b) / 2;
      if (a !== undefined || b !== undefined) return (a ?? b)!;
    }
    return null;
  };
  // the same hour of the week on the weeks before, as a nudge that grows with the weeks
  // heard (from two on), each week's difference trimmed so one burst can't make a Tuesday
  const fromDay = heard.flatMap((o) => {
    const d = dayAt(hourOfDay(o.t));
    return d === null ? [] : [{ t: o.t, diff: o.v - d }];
  });
  const usualSpread = 1.4826 * median(fromDay.map((f) => Math.abs(f.diff))) || 0.05;
  const byWeekHour = new Map<number, number[]>();
  for (const { t, diff } of fromDay) {
    const trimmed = Math.max(-2.5 * usualSpread, Math.min(2.5 * usualSpread, diff));
    byWeekHour.set(hourOfWeek(t), [...(byWeekHour.get(hourOfWeek(t)) ?? []), trimmed]);
  }
  const usual = (t: number): number | null => {
    const d = dayAt(hourOfDay(t));
    if (d === null) return null;
    const diffs = byWeekHour.get(hourOfWeek(t));
    return diffs && diffs.length >= 2 ? d + median(diffs) * (diffs.length / (diffs.length + 3)) : d;
  };
  const away = new Map<number, number>();
  for (const o of recent) away.set(o.t, o.v - usual(o.t)!);
  const lately = recent.filter((o) => o.t >= cutoff - DAY).map((o) => away.get(o.t)!);
  const level = median(lately.length >= 6 ? lately : [...away.values()]);
  // how long a difference holds, from the differences around their own middle, a burst trimmed
  const mid = median([...away.values()]);
  const spread = 1.4826 * median([...away.values()].map((a) => Math.abs(a - mid))) || 0.05;
  const trim = (x: number) => Math.max(-3 * spread, Math.min(3 * spread, x));
  const pairs: Array<[number, number]> = [];
  for (const [t, a] of away) {
    const next = away.get(t + HOUR);
    if (next !== undefined) pairs.push([a - mid, next - mid]);
  }
  if (pairs.length < MIN_PAIRS) return null;
  let together = 0;
  let alone = 0;
  for (const [a, b] of pairs) {
    together += trim(a) * trim(b);
    alone += trim(a) ** 2;
  }
  const phi = Math.max(0, Math.min(0.95, alone > 0 ? together / alone : 0));
  const misses = pairs.map(([a, b]) => b - phi * a);
  const start = recent[recent.length - 1];
  if (!start || cutoff - start.t > 3 * HOUR) return null;
  let off = away.get(start.t)! - level;
  // an hour still going on is only part heard: lean on the hour before by the part that isn't
  const before = away.get(start.t - HOUR);
  if (start.seconds < 3600 && before !== undefined) {
    const w = start.seconds / 3600;
    off = w * off + (1 - w) * (before - level);
  }
  return { usual, level, phi, misses, start, away: off, hours: recent.length };
}

/** A small seeded random, so the same hours give the same forecast. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ForecastHour {
  t: string;
  perSecond: number;
  /** The likely range: 8 runs in 10 land inside it. */
  low: number;
  high: number;
  condition: Condition;
  /** The chance (0 to 1) the hour runs gusty or stormier, and stormy. */
  chance: { gusts: number; storm: number };
}

/** The model's middle forecast `k` hours after its latest hour (log). */
export function center(m: Model, k: number): number | null {
  const u = m.usual(m.start.t + k * HOUR);
  return u === null ? null : u + m.level + m.phi ** k * m.away;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;

/** The next `n` hours after the model's latest one, with their ranges and chances. */
export function forecast(m: Model, n = FORECAST_HOURS, sims = SIMULATIONS): ForecastHour[] {
  const random = seeded(m.start.t / HOUR);
  const runs: number[][] = Array.from({ length: n }, () => []);
  for (let s = 0; s < sims; s++) {
    let x = m.away;
    for (let k = 1; k <= n; k++) {
      x = m.phi * x + m.misses[Math.floor(random() * m.misses.length)]!;
      const u = m.usual(m.start.t + k * HOUR);
      if (u !== null) runs[k - 1]!.push(Math.exp(u + m.level + x));
    }
  }
  const out: ForecastHour[] = [];
  for (let k = 1; k <= n; k++) {
    const c = center(m, k);
    const run = runs[k - 1]!.sort((a, b) => a - b);
    if (c === null || !run.length) continue;
    const rate = Math.exp(c);
    const share = (line: number) => Math.round((run.filter((v) => v >= line).length / run.length) * 100) / 100;
    out.push({
      t: new Date(m.start.t + k * HOUR).toISOString(),
      perSecond: round1(rate),
      low: round1(Math.min(rate, quantile(run, 0.1))),
      high: round1(Math.max(rate, quantile(run, 0.9))),
      condition: conditionFor(rate),
      chance: { gusts: share(GUSTY), storm: share(STORMY) },
    });
  }
  return out;
}

export interface Skill {
  /** How far ahead the forecasts it checked were made. */
  lead: number;
  /** How many it checked. */
  hours: number;
  /** The median miss, as a fraction of what happened: the forecast's, and usual's on its own. */
  error: number;
  usualError: number;
}

/**
 * How it's been doing: each hour of the last SKILL_HOURS before `at` that the station
 * heard, forecast SKILL_LEAD hours ahead from what came before, against what it heard.
 */
export function skillOf(all: Obs[], at: number): Skill | null {
  const byT = new Map(all.filter((o) => o.seconds >= MIN_SECONDS).map((o) => [o.t, o.v]));
  const misses: number[] = [];
  const usualMisses: number[] = [];
  for (const o of all) {
    if (o.t < at - SKILL_HOURS * HOUR || o.seconds < MIN_SECONDS) continue;
    const target = o.t + SKILL_LEAD * HOUR;
    const actual = byT.get(target);
    if (actual === undefined) continue;
    const m = fit(all, o.t + HOUR);
    const c = m && center(m, SKILL_LEAD);
    const u = m?.usual(target);
    if (c === null || c === undefined || u === null || u === undefined) continue;
    misses.push(Math.abs(Math.exp(c - actual) - 1));
    usualMisses.push(Math.abs(Math.exp(u - actual) - 1));
  }
  if (misses.length < 12) return null;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return { lead: SKILL_LEAD, hours: misses.length, error: r3(median(misses)), usualError: r3(median(usualMisses)) };
}

/** A sunrise or sunset has to hold this many hours. */
const SUN_HOLD_HOURS = 3;

export interface SunEvent {
  kind: 'wakes' | 'settles';
  at: string;
}

/**
 * The network's sunrises and sunsets from a day before the model's latest hour to two
 * after: where its usual day (with the recent level) climbs past halfway between its
 * quietest and busiest hours, and where it falls back, for good (SUN_HOLD_HOURS). An
 * hour's rate is its average, so it sits at the half hour; between two hours the crossing
 * is drawn in a straight line, and rounded to five minutes.
 */
export function sunEvents(m: Model): SunEvent[] {
  const pts: Array<{ t: number; v: number }> = [];
  for (let k = -24; k <= 48; k++) {
    const t = m.start.t + k * HOUR;
    const u = m.usual(t);
    if (u !== null) pts.push({ t: t + HOUR / 2, v: u });
  }
  // smoothed over five hours: sunrise is the day's broad shape, not an hour a bot made busy
  const smooth = pts.map((p, i) => {
    const near = pts.slice(Math.max(0, i - 2), i + 3).filter((q) => Math.abs(q.t - p.t) <= 2 * HOUR);
    return { t: p.t, v: near.reduce((s, q) => s + q.v, 0) / near.length };
  });
  if (smooth.length < 24) return [];
  const vs = smooth.map((p) => p.v);
  const line = (Math.min(...vs) + Math.max(...vs)) / 2;
  const out: SunEvent[] = [];
  // a crossing only counts if the sky stays on its new side for a few hours
  const stays = (from: number, above: boolean) => smooth.slice(from, from + SUN_HOLD_HOURS).every((p) => p.v >= line === above);
  for (let i = 1; i < smooth.length; i++) {
    const a = smooth[i - 1]!;
    const b = smooth[i]!;
    if (b.t - a.t !== HOUR) continue;
    const rising = a.v < line && b.v >= line && stays(i, true);
    const falling = a.v >= line && b.v < line && stays(i, false);
    if (!rising && !falling) continue;
    const at = a.t + ((line - a.v) / (b.v - a.v)) * HOUR;
    const five = Math.round(at / 300_000) * 300_000;
    out.push({ kind: rising ? 'wakes' : 'settles', at: new Date(five).toISOString() });
  }
  return out;
}

export interface ForecastDeps {
  fetch?: Fetch;
  now?: () => number;
  env?: () => Env;
  log?: (fields: { event: string; [k: string]: unknown }) => void;
}

/** The PostgREST path for the hours it reads, up to `at`. */
export function hoursPath(at: number): string {
  const params = new URLSearchParams({ select: 'hour,seconds_covered,creates', order: 'hour.asc', limit: '1000' });
  params.set('hour', `gte.${new Date(at - HISTORY_MS).toISOString()}`);
  return `atmosphere_hour?${params}`;
}

export function createForecastHandlers(deps: ForecastDeps = {}) {
  const fetchImpl: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => Date.now());
  const env = deps.env ?? (() => process.env);
  const log = deps.log ?? ((fields) => console.warn(JSON.stringify({ src: 'weather-forecast', ...fields })));

  async function GET(request: Request): Promise<Response> {
    const at = now();
    let rows: unknown;
    try {
      rows = await supabase(env(), fetchImpl).get(hoursPath(at));
      if (!Array.isArray(rows)) throw new Error('supabase answered something other than rows');
    } catch (error) {
      log({ event: 'forecast_error', error: (error as Error)?.message ?? 'Error' });
      return json(request, 503, { error: 'unavailable' }, 'no-store');
    }
    const obs = toObs(rows, at);
    const madeAt = new Date(at).toISOString();
    const whole = obs.filter((o) => o.seconds >= MIN_SECONDS && o.t >= at - USUAL_DAYS * DAY).length;
    const basis = { hours: whole, days: Math.floor(whole / 24) };
    const m = fit(obs, at);
    if (!m) return json(request, 200, { madeAt, basis, learning: true }, CACHE);
    const start = m.start;
    return json(
      request,
      200,
      {
        madeAt,
        basis,
        now: { t: new Date(start.t).toISOString(), perSecond: round1(Math.exp(start.v)), seconds: start.seconds, condition: conditionFor(Math.exp(start.v)) },
        hours: forecast(m),
        sun: sunEvents(m),
        skill: skillOf(obs, at) ?? undefined,
      },
      CACHE,
    );
  }

  return { GET, HEAD: GET, methodNotAllowed: async (request: Request) => methodNotAllowed(request) };
}

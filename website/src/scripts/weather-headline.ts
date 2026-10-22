/**
 * The weather report header's reading over a window of history, for the home page's
 * weather tile: the same lens the report keeps in this browser (weather-lens.ts), so the
 * tile says what the report's header would: active accounts over the last hour by
 * default, or new records in the lens's unit, with the header's line under it. The
 * report draws its own header from the whole history (weather-page.ts renderHeadline);
 * this is the slice of it the tile needs, from /api/weather-history.
 */

import { projectLast } from './weather-chart';
import { formatAmount, perUnit, savedLens, UNIT_INFO, WINDOW_INFO, type LensState, type Window } from './weather-lens';

export type HistoryRange = Exclude<Window, 'now'>;

/** Each range's step: a minute over the hour, an hour over a day or a week, a day over 30 days. */
export const RANGE_STEP_MS: Record<HistoryRange, number> = { hour: 60_000, day: 3600_000, week: 3600_000, month: 86_400_000 };

/** The header's number, short enough for a phone: 21,345, then 222k, 1.23m. */
export function bigAmount(v: number): string {
  if (v < 100_000) return formatAmount(v);
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 }).format(v).toLowerCase();
}

interface ActivePoints {
  total: { active: number };
  points: Array<{ t: string; seconds: number; active: number }>;
}

/**
 * How active accounts grow with time, from the history itself: everyone over the whole
 * range against the average bucket, as D(n buckets) = D(1) × n^k. People come back, so k
 * is under 1 (about 0.6 by the hour over a day); projectLast uses it to guess a bucket
 * still filling up, where a straight scale-up guessed well over the buckets before.
 */
export function accountsExponent(a: ActivePoints): number {
  const full = a.points.slice(0, -1).filter((p) => p.seconds > 0 && p.active > 0);
  if (full.length < 2) return 1;
  const mean = full.reduce((sum, p) => sum + p.active, 0) / full.length;
  const k = Math.log(a.total.active / mean) / Math.log(a.points.length);
  return Number.isFinite(k) ? Math.min(1, Math.max(0.3, k)) : 1;
}

/** The header's line of active accounts, its newest bucket an estimate while it fills up (projectLast), so it doesn't dip. */
export function accountsLine(a: ActivePoints | null, range: HistoryRange, now: number): { accounts: Array<number | null> | null; accountsProjected?: boolean } {
  if (!a) return { accounts: null };
  const last = a.points[a.points.length - 1];
  const points = projectLast(a.points.map((p) => ({ t: Date.parse(p.t), v: p.active })), now, RANGE_STEP_MS[range], { heardMs: (last?.seconds ?? 0) * 1000, exponent: accountsExponent(a) });
  return { accounts: points.map((p) => p.v), accountsProjected: points[points.length - 1]?.soFar !== undefined };
}

/** What the tile needs of a history answer. */
export interface HeadlineHistory {
  range: HistoryRange;
  /** The seconds the station heard over the range, and the new records in them. */
  seconds: number;
  creates: number;
  /** New records a second in each step, oldest first. */
  records: Array<number | null>;
  accounts: ActivePoints | null;
}

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const obj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** The range's history, checked as far as the tile reads it, or null. */
export async function readHeadline(range: HistoryRange, fetchImpl: typeof fetch = fetch): Promise<HeadlineHistory | null> {
  try {
    const res = await fetchImpl(`/api/weather-history?range=${range}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!obj(body) || body.range !== range || !Array.isArray(body.points) || !obj(body.total) || !num(body.total.seconds) || !num(body.total.creates)) return null;
    const records = body.points.map((p) => (obj(p) && num(p.creates) && num(p.seconds) && p.seconds > 0 ? p.creates / p.seconds : null));
    const a = body.accounts;
    const accounts =
      obj(a) && obj(a.total) && num(a.total.active) && Array.isArray(a.points)
        ? {
            total: { active: a.total.active },
            points: a.points.filter((p): p is { t: string; seconds: number; active: number } => obj(p) && typeof p.t === 'string' && Number.isFinite(Date.parse(p.t)) && num(p.seconds) && num(p.active)),
          }
        : null;
    return { range, seconds: body.total.seconds, creates: body.total.creates, records, accounts };
  } catch {
    return null;
  }
}

export interface Headline {
  /** "the last hour" */
  period: string;
  value: number;
  /** what's beside the number, for the eye: "accounts", "rec/sec", "records" */
  unit: string;
  /** the number's unit in words, for screen readers */
  unitWords: string;
  /** the line under the reading, as the report's header says it */
  cond: string;
  line: Array<number | null>;
  projected: boolean;
}

/** The report header's reading for `h` through `lens`: active accounts when it has them and asks for them, otherwise new records. */
export function headlineOf(h: HeadlineHistory, lens: LensState, now = Date.now()): Headline {
  const words = WINDOW_INFO[h.range].words;
  if (lens.measure === 'accounts' && h.accounts) {
    const line = accountsLine(h.accounts, h.range, now);
    return {
      period: words,
      value: h.accounts.total.active,
      unit: 'accounts',
      unitWords: `active accounts in ${words}`,
      cond: `different accounts wrote something in ${words}`,
      line: line.accounts ?? [],
      projected: !!line.accountsProjected,
    };
  }
  const perSecond = h.seconds > 0 ? h.creates / h.seconds : 0;
  const total = lens.unit === 'total';
  return {
    period: words,
    value: total ? h.creates : perUnit(perSecond, lens.unit === 'total' ? 'second' : lens.unit),
    unit: total ? 'records' : `rec/${UNIT_INFO[lens.unit].short}`,
    unitWords: total ? `new records in ${words}` : `new records ${UNIT_INFO[lens.unit].words}`,
    cond: total ? `new records in ${words}` : `on average over ${words}`,
    line: h.records,
    projected: false,
  };
}

/** The lens the report would open with here, or null when it's on now (the live reading says that). */
export function tileLens(): (LensState & { window: HistoryRange }) | null {
  const lens = savedLens();
  return lens.window === 'now' ? null : (lens as LensState & { window: HistoryRange });
}

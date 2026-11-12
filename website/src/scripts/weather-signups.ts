/**
 * Sign-ups over time (weather/index.html [data-p-history]): new accounts on the network,
 * day by day, for as long as the station has kept count, and how each stretch did
 * against the one before it.
 *
 * The days are the PLC directory's, as the new arrivals tile reads them (weather-hosts.ts
 * renderIdentities): new accounts on Bluesky's hosts, and people signing up on independent
 * hosts, less the ones made in bulk, by script, or with no handle (independentOf). Sign-ups
 * to hosts no relay carries are the air quality's, not these.
 *
 * It doesn't follow the lens: it's always the whole history, up to a year, from
 * /api/weather-history?range=year (its `hosts.identities`: every day the station kept,
 * atmosphere_host_trends). That answer is cached for an hour, so it says when it was worked
 * out (`total.t`), and everything here is as of then: yesterday is the day before that.
 *
 *   the numbers   whole UTC days only, today left out: yesterday against the day before,
 *                 the last 7 days against the 7 before, the last 30 against the 30 before.
 *                 A stretch missing a day has no number; one whose stretch before is
 *                 missing a day has no arrow. Until 30 whole days are kept, the third
 *                 says how many came since the first.
 *   the charts    everyone, and on independent hosts, day by day; past WEEKLY_AFTER days
 *                 kept, week by week (Monday to Sunday, UTC). Today, or this week, is
 *                 still filling up, so it's drawn out to where it's on pace to end
 *                 (weather-chart.ts projectLast). A missing day breaks the line.
 *   the table     7 days at a time back from yesterday, newest first, each against the 7
 *                 before. The oldest may be short (the history began part way through):
 *                 it says how many days it has, and neither it nor the next has an arrow.
 *
 * The scripted sign-ups depend on which hosts were caught making accounts in bulk over
 * the window the function looks at, a year here, so a day's independent count can come out
 * a little under the new arrivals tile's for the same day, from the last 30 days.
 */

import { projectLast, renderChart, type ChartBand, type ChartPoint } from './weather-chart';
import { toHostHistory, independentOf, type IdentityDay } from './weather-hosts';
import { compactCount, formatCount } from './weather';
import { chip, percent, percentChange, pointsChange, tileCount, type Change } from './weather-span';

export const SIGNUPS_ENDPOINT = '/api/weather-history?range=year';
/** How often it asks again while the tab is visible: the answer is cached for an hour, and today's count moves every 10 minutes. */
export const SIGNUPS_REFRESH_MS = 15 * 60_000;
/** Past this many days kept, the charts go week by week. */
export const WEEKLY_AFTER = 120;
/** How many weeks the table goes back. */
export const HISTORY_WEEKS = 12;

const DAY = 86_400_000;
const WEEK = 7 * DAY;

/**
 * Stretches of the history that weren't people, found by reading the PLC directory's own
 * log. Each is shaded on the chart of everyone, and the weeks and figures that take one in
 * (or compare with one) get a star and a line under the charts.
 *
 * Oct 2026: until the afternoon of Oct 18 (UTC), most new accounts on Bluesky's hosts (54 to
 * 74% in the hours sampled, Oct 8 to 18) had handles from the Faker library, a first name
 * and a word of lorem ipsum ("penelope_explicabo"): about 40,000 a day on top of about
 * 18,000 people. From Oct 19 there were none, and the day's count fell to where it's stayed.
 */
export interface SignupWave {
  from: string;
  to: string;
  label: string;
  words: string;
}

export const SIGNUP_WAVES: readonly SignupWave[] = [
  {
    from: '2026-09-01',
    to: '2026-10-18',
    label: 'scripted',
    words: "until oct 18, a script was also making about 40,000 accounts a day on bluesky's servers, with made-up names like penelope_explicabo. the drop after it is the script stopping, not fewer people signing up.",
  },
];

/** The waves that touch [from, to] (UTC days). */
export const wavesIn = (from: string, to: string, waves: readonly SignupWave[] = SIGNUP_WAVES): SignupWave[] => waves.filter((w) => w.from <= to && w.to >= from);
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const startOf = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** A day's new accounts: on Bluesky's hosts, people on independent ones, and both. */
export interface SignupDay {
  day: string;
  bluesky: number;
  independent: number;
  all: number;
}

export function signupsOf(d: IdentityDay): SignupDay {
  const independent = independentOf(d);
  return { day: d.day, bluesky: d.createdBluesky, independent, all: d.createdBluesky + independent };
}

/** What the tile reads: the days, oldest first, and when the server counted them. */
export interface Signups {
  days: IdentityDay[];
  asOf: number;
}

/** The year's history, just its days and when it was worked out, or null. */
export async function fetchSignups(fetchImpl: typeof fetch = fetch): Promise<Signups | null> {
  try {
    const res = await fetchImpl(SIGNUPS_ENDPOINT, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { range?: unknown; total?: { t?: unknown }; hosts?: unknown };
    if (body.range !== 'year') return null;
    const hosts = toHostHistory(body.hosts);
    if (!hosts) return null;
    const asOf = typeof body.total?.t === 'string' ? Date.parse(body.total.t) : NaN;
    return { days: hosts.identities, asOf: Number.isFinite(asOf) ? asOf : Date.now() };
  } catch {
    return null;
  }
}

/** The days by date. */
const byDay = (days: IdentityDay[]) => new Map(days.map((d) => [d.day, signupsOf(d)]));

interface Sum {
  all: number;
  independent: number;
  bluesky: number;
  /** How many of the stretch's days were kept. */
  days: number;
}

/** The `n` days ending the day before `end` (a day's start), added up, with how many were there. */
function sumBefore(kept: Map<string, SignupDay>, end: number, n: number): Sum {
  const sum: Sum = { all: 0, independent: 0, bluesky: 0, days: 0 };
  for (let i = 1; i <= n; i++) {
    const d = kept.get(dayKey(end - i * DAY));
    if (!d) continue;
    sum.all += d.all;
    sum.independent += d.independent;
    sum.bluesky += d.bluesky;
    sum.days++;
  }
  return sum;
}

export type StretchKey = 'day' | 'week' | 'month';

/** One of the tile's three numbers: a stretch of whole days, and how it did against the one before. */
export interface Stretch {
  key: StretchKey;
  label: string;
  /** New accounts over the stretch, or null when a day of it is missing. */
  value: number | null;
  /** Of them, on independent hosts. */
  independent: number | null;
  change: Change | null;
  /** The share of them starting outside bluesky, against the stretch before, in points. */
  shareChange: Change | null;
}

const STRETCHES: Record<StretchKey, { days: number; label: string; than: string }> = {
  day: { days: 1, label: 'yesterday', than: 'the day before' },
  week: { days: 7, label: 'last 7 days', than: 'the 7 days before' },
  month: { days: 30, label: 'last 30 days', than: 'the 30 days before' },
};

const SHORT_DAY = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
/** "oct 8". */
export const shortDay = (day: string) => SHORT_DAY.format(new Date(startOf(day))).toLowerCase();

const shareOf = (s: { all: number; independent: number }) => (s.all > 0 ? (s.independent / s.all) * 100 : null);

/**
 * Yesterday, the last 7 days and the last 30, each up to the end of yesterday as of
 * `asOf`. The 30 days, until they're all kept, become "since" the first whole day.
 */
export function stretchesOf(days: IdentityDay[], asOf: number): Stretch[] {
  const kept = byDay(days);
  const today = startOf(dayKey(asOf));
  const first = days[0]?.day;
  return (Object.keys(STRETCHES) as StretchKey[]).map((key) => {
    const { days: n, label, than } = STRETCHES[key];
    const now = sumBefore(kept, today, n);
    const before = sumBefore(kept, today - n * DAY, n);
    if (now.days === n) {
      const fair = before.days === n;
      const [shareNow, shareBefore] = [shareOf(now), shareOf(before)];
      return {
        key,
        label,
        value: now.all,
        independent: now.independent,
        change: fair ? percentChange(now.all, before.all, than) : null,
        shareChange: fair && shareNow !== null && shareBefore !== null ? pointsChange(shareNow, shareBefore, than) : null,
      };
    }
    // fewer than 30 days kept, all of them there: since the first
    if (key === 'month' && first && startOf(first) > today - n * DAY && now.days === Math.round((today - startOf(first)) / DAY) && now.days > 0) {
      return { key, label: `since ${shortDay(first)}`, value: now.all, independent: now.independent, change: null, shareChange: null };
    }
    return { key, label, value: null, independent: null, change: null, shareChange: null };
  });
}

/** The line over the numbers: how the last week went, or yesterday, or what's been counted so far. */
export function signupHeadline(stretches: Stretch[]): string {
  const [day, week, month] = stretches;
  if (week?.value != null && week.change) return `sign-ups are ${week.change.words}: ${formatCount(week.value)} new accounts over the last 7 days.`;
  if (day?.value != null && day.change) return `sign-ups are ${day.change.words}: ${formatCount(day.value)} new accounts yesterday.`;
  const most = [month, week, day].find((s) => s?.value != null);
  return most ? `${formatCount(most.value!)} new accounts ${most.key === 'day' ? 'yesterday' : most.label.startsWith('since') ? most.label : `over the ${most.label}`}.` : '';
}

/** The share that started outside bluesky over the last 7 days (or yesterday), and which way it went. */
export function signupShareWords(stretches: Stretch[]): string {
  const s = stretches.find((x) => x.key === 'week' && x.value) ?? stretches.find((x) => x.key === 'day' && x.value);
  if (!s || !s.value || s.independent === null) return '';
  const share = percent((s.independent / s.value) * 100);
  const when = s.key === 'week' ? 'over the last 7 days' : 'yesterday';
  return s.shareChange ? `${share} started on an independent host ${when}, ${s.shareChange.words}.` : `${share} started on an independent host ${when}.`;
}

// ---------- the charts ----------

export interface SignupSeries {
  step: 'day' | 'week';
  stepMs: number;
  all: ChartPoint[];
  independent: ChartPoint[];
}

/** Monday 00:00 UTC of the week a time is in. */
export const weekStart = (ms: number) => {
  const day = startOf(dayKey(ms));
  return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
};

/**
 * The charts' points, oldest first: a day each, or past WEEKLY_AFTER days a week each (a
 * week that began before the first day kept is left out, and one missing a day is a gap).
 * The newest is still filling up as of `asOf`, so it's an estimate for the whole step.
 */
export function signupSeries(days: IdentityDay[], asOf: number): SignupSeries | null {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last || days.length < 2) return null;
  const kept = byDay(days);
  const from = startOf(first.day);
  const to = startOf(last.day);
  const weekly = (to - from) / DAY + 1 > WEEKLY_AFTER;
  const stepMs = weekly ? WEEK : DAY;
  const all: ChartPoint[] = [];
  const independent: ChartPoint[] = [];
  if (!weekly) {
    for (let t = from; t <= to; t += DAY) {
      const d = kept.get(dayKey(t));
      all.push({ t, v: d ? d.all : null });
      independent.push({ t, v: d ? d.independent : null });
    }
  } else {
    // whole weeks from the first Monday kept, and this one so far
    const firstWeek = weekStart(from) === from ? from : weekStart(from) + WEEK;
    for (let t = firstWeek; t <= to; t += WEEK) {
      const upTo = Math.min(t + WEEK, to + DAY);
      let a = 0;
      let i = 0;
      let missing = false;
      for (let d = t; d < upTo; d += DAY) {
        const s = kept.get(dayKey(d));
        if (!s) missing = true;
        else {
          a += s.all;
          i += s.independent;
        }
      }
      all.push({ t, v: missing ? null : a });
      independent.push({ t, v: missing ? null : i });
    }
  }
  // the newest step, still filling up, scaled by how much of it has gone by
  const newest = all[all.length - 1];
  const heardMs = newest ? asOf - newest.t : 0;
  return {
    step: weekly ? 'week' : 'day',
    stepMs,
    all: projectLast(all, asOf, stepMs, { heardMs }),
    independent: projectLast(independent, asOf, stepMs, { heardMs }),
  };
}

// ---------- the table ----------

/** Seven days of the table: when, how many, and against the seven before. */
export interface SignupWeek {
  /** Its first and last day. */
  from: string;
  to: string;
  /** How many of its days were kept: under 7 for the oldest, when the history began part way through. */
  days: number;
  all: number;
  independent: number;
  change: Change | null;
  independentChange: Change | null;
}

/** 7 days at a time back from yesterday (as of `asOf`), newest first, as far as the history goes. */
export function signupWeeks(days: IdentityDay[], asOf: number, top = HISTORY_WEEKS): SignupWeek[] {
  const kept = byDay(days);
  const first = days[0]?.day;
  if (!first) return [];
  const today = startOf(dayKey(asOf));
  const blocks: Array<Sum & { from: string; to: string }> = [];
  for (let end = today; end > startOf(first) && blocks.length < top + 1; end -= WEEK) {
    const sum = sumBefore(kept, end, 7);
    if (sum.days === 0) break;
    blocks.push({ ...sum, from: dayKey(Math.max(end - 7 * DAY, startOf(first))), to: dayKey(end - DAY) });
  }
  return blocks.slice(0, top).map((b, i) => {
    const before = blocks[i + 1];
    const fair = b.days === 7 && before?.days === 7;
    return {
      from: b.from,
      to: b.to,
      days: b.days,
      all: b.all,
      independent: b.independent,
      change: fair ? percentChange(b.all, before.all, 'the 7 days before') : null,
      independentChange: fair ? percentChange(b.independent, before.independent, 'the 7 days before') : null,
    };
  });
}

/** "oct 28 to nov 3", or "oct 8 to oct 13 (6 days)" for a short one. */
export function weekWords(w: SignupWeek): string {
  const words = `${shortDay(w.from)} to ${shortDay(w.to)}`;
  return w.days < 7 ? `${words} (${w.days} day${w.days === 1 ? '' : 's'})` : words;
}

/** A week the waves touch, or whose week before they touch, so its arrow compares with one. */
export function weekTouched(w: SignupWeek, waves: readonly SignupWave[] = SIGNUP_WAVES): boolean {
  const before = dayKey(startOf(w.from) - 7 * DAY);
  return wavesIn(before, w.to, waves).length > 0;
}

function renderWeeks(table: HTMLTableElement, weeks: SignupWeek[], waves: readonly SignupWave[]): void {
  const body = table.tBodies[0] ?? table.createTBody();
  body.replaceChildren(
    ...weeks.map((w) => {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = weekTouched(w, waves) ? `${weekWords(w)} *` : weekWords(w);
      tr.append(th);
      const cell = (text: string) => {
        const td = document.createElement('td');
        td.textContent = text;
        tr.append(td);
      };
      const change = (c: Change | null) => {
        const td = document.createElement('td');
        if (c) chip(td, c);
        else td.textContent = '–';
        tr.append(td);
      };
      cell(formatCount(w.all));
      change(w.change);
      cell(formatCount(w.independent));
      change(w.independentChange);
      return tr;
    }),
  );
}

// ---------- the tile ----------

const $ = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T>(sel);

function setText(root: ParentNode, sel: string, text: string): void {
  const el = $(root, sel);
  if (el) el.textContent = text;
}

const TIP_DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/** The tile, from the days as of `asOf`. Hidden until there are two days to draw. */
export function renderSignupHistory(tile: HTMLElement, days: IdentityDay[], asOf: number, knownWaves: readonly SignupWave[] = SIGNUP_WAVES): void {
  const series = signupSeries(days, asOf);
  tile.hidden = !series;
  if (!series) return;
  const first = days[0]!.day;
  setText(tile, '[data-sh-since]', startOf(first) <= asOf - 365 * DAY ? 'the last 12 months (utc)' : `since ${shortDay(first)} (utc)`);

  const stretches = stretchesOf(days, asOf);
  setText(tile, '[data-sh-headline]', signupHeadline(stretches));
  const share = signupShareWords(stretches);
  const shareLine = $(tile, '[data-sh-share]');
  if (shareLine) {
    shareLine.hidden = !share;
    shareLine.textContent = share;
  }
  // the stretches that take in a scripted wave, or compare with one, get a star (the line under the charts says why)
  const yesterday = dayKey(startOf(dayKey(asOf)) - DAY);
  const touched = (n: number) => wavesIn(dayKey(startOf(dayKey(asOf)) - 2 * n * DAY), yesterday, knownWaves).length > 0;
  for (const s of stretches) {
    setText(tile, `[data-sh-label="${s.key}"]`, s.value !== null && touched(STRETCHES[s.key].days) ? `${s.label} *` : s.label);
    setText(tile, `[data-sh-value="${s.key}"]`, s.value === null ? '–' : tileCount(s.value));
    const el = $(tile, `[data-sh-change="${s.key}"]`);
    if (el) chip(el, s.change);
  }

  const each = series.step;
  setText(tile, '[data-sh-chart-title="all"]', `new accounts each ${each}`);
  setText(tile, '[data-sh-chart-title="independent"]', `new accounts on independent hosts each ${each}`);
  const formatTime = (t: number) => SHORT_DAY.format(new Date(t)).toLowerCase();
  const formatTipTime = each === 'day' ? (t: number) => TIP_DAY.format(new Date(t)).toLowerCase() : (t: number) => `week of ${formatTime(t)}`;
  const common = { format: formatCount, formatTick: compactCount, formatTime, formatTipTime, stepMs: series.stepMs };
  // the scripted waves, shaded on the chart of everyone (they were all on bluesky's hosts), and said under the charts
  const waves = wavesIn(first, dayKey(asOf), knownWaves);
  const bands: ChartBand[] = waves.map((w) => ({ from: Math.max(startOf(w.from), startOf(first)), to: startOf(w.to) + DAY - 1, label: w.label }));
  const all = $(tile, '[data-sh-chart="all"]');
  if (all) renderChart(all, series.all, { ...common, label: `new accounts each ${each}`, color: 'var(--weather-host-bsky)', bands });
  const note = $(tile, '[data-sh-note]');
  if (note) {
    note.hidden = waves.length === 0;
    note.textContent = waves.map((w) => `* ${w.words}`).join(' ');
  }
  const independent = $(tile, '[data-sh-chart="independent"]');
  if (independent) renderChart(independent, series.independent, { ...common, label: `new accounts on independent hosts each ${each}`, color: 'var(--weather-host-indep)' });

  const weeks = signupWeeks(days, asOf);
  const wrap = $(tile, '[data-sh-weeks-wrap]');
  if (wrap) wrap.hidden = weeks.length === 0;
  const table = $<HTMLTableElement>(tile, '[data-sh-weeks]');
  if (table) renderWeeks(table, weeks, knownWaves);
}

/** Loads the tile, and again every SIGNUPS_REFRESH_MS while the tab is visible; a failed refresh keeps what's shown. */
export function initSignupHistory(report: ParentNode, fetchImpl: typeof fetch = fetch): void {
  const tile = $(report, '[data-p-history]');
  if (!tile) return;
  const load = async () => {
    const got = await fetchSignups(fetchImpl);
    if (got) renderSignupHistory(tile, got.days, got.asOf);
  };
  void load();
  const tick = () =>
    window.setTimeout(async () => {
      if (document.visibilityState !== 'hidden') await load();
      tick();
    }, SIGNUPS_REFRESH_MS);
  tick();
}

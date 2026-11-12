// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdentityDay } from '../src/scripts/weather-hosts.js';
import { bindExplainers } from '../src/scripts/weather-page.js';
import {
  fetchSignups,
  initSignupHistory,
  renderSignupHistory,
  SIGNUPS_ENDPOINT,
  signupHeadline,
  signupSeries,
  signupShareWords,
  signupsOf,
  signupWeeks,
  stretchesOf,
  weekStart,
  weekWords,
  WEEKLY_AFTER,
  type SignupWave,
} from '../src/scripts/weather-signups.js';

// Sign-ups over time: new accounts over the whole history kept, against the stretch before.

const PAGE = readFileSync(resolve(process.cwd(), 'weather/index.html'), 'utf8');
const MAIN = PAGE.slice(PAGE.indexOf('<main'), PAGE.indexOf('</main>') + '</main>'.length);
const DAY = 86_400_000;

const idDay = (day: string, extra: Partial<IdentityDay> = {}): IdentityDay => ({ day, ops: 20000, createdBluesky: 1000, createdIndependent: 50, createdUnlisted: 200, createdCustomHandle: 20, createdBulk: 0, bulk: [], createdUnnamed: 0, createdScripted: 0, scripted: [], movedOut: 30, movedIn: 1, movedBetween: 2, deleted: 1, destinations: [], moves: [], ...extra });
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Every day from `from` to `to`, each as `of` makes it. */
const daysFrom = (from: string, to: string, of: (day: string) => Partial<IdentityDay> = () => ({})) => {
  const out: IdentityDay[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) out.push(idDay(dayOf(t), of(dayOf(t))));
  return out;
};

// as the station has it: oct 8 to today, nov 4, a little busier since oct 28
const AS_OF = Date.parse('2026-11-04T06:00:00Z');
const DAYS = daysFrom('2026-10-08', '2026-11-04', (d) => (d === '2026-11-04' ? { createdBluesky: 110, createdIndependent: 6 } : d >= '2026-10-28' ? { createdBluesky: 1100, createdIndependent: 60 } : {}));

describe('sign-ups over time: the numbers', () => {
  it("counts a day's new accounts as new arrivals does: people, not scripts", () => {
    expect(signupsOf(idDay('2026-10-29', { createdBluesky: 9905, createdIndependent: 5561, createdBulk: 4615, createdUnnamed: 40, createdScripted: 6 }))).toEqual({ day: '2026-10-29', bluesky: 9905, independent: 900, all: 10805 });
  });

  it('sets yesterday, the last 7 days and the last 30 against the stretch before, whole days only', () => {
    const [day, week, month] = stretchesOf(DAYS, AS_OF);
    expect(day).toMatchObject({ label: 'yesterday', value: 1160, change: { text: '→ 0%', trend: 'steady', words: 'about the same as the day before' } });
    expect(week).toMatchObject({ label: 'last 7 days', value: 8120, independent: 420, change: { text: '↑ 10%', trend: 'up', words: 'up 10% on the 7 days before' } });
    expect(week!.shareChange).toMatchObject({ text: '↑ 0.4 pts', words: 'up 0.4 points on the 7 days before' });
    // 27 whole days kept, not 30: since the first, with nothing to set it against
    expect(month).toMatchObject({ label: 'since oct 8', value: 20 * 1050 + 7 * 1160, change: null });
  });

  it('leaves a stretch missing a day without a number, and one whose stretch before is short without an arrow', () => {
    const gap = DAYS.filter((d) => d.day !== '2026-10-30');
    const [day, week, month] = stretchesOf(gap, AS_OF);
    expect(day!.value).toBe(1160);
    expect(week).toMatchObject({ value: null, change: null });
    expect(month).toMatchObject({ label: 'last 30 days', value: null });
    // the week before is short: a number, no arrow
    const [, late] = stretchesOf(DAYS.filter((d) => d.day !== '2026-10-21'), AS_OF);
    expect(late).toMatchObject({ value: 8120, change: null, shareChange: null });
  });

  it('sets the last 30 days against the 30 before once 60 are kept', () => {
    const long = daysFrom('2026-09-04', '2026-11-03', (d) => (d >= '2026-10-04' ? { createdBluesky: 900, createdIndependent: 0 } : {}));
    const [, , month] = stretchesOf(long, AS_OF);
    expect(month).toMatchObject({ label: 'last 30 days', value: 27_000, change: { text: '↓ 14%', words: 'down 14% on the 30 days before' } });
  });

  it('heads the tile with how the week went, or yesterday, or what came so far', () => {
    const stretches = stretchesOf(DAYS, AS_OF);
    expect(signupHeadline(stretches)).toBe('sign-ups are up 10% on the 7 days before: 8,120 new accounts over the last 7 days.');
    expect(signupShareWords(stretches)).toBe('5.2% started on an independent host over the last 7 days, up 0.4 points on the 7 days before.');
    // two days kept: yesterday against the day before
    const two = stretchesOf(daysFrom('2026-11-02', '2026-11-03', (d) => (d === '2026-11-03' ? { createdBluesky: 1200 } : {})), AS_OF);
    expect(signupHeadline(two)).toBe('sign-ups are up 19% on the day before: 1,250 new accounts yesterday.');
    expect(signupShareWords(two)).toBe('4.0% started on an independent host yesterday, down 0.8 points on the day before.');
    // one whole day: just what came
    expect(signupHeadline(stretchesOf([idDay('2026-11-03'), idDay('2026-11-04')], AS_OF))).toBe('1,050 new accounts since nov 3.');
    expect(signupHeadline(stretchesOf([idDay('2026-11-04')], AS_OF))).toBe('');
  });
});

describe('sign-ups over time: the charts and the table', () => {
  it('goes day by day, a missing day a gap, and today out to where it is on pace', () => {
    const s = signupSeries(DAYS.filter((d) => d.day !== '2026-10-20'), AS_OF)!;
    expect(s.step).toBe('day');
    expect(s.all).toHaveLength(28);
    expect(s.all[0]).toEqual({ t: Date.parse('2026-10-08T00:00:00Z'), v: 1050 });
    expect(s.all.find((p) => p.t === Date.parse('2026-10-20T00:00:00Z'))!.v).toBeNull();
    // a quarter of the way through today
    expect(s.all.at(-1)).toEqual({ t: Date.parse('2026-11-04T00:00:00Z'), v: 464, soFar: 116 });
    expect(s.independent.at(-1)).toEqual({ t: Date.parse('2026-11-04T00:00:00Z'), v: 24, soFar: 6 });
    // with today not in yet, yesterday is whole
    expect(signupSeries(DAYS.slice(0, -1), AS_OF)!.all.at(-1)).toEqual({ t: Date.parse('2026-11-03T00:00:00Z'), v: 1160 });
    expect(signupSeries([idDay('2026-11-04')], AS_OF)).toBeNull();
  });

  it(`goes week by week past ${WEEKLY_AFTER} days, Monday to Sunday, leaving out a week begun before the first day`, () => {
    const asOf = Date.parse('2026-11-04T12:00:00Z');
    // from a wednesday; today has half a day in
    const days = daysFrom('2026-06-03', '2026-11-04', (d) => (d === '2026-11-04' ? { createdBluesky: 50, createdIndependent: 0 } : { createdBluesky: 100, createdIndependent: 0 }));
    const s = signupSeries(days, asOf)!;
    expect(s.step).toBe('week');
    expect(s.all[0]).toEqual({ t: Date.parse('2026-06-08T00:00:00Z'), v: 700 });
    expect(s.all.every((p, i) => i === 0 || p.t - s.all[i - 1]!.t === 7 * DAY)).toBe(true);
    // this week: monday, tuesday and half of wednesday, on pace for a whole one
    expect(s.all.at(-1)).toEqual({ t: Date.parse('2026-11-02T00:00:00Z'), v: 700, soFar: 250 });
    expect(weekStart(asOf)).toBe(Date.parse('2026-11-02T00:00:00Z'));
    // a week missing a day is a gap
    const gap = signupSeries(days.filter((d) => d.day !== '2026-07-15'), asOf)!;
    expect(gap.all.find((p) => p.t === Date.parse('2026-07-13T00:00:00Z'))!.v).toBeNull();
  });

  it('goes back 7 days at a time from yesterday, the oldest short, without arrows next to it', () => {
    const weeks = signupWeeks(DAYS, AS_OF);
    expect(weeks.map(weekWords)).toEqual(['oct 28 to nov 3', 'oct 21 to oct 27', 'oct 14 to oct 20', 'oct 8 to oct 13 (6 days)']);
    expect(weeks.map((w) => w.all)).toEqual([8120, 7350, 7350, 6300]);
    expect(weeks.map((w) => w.change?.text ?? null)).toEqual(['↑ 10%', '→ 0%', null, null]);
    expect(weeks.map((w) => w.independentChange?.text ?? null)).toEqual(['↑ 20%', '→ 0%', null, null]);
    expect(signupWeeks(DAYS, AS_OF, 2)).toHaveLength(2);
    expect(signupWeeks([], AS_OF)).toEqual([]);
  });
});

describe('sign-ups over time: the tile', () => {
  let report: HTMLElement;
  let tile: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = MAIN;
    report = document.querySelector<HTMLElement>('[data-weather-report]')!;
    tile = report.querySelector<HTMLElement>('[data-p-history]')!;
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const text = (sel: string) => tile.querySelector(sel)!.textContent;

  it('is a migration tile of its own, with poe to explain it', () => {
    expect(tile.dataset.topics).toBe('migration');
    expect(tile.hidden).toBe(true);
    bindExplainers(report);
    expect(tile.querySelector<HTMLElement>('[data-poe-explain="signups"]')!.hidden).toBe(false);
  });

  it('stays hidden with a day or none, and fills in from the days', () => {
    renderSignupHistory(tile, [idDay('2026-11-04')], AS_OF, []);
    expect(tile.hidden).toBe(true);
    renderSignupHistory(tile, DAYS, AS_OF, []);
    expect(tile.hidden).toBe(false);
    expect(tile.querySelector<HTMLElement>('[data-sh-note]')!.hidden).toBe(true);
    expect(text('[data-sh-since]')).toBe('since oct 8 (utc)');
    expect(text('[data-sh-headline]')).toBe('sign-ups are up 10% on the 7 days before: 8,120 new accounts over the last 7 days.');
    expect(text('[data-sh-value="day"]')).toBe('1,160');
    expect(text('[data-sh-value="week"]')).toBe('8,120');
    expect(text('[data-sh-label="month"]')).toBe('since oct 8');
    expect(text('[data-sh-value="month"]')).toBe('29,120');
    // the arrows: on screen, and in words for screen readers
    const week = tile.querySelector<HTMLElement>('[data-sh-change="week"]')!;
    expect(week.dataset.trend).toBe('up');
    expect(week.textContent).toBe('↑ 10%up 10% on the 7 days before');
    expect(tile.querySelector('[data-sh-change="month"]')!.textContent).toBe('');
    expect(tile.querySelector<HTMLElement>('[data-sh-share]')!.hidden).toBe(false);
    for (const which of ['all', 'independent']) expect(tile.querySelector(`[data-sh-chart="${which}"] svg`), which).not.toBeNull();
    expect(text('[data-sh-chart-title="all"]')).toBe('new accounts each day');
    const rows = [...tile.querySelectorAll('[data-sh-weeks] tbody tr')].map((r) => [...r.children].map((c) => c.textContent));
    expect(rows[0]).toEqual(['oct 28 to nov 3', '8,120', '↑ 10%up 10% on the 7 days before', '420', '↑ 20%up 20% on the 7 days before']);
    expect(rows.at(-1)).toEqual(['oct 8 to oct 13 (6 days)', '6,300', '–', '300', '–']);
  });

  it('shades a scripted wave on the chart of everyone, stars what takes it in, and says what it was', () => {
    const wave: SignupWave = { from: '2026-09-01', to: '2026-10-12', label: 'scripted', words: 'a script made accounts until oct 12.' };
    renderSignupHistory(tile, DAYS, AS_OF, [wave]);
    expect(tile.querySelectorAll('[data-sh-chart="all"] .weather-chart__band')).toHaveLength(1);
    expect(tile.querySelectorAll('[data-sh-chart="independent"] .weather-chart__band')).toHaveLength(0);
    const note = tile.querySelector<HTMLElement>('[data-sh-note]')!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe('* a script made accounts until oct 12.');
    // the 30 days take it in; the 7 days don't
    expect(text('[data-sh-label="month"]')).toBe('since oct 8 *');
    expect(text('[data-sh-label="week"]')).toBe('last 7 days');
    // the weeks that take it in, and the one whose arrow compares with one that does
    const labels = [...tile.querySelectorAll('[data-sh-weeks] tbody th')].map((th) => th.textContent);
    expect(labels).toEqual(['oct 28 to nov 3', 'oct 21 to oct 27', 'oct 14 to oct 20 *', 'oct 8 to oct 13 (6 days) *']);
  });

  it('says week by week in the chart titles once it goes that way', () => {
    const days = daysFrom('2026-06-03', '2026-11-04');
    renderSignupHistory(tile, days, Date.parse('2026-11-04T12:00:00Z'));
    expect(text('[data-sh-chart-title="all"]')).toBe('new accounts each week');
    expect(text('[data-sh-chart-title="independent"]')).toBe('new accounts on independent hosts each week');
    expect(text('[data-sh-value="month"]')).toBe('31,500');
    expect(tile.querySelectorAll('[data-sh-weeks] tbody tr')).toHaveLength(12);
  });

  const answer = (body: unknown, ok = true) => vi.fn(async (_url: string) => ({ ok, json: async () => body }) as Response);
  const YEAR = { range: 'year', points: [], total: { t: '2026-11-04T06:00:00.000Z' }, hosts: { bucket: 'month', points: [], new: [], growing: [], identities: DAYS } };

  it("reads the year's days from the history, as of when the server counted them", async () => {
    const fetchImpl = answer(YEAR);
    const got = await fetchSignups(fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith(SIGNUPS_ENDPOINT, { headers: { accept: 'application/json' } });
    expect(SIGNUPS_ENDPOINT).toBe('/api/weather-history?range=year');
    expect(got!.asOf).toBe(AS_OF);
    expect(got!.days).toHaveLength(28);
    expect(await fetchSignups(answer({ ...YEAR, range: 'month' }) as unknown as typeof fetch)).toBeNull();
    expect(await fetchSignups(answer({ ...YEAR, hosts: undefined }) as unknown as typeof fetch)).toBeNull();
    expect(await fetchSignups(answer(YEAR, false) as unknown as typeof fetch)).toBeNull();
  });

  it('loads itself, and keeps what it showed when a refresh fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let ok = true;
    const fetchImpl = vi.fn(async () => ({ ok, json: async () => YEAR }) as Response);
    initSignupHistory(report, fetchImpl as unknown as typeof fetch);
    await vi.waitFor(() => expect(tile.hidden).toBe(false));
    ok = false;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(tile.hidden).toBe(false);
    expect(text('[data-sh-value="week"]')).toBe('8,120');
  });
});

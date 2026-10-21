// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPLAINERS, renderReport } from '../src/scripts/weather-page.js';
import {
  CHANGE_KEYS,
  changesOf,
  fetchSpan,
  figuresOf,
  figuresOfReading,
  gustOf,
  humidityOf,
  initSpan,
  percentChange,
  pointsChange,
  readSpan,
  renderFigures,
  showLive,
  spanFor,
  spanNote,
  tileCount,
  unitWords,
  type Figures,
  type SpanAnswer,
  type Stretch,
} from '../src/scripts/weather-span.js';
import type { Reading } from '../src/scripts/weather.js';

// The last-minute tile on /weather: the live minute, or the lens's window (the last hour,
// 24 hours, 7 days or 30 days), each number with a chip against the span before.

const PAGE = readFileSync(resolve(process.cwd(), 'weather/index.html'), 'utf8');
const MAIN = PAGE.slice(PAGE.indexOf('<main'), PAGE.indexOf('</main>') + '</main>'.length);

const READING: Reading = {
  measuredAt: '2026-11-03T17:00:00.000Z',
  seconds: 60,
  perSecond: { posts: 51, likes: 308, reposts: 52.2, follows: 24.1 },
  condition: 'breezy',
  records: { perSecond: 444, bluesky: 436, elsewhere: 8 },
  diversity: { index: 1.8, level: 'low', share: 0.52, spread: 12, apps: 12, collections: 40 },
  events: { creates: 444, updates: 3.6, deletes: 13.5, identity: 0.5, account: 0.2 },
  source: 'station',
  series: [{ t: 1, creates: 1234, bluesky: 1200, elsewhere: 34, posts: 120 }],
  accounts: { active: 21_345, bluesky: 21_200, elsewhere: 145, index: 0.5, apps: [] },
} as Reading;

const stretch = (rate: number, extra: Partial<Stretch> = {}): Stretch => ({
  since: '2026-11-03T16:00:00.000Z',
  until: '2026-11-03T17:00:00.000Z',
  seconds: 3600,
  creates: rate * 3600,
  posts: (rate / 10) * 3600,
  updates: 3600,
  deletes: 3 * 3600,
  identity: 100,
  account: 50,
  gust: rate * 1.5,
  apps: 80,
  active: 200_000,
  activeSeconds: 3600,
  ...extra,
});

const BEFORE_MINUTE: Stretch = { ...stretch(400), since: '2026-11-03T16:58:00.000Z', until: '2026-11-03T16:59:00.000Z', seconds: 60, creates: 400 * 60, posts: 40 * 60, updates: 60, deletes: 180, identity: 1, account: 0, gust: null, apps: 10, active: 20_000, activeSeconds: 60 };

let tile: HTMLElement;
const text = (sel: string) => tile.querySelector(sel)!.textContent;
const chips = () => Object.fromEntries([...tile.querySelectorAll<HTMLElement>('[data-s-change]')].map((el) => [el.dataset.sChange, el.querySelector('[aria-hidden]')?.textContent ?? '']));

beforeEach(() => {
  document.body.innerHTML = MAIN;
  tile = document.querySelector<HTMLElement>('[data-s-tile]')!;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the figures', () => {
  it('humidity is the share of writes that change or take back a record', () => {
    expect(humidityOf({ creates: 90, updates: 4, deletes: 6 })).toBe(10);
    expect(humidityOf({ creates: 0, updates: 0, deletes: 0 })).toBeNull();
  });

  it("gusts are the busiest second of the station's minute, and a sample has none", () => {
    const series = [{ t: 1, creates: 420 }, null, { t: 3, creates: 980 }, { t: 4, creates: 440 }] as Reading['series'];
    expect(gustOf({ ...READING, series })).toBe(980);
    expect(gustOf({ ...READING, series: [] })).toBeNull();
    expect(gustOf({ ...READING, source: 'sample', series })).toBeNull();
  });

  it('the live minute counts each kind of event over the minute, as the tile always has', () => {
    const f = figuresOfReading(READING);
    expect(f.events!.deletes).toBe(810);
    expect(f).toMatchObject({ seconds: 60, heard: 60, posts: 51, gust: 1234, apps: 12, active: 21_345, activeSeconds: 60 });
    expect(figuresOfReading({ ...READING, accounts: undefined, events: undefined })).toMatchObject({ active: null, activeSeconds: 0, events: null, humidity: null });
  });

  it('a stretch is rates over the seconds the station heard', () => {
    const f = figuresOf(stretch(450, { seconds: 1800, posts: 45 * 1800 }));
    expect(f.posts).toBe(45);
    expect(f.humidity).toBeCloseTo((4 / (450 + 4)) * 100, 5);
    expect(tileCount(27_000)).toBe('27,000');
    expect(tileCount(1_620_000)).toBe('1.6m');
  });
});

describe('the chips', () => {
  it('say how far up or down, to the nearest percent, and humidity in points', () => {
    expect(percentChange(112, 100, 'the hour before')).toEqual({ text: '↑ 12%', words: 'up 12% on the hour before', trend: 'up' });
    expect(percentChange(91, 100, 'the day before')).toEqual({ text: '↓ 9%', words: 'down 9% on the day before', trend: 'down' });
    expect(percentChange(100.2, 100, 'x')!.trend).toBe('steady');
    expect(percentChange(5, 0, 'x')).toBeNull();
    expect(percentChange(50, 1, 'x')!.text).toBe('↑ 999+%');
    expect(pointsChange(4.1, 3.7, 'the minute before')).toEqual({ text: '↑ 0.4 pts', words: 'up 0.4 points on the minute before', trend: 'up' });
    expect(pointsChange(3.72, 3.7, 'x').trend).toBe('steady');
  });

  it('compare rates, so a stretch heard for less time does not look quiet', () => {
    const now = figuresOf(stretch(440));
    const half = figuresOf(stretch(400, { seconds: 1800, creates: 400 * 1800, posts: 40 * 1800, updates: 1800, deletes: 3 * 1800, identity: 50, account: 25, activeSeconds: 1800 }));
    const c = changesOf(now, half, 'hour');
    expect(c.creates!.text).toBe('↑ 10%');
    expect(c.posts!.text).toBe('↑ 10%');
    expect(c.identity!.trend).toBe('steady');
    // apps and accounts don't scale with time: not across stretches heard this differently
    expect(c.apps).toBeNull();
    expect(c.active).toBeNull();
    // less than RATE_COVERAGE of it heard: nothing to say
    expect(changesOf(now, figuresOf(stretch(400, { seconds: 600 })), 'hour').creates).toBeNull();
    expect(Object.values(changesOf(now, null, 'hour')).every((v) => v === null)).toBe(true);
  });

  it('compare apps and accounts when both were heard about as well, and gusts only when both have one', () => {
    const c = changesOf(figuresOf(stretch(440, { apps: 88, active: 210_000 })), figuresOf(stretch(400)), 'hour');
    expect(c.apps!.text).toBe('↑ 10%');
    expect(c.active!.text).toBe('↑ 5%');
    expect(c.gust!.text).toBe('↑ 10%');
    expect(changesOf(figuresOfReading(READING), figuresOf(BEFORE_MINUTE), 'minute').gust).toBeNull();
  });

  it('a note says what they compare with, and how much of a long span the station has heard', () => {
    const now = figuresOf(stretch(440));
    expect(spanNote('hour', now, now)).toBe('arrows compare with the hour before.');
    expect(spanNote('day', figuresOf(stretch(440, { seconds: 70_000 })), null)).toBe("once the station has heard the 24 hours before, arrows say what's up and down. the station has heard 19 hours of the last 24 hours so far.");
    expect(spanNote('minute', now, null)).toBe('');
    expect(spanNote('week', null, null)).toBe('reading the last 7 days…');
    expect(spanNote('week', null, null, true)).toBe('the last 7 days is hard to read right now. try again in a bit.');
    expect(spanNote('month', figuresOf(stretch(440)), figuresOf(stretch(400)))).toBe('arrows compare with the 30 days before. the station has heard 1 hour of the last 30 days so far.');
  });
});

describe('reading /api/weather-span', () => {
  it('keeps what checks out', () => {
    const body = { span: 'hour', now: stretch(440), before: { ...stretch(400), seconds: 'lots' } };
    expect(readSpan(body)).toEqual({ span: 'hour', now: stretch(440), before: null });
    expect(readSpan({ span: 'year', now: stretch(1) })).toBeNull();
    expect(readSpan({ span: 'minute', before: { ...BEFORE_MINUTE, gust: 'x', apps: -1 } })!.before).toMatchObject({ gust: null, apps: null });
  });

  it("asks for the span, and is null when it can't", async () => {
    const asked: string[] = [];
    const ok = (async (url: string) => (asked.push(url), Response.json({ span: 'day', now: stretch(1), before: null }))) as typeof fetch;
    expect((await fetchSpan('day', ok))?.now?.seconds).toBe(3600);
    expect(asked).toEqual(['/api/weather-span?span=day']);
    expect(await fetchSpan('week', ok)).toBeNull(); // answered for another span
    expect(await fetchSpan('day', (async () => new Response('', { status: 503 })) as typeof fetch)).toBeNull();
  });
});

describe('the tile', () => {
  it('has a chip for every number, and its title says the span', () => {
    for (const k of CHANGE_KEYS) expect(tile.querySelector(`[data-s-change="${k}"]`), k).not.toBeNull();
    expect(text('#weather-minute-title')).toBe('the last minute');
    // the lens moves it on; the tile has no control of its own
    expect(tile.querySelector('#weather-minute-title button')).toBeNull();
  });

  it('follows the lens: now is the live minute, a window its own span', () => {
    expect(spanFor('now')).toBe('minute');
    expect(spanFor('day')).toBe('day');
    expect(spanFor('month')).toBe('month');
  });

  it("puts feels like and gusts in the lens's unit, and the counts stay counts", () => {
    const now = figuresOf(stretch(440));
    renderFigures(tile, 'hour', now, null, false, 'minute');
    expect(text('[data-r-feels]')).toBe('2,640'); // 44 posts a second
    expect(text('[data-s-unit="posts"]')).toBe('posts a minute');
    expect(text('[data-r-gusts]')).toBe('39,600');
    expect(text('[data-s-unit="gust"]')).toBe('records a minute, at the peak');
    expect(text('[data-r-event="creates"]')).toBe('1.6m');
    // in all: the span's posts, and a peak stays a second
    renderFigures(tile, 'hour', now, null, false, 'total');
    expect(text('[data-r-feels]')).toBe('158.4k');
    expect(text('[data-s-unit="posts"]')).toBe('posts in all');
    expect(text('[data-r-gusts]')).toBe('660');
    expect(unitWords('total').gust).toBe('records a second, at the peak');
  });

  it('shows the live minute, each number on its own with what it counts under it', () => {
    renderReport(document.querySelector<HTMLElement>('[data-weather-report]')!, READING);
    expect(text('[data-r-feels]')).toBe('51');
    expect(text('[data-r-gusts]')).toBe('1,234');
    expect(text('[data-r-humidity]')).toBe('3.7%');
    expect(text('[data-r-visibility]')).toBe('12');
    expect(text('[data-r-visibility-unit]')).toBe('apps');
    expect(text('[data-r-event="deletes"]')).toBe('810');
    expect(text('[data-r-active]')).toBe('21,345');
    expect(text('[data-r-gusts-note]')).toBe('the busiest single second of the minute');
    expect(tile.dataset.state).toBe('ready');
  });

  it('hides gusts for a sampled reading, and dashes what it does not know', () => {
    showLive(tile, { ...READING, source: 'sample', events: undefined, diversity: { ...READING.diversity!, apps: undefined } } as unknown as Reading);
    expect(tile.querySelector<HTMLElement>('[data-r-gusts-wrap]')!.hidden).toBe(true);
    expect(text('[data-r-humidity]')).toBe('–');
    expect(text('[data-r-visibility]')).toBe('–');
  });

  it('puts a chip by each number it can compare, in words for screen readers', () => {
    const now: Figures = figuresOf(stretch(440, { apps: 88 }));
    renderFigures(tile, 'hour', now, figuresOf(stretch(400)));
    const c = chips();
    expect(c.creates).toBe('↑ 10%');
    expect(c.apps).toBe('↑ 10%');
    const creates = tile.querySelector<HTMLElement>('[data-s-change="creates"]')!;
    expect(creates.dataset.trend).toBe('up');
    expect(creates.querySelector('.visually-hidden')!.textContent).toBe('up 10% on the hour before');
    expect(text('[data-r-event="creates"]')).toBe('1.6m');
    expect(text('[data-r-gusts-note]')).toBe('the busiest minute of the hour');
    // nothing to compare with: no chips
    renderFigures(tile, 'hour', now, null);
    expect(Object.values(chips()).every((v) => v === '')).toBe(true);
  });

  it("moves on with the lens, to the hour, 24 hours, 7 days and 30 days and back; the live minute doesn't write over them", async () => {
    vi.useFakeTimers();
    const asked: string[] = [];
    const answers: Record<string, SpanAnswer> = {
      minute: { span: 'minute', now: null, before: BEFORE_MINUTE },
      hour: { span: 'hour', now: stretch(440), before: stretch(400) },
      day: { span: 'day', now: stretch(430, { seconds: 86_400, creates: 430 * 86_400, posts: 43 * 86_400 }), before: null },
      week: { span: 'week', now: stretch(420), before: stretch(420) },
      month: { span: 'month', now: stretch(410), before: null },
    };
    const fetchImpl = (async (url: string) => {
      const span = new URL(url, 'https://atpota.to').searchParams.get('span')!;
      asked.push(span);
      return Response.json(answers[span]);
    }) as typeof fetch;
    showLive(tile, READING);
    const span = initSpan(tile, fetchImpl);
    await vi.waitFor(() => expect(chips().creates).toBe('↑ 11%'));
    expect(text('[data-s-note]')).toBe('arrows compare with the minute before.');

    span.setSpan('hour');
    expect(text('#weather-minute-title')).toBe('the last hour');
    expect(tile.dataset.state).toBe('loading');
    expect(text('[data-s-status]')).toBe('showing the last hour');
    await vi.waitFor(() => expect(tile.dataset.state).toBe('ready'));
    expect(text('[data-r-feels]')).toBe('44');
    expect(chips().posts).toBe('↑ 10%');
    // a live reading while on the hour leaves the hour be
    showLive(tile, { ...READING, perSecond: { ...READING.perSecond, posts: 99 } });
    expect(text('[data-r-feels]')).toBe('44');

    span.setSpan('day');
    expect(text('#weather-minute-title')).toBe('the last 24 hours');
    await vi.waitFor(() => expect(tile.dataset.state).toBe('ready'));
    expect(text('[data-s-note]')).toBe("once the station has heard the 24 hours before, arrows say what's up and down.");
    span.setSpan('week');
    await vi.waitFor(() => expect(text('[data-r-gusts-note]')).toBe('the busiest hour of the week'));
    span.setSpan('month');
    expect(text('#weather-minute-title')).toBe('the last 30 days');
    await vi.waitFor(() => expect(text('[data-r-gusts-note]')).toBe('the busiest hour of the 30 days'));
    span.setSpan('minute');
    expect(text('#weather-minute-title')).toBe('the last minute');
    // back on the minute: the last live reading, at once
    expect(text('[data-r-feels]')).toBe('99');
    // and a new unit redraws what's there
    span.setUnit('hour');
    expect(text('[data-r-feels]')).toBe('356.4k');
    expect(asked.slice(0, 5)).toEqual(['minute', 'hour', 'day', 'week', 'month']);
  });

  it('says so when a span is hard to read', async () => {
    const fetchImpl = (async (url: string) => (url.includes('span=hour') ? new Response('', { status: 503 }) : Response.json({ span: 'minute', before: null }))) as typeof fetch;
    initSpan(tile, fetchImpl).setSpan('hour');
    await vi.waitFor(() => expect(tile.dataset.state).toBe('error'));
    expect(text('[data-s-note]')).toBe('the last hour is hard to read right now. try again in a bit.');
    expect(text('[data-r-feels]')).toBe('–');
  });

  it("Poe's explainer tells you about the spans and the arrows", () => {
    const said = EXPLAINERS.readouts!.answer;
    expect(said).toContain('the last hour, day, week or month');
    expect(said).toContain('arrows');
  });
});

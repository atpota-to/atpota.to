// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { niceMax, segments } from '../src/scripts/weather-chart.js';
import { BLUESKY_NAMES, coverageWords, fetchHistory, formatRate, ratesOf, renderReport, renderReportError, renderTrends, trendSummary, type History } from '../src/scripts/weather-page.js';
import { CONDITION_TEXT, ERROR_TEXT, LEVEL_TEXT, type Reading } from '../src/scripts/weather.js';

// /weather: the atmosphere weather report, filled from one /api/atmosphere reading.

const PAGE = readFileSync(resolve(process.cwd(), 'weather/index.html'), 'utf8');
const MAIN = PAGE.slice(PAGE.indexOf('<main'), PAGE.indexOf('</main>') + '</main>'.length);

const READING: Reading = {
  measuredAt: '2026-10-20T16:18:00.000Z',
  seconds: 5,
  perSecond: { posts: 51, likes: 308, reposts: 52.2, follows: 24.1 },
  condition: 'stormy',
  records: { perSecond: 444, bluesky: 436, elsewhere: 8 },
  diversity: { index: 1.8, level: 'low', apps: 12, collections: 40 },
  apps: [
    { domain: 'tangled.sh', perSecond: 4, count: 20, collections: ['sh.tangled.repo', 'sh.tangled.feed.star'] },
    { domain: 'whtwnd.com', perSecond: 1, count: 5, collections: ['com.whtwnd.blog.entry'] },
  ],
  bluesky: [
    { nsid: 'app.bsky.feed.like', perSecond: 308, count: 1540 },
    { nsid: 'app.bsky.feed.newthing', perSecond: 1, count: 5 },
  ],
  events: { creates: 444, updates: 3.6, deletes: 13.5, identity: 0.5, account: 0.2 },
};

let report: HTMLElement;
const text = (sel: string) => report.querySelector(sel)!.textContent;

beforeEach(() => {
  document.body.innerHTML = MAIN;
  report = document.querySelector<HTMLElement>('[data-weather-report]')!;
});

describe('the atmosphere weather report', () => {
  it('is its own page, with the shared header and footer', () => {
    expect(PAGE).toContain('<body data-page="weather"');
    expect(PAGE).toContain('<!-- @partial header -->');
    expect(PAGE).toContain('<link rel="canonical" href="https://atpota.to/weather">');
    expect(PAGE).toContain('/src/styles/weather.css');
  });

  it('fills every tile from one reading', () => {
    renderReport(report, READING);
    expect(report.dataset.state).toBe('ready');
    expect(text('[data-r-records]')).toBe('444'); // every new record, not just posts
    expect(text('[data-r-cond]')).toBe(CONDITION_TEXT.stormy);
    expect(text('[data-r-index]')).toBe('1.8');
    expect(text('[data-r-level]')).toBe('low');
    expect(text('[data-r-level-text]')).toBe(LEVEL_TEXT.low);
    expect(text('[data-r-ratio]')).toBe('1 in 56 new records came from outside bluesky');
    expect(text('[data-r-else-share]')).toBe('(1.8%)');
    expect(text('[data-r-apps-count]')).toBe('12 apps heard, top 2');
    expect(text('[data-r-event="deletes"]')).toBe('13.5');
    expect(text('[data-r-collections]')).toBe('40');
    expect(report.querySelector<HTMLElement>('[data-r-marker]')!.style.left).toMatch(/^13\.8/);
  });

  it('draws the apps and bluesky collections as bars, longest for the busiest', () => {
    renderReport(report, READING);
    const apps = [...report.querySelectorAll('[data-r-apps] li')];
    expect(apps.map((li) => li.querySelector('.weather-bars__label')!.textContent)).toEqual(['tangled.sh', 'whtwnd.com']);
    expect(apps[0]!.querySelector('.weather-bars__sub')!.textContent).toBe('sh.tangled.repo, sh.tangled.feed.star');
    expect(apps.map((li) => li.querySelector<HTMLElement>('.weather-bars__fill')!.style.width)).toEqual(['100%', '25%']);
    expect(apps[0]!.getAttribute('title')).toBe('20 in 5 seconds');
    const bsky = [...report.querySelectorAll('[data-r-bsky-list] .weather-bars__label')].map((el) => el.textContent);
    expect(bsky).toEqual([BLUESKY_NAMES['app.bsky.feed.like'], 'app.bsky.feed.newthing']);
    expect(report.querySelector<HTMLElement>('[data-r-apps-empty]')!.hidden).toBe(true);
  });

  it('says so when nobody but bluesky was writing', () => {
    renderReport(report, { ...READING, apps: [], records: { perSecond: 400, bluesky: 400, elsewhere: 0 }, diversity: { index: 0, level: 'low', apps: 0, collections: 8 } });
    expect(report.querySelector<HTMLElement>('[data-r-apps-empty]')!.hidden).toBe(false);
    expect(report.querySelector<HTMLElement>('[data-r-bar-else]')!.hidden).toBe(true);
    expect(text('[data-r-apps-count]')).toBe('');
  });

  it('puts names from the firehose on the page as text, never markup', () => {
    renderReport(report, { ...READING, apps: [{ domain: 'x.y', perSecond: 1, count: 1, collections: ['<img src=x>'] }] });
    expect(report.querySelector('[data-r-apps] img')).toBeNull();
  });

  it('keeps the last reading when a check fails, and says so when none came', () => {
    renderReportError(report);
    expect(report.dataset.state).toBe('error');
    expect(text('[data-r-cond]')).toBe(ERROR_TEXT);
    renderReport(report, READING);
    renderReportError(report);
    expect(report.dataset.state).toBe('ready');
  });

  it('words rates for people', () => {
    expect(formatRate(0.25)).toBe('0.3');
    expect(formatRate(52.2)).toBe('52.2');
    expect(formatRate(1234.5)).toBe('1,235');
  });
});

describe('live from the weather station', () => {
  const series = Array.from({ length: 60 }, (_, i) => (i === 30 ? null : { t: 1792512960 + i, creates: 440, bluesky: 438, elsewhere: 2, posts: 40 + (i % 5) }));

  it('says the reading is the last 60 seconds, with a sparkline of them', () => {
    renderReport(report, { ...READING, source: 'station', seconds: 60, series });
    expect(text('[data-r-when]')).toBe('the last 60 seconds, live. updates every few seconds.');
    const spark = report.querySelector<HTMLElement>('[data-r-spark]')!;
    expect(spark.hidden).toBe(false);
    // the missing second breaks the line in two
    expect(spark.querySelector('path')!.getAttribute('d')!.match(/M/g)).toHaveLength(2);
  });

  it('a sampled reading has no sparkline', () => {
    renderReport(report, { ...READING, source: 'sample' });
    expect(report.querySelector<HTMLElement>('[data-r-spark]')!.hidden).toBe(true);
    expect(text('[data-r-when]')).toMatch(/^read at .*, from 5 seconds of the firehose\. next reading in about a minute\.$/);
  });
});

describe('trends', () => {
  const NOW = Date.parse('2026-10-20T17:00:00.000Z');
  const point = (t: string, seconds = 60, creates = 26_400, elsewhere = 66) => ({ t, seconds, creates, bluesky: creates - elsewhere, elsewhere, posts: 3000 });
  const HISTORY: History = {
    range: 'hour',
    points: [point('2026-10-20T16:57:00.000Z'), point('2026-10-20T16:58:00.000Z'), point('2026-10-20T16:59:00.000Z', 30, 13_200, 0)],
    total: point('2026-10-20T17:00:00.000Z', 150, 66_000, 132),
  };

  it('works rates and the index out from counts', () => {
    expect(ratesOf(point('x'))).toEqual({ records: 440, posts: 50, index: 0.25 });
    expect(ratesOf(point('x', 0))).toEqual({ records: null, posts: null, index: null });
    expect(coverageWords(59)).toBe('under a minute');
    expect(coverageWords(150)).toBe('2 minutes');
    expect(coverageWords(90_000)).toBe('1 day');
  });

  it('sums the range up in a sentence, saying when the station is new', () => {
    expect(trendSummary(HISTORY)).toBe('the last hour (from 2 minutes of readings so far): 440 new records a second, diversity index 0.20.');
    expect(trendSummary({ ...HISTORY, total: point('x', 3600, 1_584_000, 3960) })).toBe('the last hour: 440 new records a second, diversity index 0.25.');
    expect(trendSummary({ ...HISTORY, points: [], total: point('x', 0) })).toBe('no readings yet for the last hour. the station fills this in as it goes.');
  });

  it('draws both charts from the start of the range, and lists every point in the table', () => {
    const section = report.querySelector<HTMLElement>('[data-r-trends]')!;
    renderTrends(section, HISTORY, NOW);
    expect(section.dataset.state).toBe('ready');
    const records = section.querySelector('[data-t-chart="records"]')!;
    expect(records.querySelector('svg')!.getAttribute('aria-label')).toMatch(/^new records a second/);
    expect(records.querySelectorAll('.weather-chart__line')).toHaveLength(1);
    expect(section.querySelectorAll('[data-t-rows] tr')).toHaveLength(3);
    expect(section.querySelector('[data-t-rows] tr td')!.textContent).toBe('440'); // newest first
  });

  it('lists the busiest apps over the range, when there are any', () => {
    const section = report.querySelector<HTMLElement>('[data-r-trends]')!;
    const wrap = section.querySelector<HTMLElement>('[data-t-apps-wrap]')!;
    renderTrends(section, HISTORY, NOW);
    expect(wrap.hidden).toBe(true);
    renderTrends(section, { ...HISTORY, apps: [{ domain: 'tangled.sh', creates: 300, collections: ['sh.tangled.repo'] }] }, NOW);
    expect(wrap.hidden).toBe(false);
    expect(section.querySelector('[data-t-apps-title]')!.textContent).toBe('busiest apps elsewhere, the last hour: new records');
    const row = section.querySelector('[data-t-apps] li')!;
    expect(row.querySelector('.weather-bars__label')!.textContent).toBe('tangled.sh');
    expect(row.querySelector('.weather-bars__value')!.textContent).toBe('300');
  });

  it('reads points with the arrow keys', () => {
    const section = report.querySelector<HTMLElement>('[data-r-trends]')!;
    renderTrends(section, HISTORY, NOW);
    const host = section.querySelector<HTMLElement>('[data-t-chart="records"]')!;
    const svg = host.querySelector('svg')!;
    svg.dispatchEvent(new FocusEvent('focus'));
    expect(host.querySelector<HTMLElement>('.weather-chart__tip')!.hidden).toBe(false);
    expect(host.querySelector('.weather-chart__tip strong')!.textContent).toBe('440');
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    // the first step is the start of the range, before the station had anything
    expect(host.querySelector('.weather-chart__tip strong')!.textContent).toBe('no reading');
  });

  it('only accepts well-formed history', async () => {
    const answer = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as typeof fetch;
    expect(await fetchHistory('hour', answer(HISTORY))).toEqual(HISTORY);
    expect(await fetchHistory('day', answer(HISTORY))).toBeNull(); // not what was asked for
    expect((await fetchHistory('hour', answer({ ...HISTORY, points: [{ t: 'x' }, ...HISTORY.points] })))!.points).toHaveLength(3);
    expect(await fetchHistory('hour', answer({ error: 'unavailable' }, 503))).toBeNull();
    const withApps = await fetchHistory('hour', answer({ ...HISTORY, apps: [{ domain: 'ok.app', creates: 1, minutes: 1, collections: [] }, { domain: '<x>', creates: 1, minutes: 1, collections: [] }] }));
    expect(withApps!.apps).toEqual([{ domain: 'ok.app', creates: 1, minutes: 1, collections: [] }]);
  });

  it('chart helpers: round tops, and gaps where steps are missing', () => {
    expect(niceMax(463)).toBe(500);
    expect(niceMax(0.33)).toBe(0.5);
    expect(niceMax(0)).toBe(1);
    const runs = segments(
      [
        { t: 0, v: 1 },
        { t: 60, v: 2 },
        { t: 180, v: 3 },
        { t: 240, v: null },
        { t: 300, v: 4 },
      ],
      60,
    );
    expect(runs.map((r) => r.map((p) => p.v))).toEqual([[1, 2], [3], [4]]);
  });
});

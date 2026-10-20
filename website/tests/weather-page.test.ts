// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { niceMax, segments } from '../src/scripts/weather-chart.js';
import {
  accountChange,
  accountSummary,
  BLUESKY_NAMES,
  compactCount,
  coverageWords,
  createMeasure,
  fetchHistory,
  formatRate,
  MEASURE_KEY,
  ratesOf,
  renderReport,
  renderReportError,
  renderTrends,
  trendSummary,
  type History,
  type HistoryAccounts,
} from '../src/scripts/weather-page.js';
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

describe('records or accounts', () => {
  const NOW = Date.parse('2026-10-20T17:00:00.000Z');
  const ACCOUNTS = {
    active: 21_345,
    bluesky: 21_100,
    elsewhere: 620,
    index: 2.9,
    apps: [
      { domain: 'whtwnd.com', accounts: 140, collections: ['com.whtwnd.blog.entry'] },
      { domain: 'tangled.sh', accounts: 90, collections: ['sh.tangled.feed.star'] },
    ],
  };
  const LIVE: Reading = { ...READING, source: 'station', seconds: 60, accounts: ACCOUNTS };
  const point = (t: string, active: number, elsewhere: number, seconds = 60) => ({ t, seconds, active, bluesky: active - elsewhere + 10, elsewhere });
  const acct: HistoryAccounts = {
    seconds: 180,
    prevSeconds: 180,
    total: { active: 40_000, bluesky: 39_500, elsewhere: 900 },
    points: [point('2026-10-20T16:57:00.000Z', 20_000, 500), point('2026-10-20T16:58:00.000Z', 21_000, 520), point('2026-10-20T16:59:00.000Z', 22_000, 600)],
    apps: [
      { domain: 'whtwnd.com', active: 300, prevActive: 200, collections: ['com.whtwnd.blog.entry'] },
      { domain: 'tangled.sh', active: 280, prevActive: 0, collections: [] },
    ],
  };
  const pts = (t: string) => ({ t, seconds: 60, creates: 26_400, bluesky: 26_334, elsewhere: 66, posts: 3000 });
  const HISTORY: History = { range: 'hour', points: [pts('2026-10-20T16:59:00.000Z')], total: pts('2026-10-20T17:00:00.000Z'), accounts: acct };
  const section = () => report.querySelector<HTMLElement>('[data-r-trends]')!;

  it('says how many accounts wrote in the last minute, and the index by accounts', () => {
    renderReport(report, LIVE);
    expect(text('[data-r-accounts]')).toBe('21,345 different accounts wrote in that time.');
    expect(text('[data-r-acct-index]')).toBe('by accounts: 2.9% of the 21,345 accounts active just now wrote somewhere other than bluesky.');
    renderReport(report, READING);
    expect(report.querySelector<HTMLElement>('[data-r-accounts]')!.hidden).toBe(true);
    expect(report.querySelector<HTMLElement>('[data-r-acct-index]')!.hidden).toBe(true);
  });

  it('ranks the apps elsewhere by accounts, or by records when the reading has no accounts', () => {
    renderReport(report, LIVE, 'accounts');
    const labels = () => [...report.querySelectorAll('[data-r-apps] .weather-bars__label')].map((l) => l.textContent);
    expect(labels()).toEqual(['whtwnd.com', 'tangled.sh']);
    expect(report.querySelector('[data-r-apps] .weather-bars__value')!.textContent).toBe('140');
    expect(text('[data-r-apps-note]')).toBe('busiest first, by how many different accounts wrote to each in the last 60 seconds.');
    renderReport(report, LIVE, 'records');
    expect(labels()).toEqual(['tangled.sh', 'whtwnd.com']);
    expect(text('[data-r-apps-note]')).toBe('busiest first, records a second.');
    renderReport(report, READING, 'accounts');
    expect(labels()).toEqual(['tangled.sh', 'whtwnd.com']);
    expect(text('[data-r-apps-note]')).toMatch(/^accounts come from the weather station/);
  });

  it('draws the trends by accounts: each bucket, the range as a union, and apps by accounts', () => {
    renderTrends(section(), HISTORY, NOW, 'accounts');
    const s = section();
    expect(s.dataset.measure).toBe('accounts');
    expect(s.querySelector('[data-t-summary]')!.textContent).toBe('the last hour (from 3 minutes of counting so far): 40,000 different accounts wrote something, 2.3% of them somewhere other than bluesky.');
    expect(s.querySelector('[data-t-chart-title="records"]')!.textContent).toBe('active accounts each minute');
    expect(s.querySelector('[data-t-chart-title="index"]')!.textContent).toBe('share of accounts writing elsewhere');
    expect(s.querySelector('[data-t-chart="records"] svg')!.getAttribute('aria-label')).toMatch(/^active accounts each minute/);
    expect([...s.querySelectorAll('[data-t-head] th')].map((th) => th.textContent)).toEqual(['when', 'active accounts', 'on bluesky', 'writing elsewhere', 'share elsewhere']);
    const newest = [...s.querySelectorAll('[data-t-rows] tr')[0]!.children].map((c) => c.textContent);
    expect(newest.slice(1)).toEqual(['22,000', '21,410', '600', '2.7%']);
    expect(newest[0]).not.toMatch(/so far/); // 16:59 is over at 17:00
    renderTrends(section(), HISTORY, NOW - 30_000, 'accounts');
    expect(s.querySelector('[data-t-rows] tr th')!.textContent).toMatch(/\(so far\)$/);
    renderTrends(section(), HISTORY, NOW, 'accounts');
    expect(s.querySelector<HTMLElement>('[data-t-measure-note]')!.hidden).toBe(false);
    expect(s.querySelector('[data-t-apps-title]')!.textContent).toBe('busiest apps elsewhere, the last hour: active accounts');
    const rows = [...s.querySelectorAll('[data-t-apps] li')];
    expect(rows.map((r) => [r.querySelector('.weather-bars__label')!.textContent, r.querySelector('.weather-bars__value')!.textContent, r.querySelector('.weather-bars__change')!.getAttribute('data-trend')])).toEqual([
      ['whtwnd.com', '300', 'up'],
      ['tangled.sh', '280', 'new'],
    ]);

    // and back: records put their own titles, header and note back
    renderTrends(section(), HISTORY, NOW, 'records');
    expect(s.querySelector('[data-t-chart-title="records"]')!.textContent).toBe('new records a second');
    expect([...s.querySelectorAll('[data-t-head] th')].map((th) => th.textContent)).toEqual(['when', 'new records a second', 'bluesky posts a second', 'diversity index']);
    expect(s.querySelector<HTMLElement>('[data-t-measure-note]')!.hidden).toBe(true);
  });

  it('says so when there are no account counts yet, or they cannot be read', () => {
    expect(accountSummary({ ...HISTORY, accounts: undefined })).toBe('the account counts are hard to read right now. the records are still here.');
    expect(accountSummary({ ...HISTORY, accounts: { ...acct, seconds: 0, points: [], apps: [], total: { active: 0, bluesky: 0, elsewhere: 0 } } })).toMatch(/^no account counts yet for the last hour/);
    renderTrends(section(), { ...HISTORY, accounts: undefined }, NOW, 'accounts');
    expect(section().querySelector<HTMLElement>('[data-t-apps-wrap]')!.hidden).toBe(true);
    expect(section().querySelectorAll('[data-t-rows] tr')).toHaveLength(0);
  });

  it('compares apps\' accounts only when both windows were heard about as well', () => {
    const app = acct.apps[0]!;
    expect(accountChange(app, acct, 'yesterday')).toEqual({ text: '↑ 50%', words: 'up 50% on yesterday', trend: 'up' });
    expect(accountChange({ ...app, active: 210 }, acct, 'yesterday')!.trend).toBe('steady');
    expect(accountChange({ ...app, active: 100 }, acct, 'yesterday')!.trend).toBe('down');
    expect(accountChange(app, { ...acct, prevSeconds: 90 }, 'yesterday')).toBeNull();
    expect(accountChange(app, { ...acct, prevSeconds: 400 }, 'yesterday')).toBeNull();
  });

  it('only accepts well-formed accounts in a history', async () => {
    const answer = (body: unknown) => (async () => Response.json(body)) as typeof fetch;
    expect((await fetchHistory('hour', answer(HISTORY)))!.accounts).toEqual(acct);
    const odd = { ...acct, points: [{ t: 'x', seconds: 60, active: 1, bluesky: 1, elsewhere: 0 }, ...acct.points], apps: [{ domain: '<b>', active: 1, prevActive: 0, collections: [] }, ...acct.apps] };
    const got = await fetchHistory('hour', answer({ ...HISTORY, accounts: odd }));
    expect(got!.accounts!.points).toHaveLength(3);
    expect(got!.accounts!.apps).toHaveLength(2);
    expect((await fetchHistory('hour', answer({ ...HISTORY, accounts: { ...acct, total: null } })))!.accounts).toBeUndefined();
  });

  it('one toggle for the whole page, remembered', () => {
    localStorage.removeItem(MEASURE_KEY);
    const measure = createMeasure(document);
    const seen: string[] = [];
    measure.onChange((m) => seen.push(m));
    expect(measure.get()).toBe('records');
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-measure="accounts"]')];
    expect(buttons).toHaveLength(2); // the trends and the apps elsewhere
    buttons[1]!.click();
    expect(seen).toEqual(['accounts']);
    expect([...document.querySelectorAll('[data-measure="accounts"]')].map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'true']);
    expect(localStorage.getItem(MEASURE_KEY)).toBe('accounts');
    expect(createMeasure(document).get()).toBe('accounts');
    localStorage.removeItem(MEASURE_KEY);
  });

  it('axis numbers stay short', () => {
    expect(compactCount(21_345)).toBe('21.3k');
    expect(compactCount(1_200_000)).toBe('1.2m');
    expect(compactCount(950)).toBe('950');
  });
});

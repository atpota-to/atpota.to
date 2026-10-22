// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { niceMax, projectLast, segments, soFarWords } from '../src/scripts/weather-chart.js';
import { renderSparkline } from '../src/scripts/weather-spark.js';
import {
  APPS_EMPTY,
  APPS_TRICKLE,
  LIST_TOP,
  topBars,
  accountChange,
  indexChange,
  renderHeadlineChange,
  renderSky,
  accountSummary,
  accountsExponent,
  bigAmount,
  bindExplainers,
  diversityParts,
  EXPLAINERS,
  compactCount,
  coverageWords,
  createHistoryFeed,
  fetchHistory,
  formatRate,
  levelOf,
  ratesOf,
  renderHosts,
  hostsAge,
  hostsShare,
  renderReport,
  renderReportError,
  renderTrends,
  renderWindow,
  skyOfHistory,
  trendsRange,
  trendSummary,
  type History,
  type HistoryAccounts,
} from '../src/scripts/weather-page.js';
import { CONDITION_TEXT, DIVERSITY_SCALE, ERROR_TEXT, LEVEL_TEXT, type Reading } from '../src/scripts/weather.js';
import { setExplainer, type PoeExplanation } from '../src/poe/say.js';
import { bindLens, createLens, LENS_DEFAULT, LENS_KEY, type LensState } from '../src/scripts/weather-lens.js';
import { dockSummary, initLensDock, punctuate } from '../src/scripts/weather-dock.js';

/** The live reading, counting records, unless the test says otherwise (the page's own default is the last hour, by accounts). */
const lens = (change: Partial<LensState> = {}): LensState => ({ ...LENS_DEFAULT, window: 'now', measure: 'records', ...change });

// /weather: the atmosphere weather report, filled from one /api/atmosphere reading.

const PAGE = readFileSync(resolve(process.cwd(), 'weather/index.html'), 'utf8');
const MAIN = PAGE.slice(PAGE.indexOf('<main'), PAGE.indexOf('</main>') + '</main>'.length);

const READING: Reading = {
  measuredAt: '2026-10-20T16:18:00.000Z',
  seconds: 5,
  perSecond: { posts: 51, likes: 308, reposts: 52.2, follows: 24.1 },
  condition: 'stormy',
  records: { perSecond: 444, bluesky: 436, elsewhere: 8 },
  diversity: { index: 1.8, level: 'low', share: 0.52, spread: 12, apps: 12, collections: 40 },
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

  it('puts when the sky is busiest right under the forecast', () => {
    const tiles = [...report.querySelectorAll(':scope > .tile')].map((t) => t.getAttribute('aria-labelledby'));
    expect(tiles.indexOf('weather-heat-title')).toBe(tiles.indexOf('weather-forecast-title') + 1);
  });

  it('fills every tile from one reading', () => {
    renderReport(report, READING, lens());
    expect(report.dataset.state).toBe('ready');
    expect(text('[data-r-records]')).toBe('444'); // every new record, not just posts
    expect(text('[data-r-cond]')).toBe(CONDITION_TEXT.stormy);
    expect(text('[data-r-index]')).toBe('1.8');
    expect(text('[data-r-level]')).toBe('low');
    expect(text('[data-r-level-text]')).toBe(LEVEL_TEXT.low);
    expect(text('[data-r-ratio]')).toBe('1 in 56 new records came from outside bluesky');
    expect(text('[data-r-else-share]')).toBe('(1.8%)');
    expect(text('[data-r-apps-count]')).toBe('12 apps heard, top 2');
    expect(text('[data-r-event="deletes"]')).toBe('810'); // 13.5 a second, counted over the minute
    expect(text('[data-r-collections]')).toBe('40');
    expect(report.querySelector<HTMLElement>('[data-r-marker]')!.style.left).toMatch(/^13\.8/);
  });

  it('keeps where accounts live hidden until a reading carries the hosts, then fills it', () => {
    const tile = report.querySelector<HTMLElement>('[data-r-hosts]')!;
    renderReport(report, READING, lens());
    expect(tile.hidden).toBe(true);
    const hosts = {
      measuredAt: '2026-10-20T16:11:00.000Z',
      listed: 6442,
      active: 1887,
      bluesky: 90,
      independent: 1797,
      writing: { bluesky: 90, independent: 610, minutes: 30 },
      accounts: { bluesky: 23767508, independent: 363866 },
      diversity: { index: 7.48, share: 1.51, spread: 24.54 },
      top: [
        { hostname: 'blacksky.app', accounts: 42366 },
        { hostname: 'eurosky.social', accounts: 38029 },
      ],
    };
    renderHosts(report, hosts, Date.parse('2026-10-20T16:18:00.000Z'));
    expect(tile.hidden).toBe(false);
    expect(text('[data-h-active]')).toBe('1,887');
    expect(text('[data-h-index]')).toBe('7.5');
    // on its own scale, in words: early days, a third of the way along the first band
    expect(text('[data-h-level]')).toBe('early days');
    expect(text('[data-h-level-text]')).toBe("nearly every account still lives on bluesky's own servers.");
    const marker = report.querySelector<HTMLElement>('[data-h-marker]')!;
    expect(marker.hidden).toBe(false);
    expect(parseFloat(marker.style.left)).toBeCloseTo(34.4, 0);
    expect(text('[data-h-writing]')).toBe('700');
    expect(text('[data-h-writing-words]')).toBe('hosts that wrote in the last 30 minutes');
    expect(text('[data-h-age]')).toBe('counted 7 minutes ago');
    expect(text('[data-h-share]')).toBe("1.5% of all 24.1m accounts, active or not, live on independent hosts, spread across about 25 hosts' worth.");
    expect([...report.querySelectorAll('[data-h-top] .weather-bars__label')].map((el) => el.textContent)).toEqual(['blacksky.app', 'eurosky.social']);
    renderHosts(report, { ...hosts, writing: null });
    expect(report.querySelector<HTMLElement>('[data-h-writing-wrap]')!.hidden).toBe(true);
  });

  it('says where accounts live in words', () => {
    expect(hostsAge('2026-10-20T16:18:00.000Z', Date.parse('2026-10-20T16:18:20.000Z'))).toBe('counted just now');
    expect(hostsAge('2026-10-20T16:17:00.000Z', Date.parse('2026-10-20T16:18:00.000Z'))).toBe('counted 1 minute ago');
    const none = { measuredAt: '', listed: 1, active: 1, bluesky: 1, independent: 0, writing: null, accounts: { bluesky: 10, independent: 0 }, diversity: { index: 0, share: 0, spread: 0 }, top: [] };
    expect(hostsShare(none)).toBe("all 10 accounts live on bluesky's hosts.");
  });

  it('draws the apps as bars, longest for the busiest', () => {
    renderReport(report, READING, lens());
    const apps = [...report.querySelectorAll('[data-r-apps] li')];
    expect(apps.map((li) => li.querySelector('.weather-bars__label')!.textContent)).toEqual(['tangled.sh', 'whtwnd.com']);
    expect(apps[0]!.querySelector('.weather-bars__sub')!.textContent).toBe('sh.tangled.repo, sh.tangled.feed.star');
    expect(apps.map((li) => li.querySelector<HTMLElement>('.weather-bars__fill')!.style.width)).toEqual(['100%', '25%']);
    expect(apps[0]!.getAttribute('title')).toBe('20 in 5 seconds');
    expect(report.querySelector<HTMLElement>('[data-r-apps-empty]')!.hidden).toBe(true);
  });

  it('keeps each bar from one reading to the next, so it can grow, roll and trade places', () => {
    renderReport(report, READING, lens());
    const [tangled, whtwnd] = [...report.querySelectorAll('[data-r-apps] li')];
    renderReport(report, {
      ...READING,
      apps: [
        { domain: 'whtwnd.com', perSecond: 6, count: 30, collections: ['com.whtwnd.blog.entry'] },
        { domain: 'tangled.sh', perSecond: 3, count: 15, collections: [] },
      ],
    }, lens());
    const rows = [...report.querySelectorAll('[data-r-apps] li')];
    expect(rows).toEqual([whtwnd, tangled]);
    expect(rows.map((li) => li.querySelector('.weather-bars__value')!.textContent)).toEqual(['6', '3']);
    expect(rows.map((li) => li.querySelector<HTMLElement>('.weather-bars__fill')!.style.width)).toEqual(['100%', '50%']);
    expect(rows[1]!.querySelector('.weather-bars__sub')).toBeNull();
    renderReport(report, { ...READING, apps: [{ domain: 'x.y', perSecond: 1, count: 5, collections: [] }] }, lens());
    expect([...report.querySelectorAll('[data-r-apps] .weather-bars__label')].map((l) => l.textContent)).toEqual(['x.y']);
  });

  it('says so when nobody but bluesky was writing', () => {
    renderReport(report, { ...READING, apps: [], records: { perSecond: 400, bluesky: 400, elsewhere: 0 }, diversity: { index: 0, level: 'low', apps: 0, collections: 8 } }, lens());
    expect(report.querySelector<HTMLElement>('[data-r-apps-empty]')!.hidden).toBe(false);
    expect(report.querySelector<HTMLElement>('[data-r-bar-else]')!.hidden).toBe(true);
    expect(text('[data-r-apps-count]')).toBe('');
  });

  it('puts names from the firehose on the page as text, never markup', () => {
    renderReport(report, { ...READING, apps: [{ domain: 'x.y', perSecond: 1, count: 1, collections: ['<img src=x>'] }] }, lens());
    expect(report.querySelector('[data-r-apps] img')).toBeNull();
  });

  it('keeps the last reading when a check fails, and says so when none came', () => {
    renderReportError(report);
    expect(report.dataset.state).toBe('error');
    expect(text('[data-r-cond]')).toBe(ERROR_TEXT);
    renderReport(report, READING, lens());
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

  it('draws a sparkline of the last 60 seconds', () => {
    renderReport(report, { ...READING, source: 'station', seconds: 60, series }, lens());
    const spark = report.querySelector<HTMLElement>('[data-r-spark]')!;
    expect(spark.hidden).toBe(false);
    // the missing second breaks the line in two
    expect(spark.querySelector('path')!.getAttribute('d')!.match(/M/g)).toHaveLength(2);
  });

  it('a sampled reading has no sparkline', () => {
    renderReport(report, { ...READING, source: 'sample' }, lens());
    expect(report.querySelector<HTMLElement>('[data-r-spark]')!.hidden).toBe(true);
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

  it('works rates out from counts', () => {
    expect(ratesOf(point('x'))).toEqual({ records: 440, posts: 50 });
    expect(ratesOf(point('x', 0))).toEqual({ records: null, posts: null });
    expect(coverageWords(59)).toBe('under a minute');
    expect(coverageWords(150)).toBe('2 minutes');
    expect(coverageWords(90_000)).toBe('1 day');
  });

  it('sums the range up in a sentence, saying when the station is new', () => {
    const accounts = { seconds: 150, prevSeconds: 0, total: { active: 9000, bluesky: 8960, elsewhere: 45, index: 1.66 }, points: [], apps: [] };
    expect(trendSummary({ ...HISTORY, accounts })).toBe('the last hour (from 2 minutes of readings so far): 440 new records a second, diversity index 1.7.');
    expect(trendSummary({ ...HISTORY, total: point('x', 3600, 1_584_000, 3960) })).toBe('the last hour: 440 new records a second.');
    expect(trendSummary({ ...HISTORY, points: [], total: point('x', 0) })).toBe('no readings yet for the last hour. the station fills this in as it goes.');
  });

  it('draws both charts from the start of the range, the summary only for screen readers', () => {
    const section = report.querySelector<HTMLElement>('[data-r-trends]')!;
    renderTrends(section, HISTORY, NOW);
    expect(section.dataset.state).toBe('ready');
    const records = section.querySelector('[data-t-chart="records"]')!;
    expect(records.querySelector('svg')!.getAttribute('aria-label')).toMatch(/^new records a second/);
    expect(records.querySelectorAll('.weather-chart__line')).toHaveLength(1);
    const summary = section.querySelector('[data-t-summary]')!;
    expect(summary.textContent).toBe(trendSummary(HISTORY));
    expect(summary.classList.contains('visually-hidden')).toBe(true);
  });

  it('follows the lens: now is the last hour, a window its own range', () => {
    expect(trendsRange('now')).toBe('hour');
    expect(trendsRange('week')).toBe('week');
    // no range buttons or apps list of its own: the lens and the apps elsewhere have them
    const section = report.querySelector<HTMLElement>('[data-r-trends]')!;
    expect(section.querySelector('[data-range], [data-measure-toggle], [data-t-apps]')).toBeNull();
    renderTrends(section, HISTORY, NOW);
    expect(section.querySelector('[data-t-range]')!.textContent).toBe('the last hour');
  });

  it("draws records in the lens's unit, or each bucket's count for in all", () => {
    const section = report.querySelector<HTMLElement>('[data-r-trends]')!;
    const newest = () => {
      const host = section.querySelector('[data-t-chart="records"]')!;
      host.querySelector('svg')!.dispatchEvent(new FocusEvent('focus'));
      return host.querySelector('.weather-chart__tip')!.children[0]!.textContent;
    };
    renderTrends(section, HISTORY, NOW, 'records', 'minute');
    expect(section.querySelector('[data-t-chart-title="records"]')!.textContent).toBe('new records a minute');
    expect(newest()).toBe('26,400');
    expect(trendSummary(HISTORY, 'minute')).toBe('the last hour (from 2 minutes of readings so far): 26,400 new records a minute.');
    renderTrends(section, HISTORY, NOW, 'records', 'total');
    expect(section.querySelector('[data-t-chart-title="records"]')!.textContent).toBe('new records each minute');
    expect(newest()).toBe('13,200'); // the newest minute, half heard
    expect(trendSummary(HISTORY, 'total')).toBe('the last hour (from 2 minutes of readings so far): 66,000 new records.');
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

  it('a step still filling up is an estimate for the whole step, so it never draws as a dip', () => {
    const pts = [
      { t: 0, v: 100 },
      { t: 60_000, v: 30 },
    ];
    // a quarter of the way in by the clock, or a third by the seconds heard
    expect(projectLast(pts, 75_000, 60_000)[1]).toEqual({ t: 60_000, v: 120, soFar: 30 });
    expect(projectLast(pts, 75_000, 60_000, { heardMs: 20_000 })[1]).toEqual({ t: 60_000, v: 90, soFar: 30 });
    // not scaled, only marked; too early to guess; and a step that's over is left alone
    expect(projectLast(pts, 75_000, 60_000, { scale: false })[1]).toEqual({ t: 60_000, v: 30, soFar: 30 });
    expect(projectLast(pts, 63_000, 60_000)[1]).toEqual({ t: 60_000, v: null, soFar: 30 });
    expect(projectLast(pts, 120_000, 60_000)).toBe(pts);
    expect(soFarWords({ t: 0, v: 120, soFar: 30 }, String)).toEqual({ value: '30 so far', pace: 'on pace for about 120' });
    expect(soFarWords({ t: 0, v: null, soFar: 30 }, String)).toEqual({ value: '30 so far', pace: '' });
    // a count that doesn't add up grows slower than the time heard: a quarter in, ×4^0.5
    expect(projectLast(pts, 75_000, 60_000, { exponent: 0.5 })[1]).toEqual({ t: 60_000, v: 60, soFar: 30 });
  });

  it("the header's line goes out dashed to an estimate, and solid when there's none", () => {
    const host = document.createElement('div');
    renderSparkline(host, [10, 20, 30], undefined, true);
    expect(host.querySelectorAll('path:not(.weather-spark__projected)')).toHaveLength(1);
    expect(host.querySelector('.weather-spark__projected')!.getAttribute('d')).toMatch(/^M120\.0,[\d.]+L240\.0,[\d.]+$/);
    renderSparkline(host, [10, 20, 30]);
    expect(host.querySelector('.weather-spark__projected')).toBeNull();
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
  const point = (t: string, active: number, elsewhere: number, index: number, seconds = 60) => ({ t, seconds, active, bluesky: active - elsewhere + 10, elsewhere, index });
  const acct: HistoryAccounts = {
    seconds: 180,
    prevSeconds: 180,
    total: { active: 40_000, bluesky: 39_500, elsewhere: 900 },
    points: [point('2026-10-20T16:57:00.000Z', 20_000, 500, 8.1), point('2026-10-20T16:58:00.000Z', 21_000, 520, 8.4), point('2026-10-20T16:59:00.000Z', 22_000, 600, 9.2)],
    apps: [
      { domain: 'whtwnd.com', active: 300, prevActive: 200, collections: ['com.whtwnd.blog.entry'] },
      { domain: 'tangled.sh', active: 280, prevActive: 0, collections: [] },
    ],
  };
  const pts = (t: string) => ({ t, seconds: 60, creates: 26_400, bluesky: 26_334, elsewhere: 66, posts: 3000 });
  const HISTORY: History = { range: 'hour', points: [pts('2026-10-20T16:59:00.000Z')], total: pts('2026-10-20T17:00:00.000Z'), accounts: acct };
  const section = () => report.querySelector<HTMLElement>('[data-r-trends]')!;

  it("puts the last minute's active accounts in the last minute, and what the index is made of", () => {
    renderReport(report, LIVE, lens());
    const minute = report.querySelector<HTMLElement>('[data-r-minute-accounts]')!;
    expect(minute.hidden).toBe(false);
    expect(text('[data-r-active]')).toBe('21,345');
    expect(text('[data-r-acct-index]')).toBe('0.52% of 21,345 active accounts wrote outside bluesky, across about 12 apps.');
    renderReport(report, READING, lens());
    expect(minute.hidden).toBe(true);
    expect(text('[data-r-acct-index]')).toBe('0.52% of the accounts heard just now wrote outside bluesky, across about 12 apps.');
    // a reading from before the index went by accounts
    renderReport(report, { ...READING, diversity: { index: 1.8, level: 'low', apps: 12, collections: 40 } }, lens());
    expect(report.querySelector<HTMLElement>('[data-r-acct-index]')!.hidden).toBe(true);
  });

  it('words what an index is made of', () => {
    expect(diversityParts(0, 0, 100)).toBe('none of 100 active accounts wrote outside bluesky.');
    expect(diversityParts(0.4, 1.2, 100)).toBe('0.40% of 100 active accounts wrote outside bluesky, all in about one app.');
  });

  it('ranks the apps elsewhere by accounts, or by records when the reading has no accounts', () => {
    renderReport(report, LIVE, lens({ measure: 'accounts' }));
    const labels = () => [...report.querySelectorAll('[data-r-apps] .weather-bars__label')].map((l) => l.textContent);
    expect(labels()).toEqual(['whtwnd.com', 'tangled.sh']);
    expect(report.querySelector('[data-r-apps] .weather-bars__value')!.textContent).toBe('140');
    renderReport(report, LIVE, lens({ measure: 'records' }));
    expect(labels()).toEqual(['tangled.sh', 'whtwnd.com']);
    // no accounts in a sampled reading: records, and the tile says so
    renderReport(report, READING, lens({ measure: 'accounts' }));
    expect(labels()).toEqual(['tangled.sh', 'whtwnd.com']);
    const tag = report.querySelector<HTMLElement>('.weather-apps [data-tag]')!;
    expect(tag.hidden).toBe(false);
    expect(tag.textContent).toBe('by records');
  });

  it('draws the trends by accounts: each bucket, and the range as a union', () => {
    renderTrends(section(), HISTORY, NOW, 'accounts');
    const s = section();
    expect(s.dataset.measure).toBe('accounts');
    expect(s.querySelector('[data-t-summary]')!.textContent).toBe('the last hour (from 3 minutes of counting so far): 40,000 different accounts wrote something, 2.3% of them somewhere other than bluesky.');
    expect(s.querySelector('[data-t-chart-title="records"]')!.textContent).toBe('active accounts each minute');
    expect(s.querySelector('[data-t-chart-title="index"]')!.textContent).toBe('share of accounts writing elsewhere');
    expect(s.querySelector('[data-t-chart="records"] svg')!.getAttribute('aria-label')).toMatch(/^active accounts each minute/);
    // focusing a chart reads its newest point
    const newest = (chart: string) => {
      const host = s.querySelector(`[data-t-chart="${chart}"]`)!;
      host.querySelector('svg')!.dispatchEvent(new FocusEvent('focus'));
      return [...host.querySelector('.weather-chart__tip')!.children].map((c) => c.textContent);
    };
    expect(newest('records')[0]).toBe('22,000');
    expect(newest('index')[0]).toBe('2.7%');
    expect(newest('records')[0]).not.toMatch(/so far/); // 16:59 is over at 17:00
    expect(s.querySelector('.weather-chart__line--projected')).toBeNull();
    // still filling up: what's in so far, and where it's going by the seconds heard of it
    renderTrends(section(), HISTORY, NOW - 30_000, 'accounts');
    expect(newest('records')).toEqual(['22,000 so far', '4:59 pm', '']);
    const half = { ...acct, points: [...acct.points.slice(0, -1), point('2026-10-20T16:59:00.000Z', 22_000, 600, 9.2, 30)] };
    renderTrends(section(), { ...HISTORY, accounts: half }, NOW - 30_000, 'accounts');
    // half heard, and 40,000 over three minutes of about 20,500 each says accounts grow as time^0.61: not 44,000
    expect(accountsExponent(acct)).toBeCloseTo(0.608, 3);
    expect(accountsExponent({ ...acct, points: acct.points.slice(-2) })).toBe(1); // one full bucket says nothing
    expect(accountsExponent({ ...acct, total: { ...acct.total, active: 100 } })).toBe(0.3); // never wilder than that
    expect(newest('records')).toEqual(['22,000 so far', '4:59 pm', 'on pace for about 33,542']);
    expect(newest('index')).toEqual(['2.7% so far', '4:59 pm', '']); // a share isn't scaled
    expect(s.querySelector('[data-t-chart="records"] .weather-chart__line--projected')).not.toBeNull();
    expect(s.querySelector('[data-t-chart="records"] .weather-chart__dot--projected')).not.toBeNull();

    // and back: records put their own titles back, and the diversity index comes from the accounts
    renderTrends(section(), HISTORY, NOW, 'records');
    expect(s.querySelector('[data-t-chart-title="records"]')!.textContent).toBe('new records a second');
    expect(newest('records')[0]).toBe('440');
    expect(s.querySelector('[data-t-chart-title="index"]')!.textContent).toBe('diversity index');
    expect(newest('index')[0]).toBe('9.2');
  });

  it('says so when there are no account counts yet, or they cannot be read', () => {
    expect(accountSummary({ ...HISTORY, accounts: undefined })).toBe('the account counts are hard to read right now. the records are still here.');
    expect(accountSummary({ ...HISTORY, accounts: { ...acct, seconds: 0, points: [], apps: [], total: { active: 0, bluesky: 0, elsewhere: 0 } } })).toMatch(/^no account counts yet for the last hour/);
    renderTrends(section(), { ...HISTORY, accounts: undefined }, NOW, 'accounts');
    expect(section().querySelector('[data-t-summary]')!.textContent).toBe('the account counts are hard to read right now. the records are still here.');
  });

  it('compares apps\' accounts only when both windows were heard about as well', () => {
    const app = acct.apps[0]!;
    expect(accountChange(app, acct, 'yesterday')).toEqual({ text: '↑ 50%', words: 'up 50% on yesterday', trend: 'up' });
    expect(accountChange({ ...app, active: 210 }, acct, 'yesterday')!.trend).toBe('steady');
    expect(accountChange({ ...app, active: 100 }, acct, 'yesterday')!.trend).toBe('down');
    expect(accountChange(app, { ...acct, prevSeconds: 90 }, 'yesterday')).toBeNull();
    expect(accountChange(app, { ...acct, prevSeconds: 400 }, 'yesterday')).toBeNull();
  });

  it('compares the diversity index with the earlier window\'s only when both were heard about as well', () => {
    const withPrev = { ...acct, total: { ...acct.total, index: 6.6 }, prev: { seconds: 180, active: 38_000, bluesky: 37_600, elsewhere: 700, index: 6 } };
    expect(indexChange(withPrev, 'the day before')).toEqual({ text: '↑ 10%', words: 'up 10% on the day before', trend: 'up' });
    expect(indexChange({ ...withPrev, total: { ...withPrev.total, index: 4.5 } }, 'x')!.text).toBe('↓ 25%');
    expect(indexChange(acct, 'x')).toBeNull();
    expect(indexChange({ ...withPrev, prev: { ...withPrev.prev, seconds: 90 } }, 'x')).toBeNull();
    expect(indexChange({ ...withPrev, prev: { ...withPrev.prev, index: undefined } }, 'x')).toBeNull();
  });

  it('puts the diversity index\'s chip in its tile, says what it compares with, and keeps small moves steady', () => {
    const prev = { seconds: 180, active: 38_000, bluesky: 37_600, elsewhere: 700, index: 6 };
    renderSky(report, skyOfHistory({ ...HISTORY, accounts: { ...acct, total: { ...acct.total, index: 6.6 }, prev } }), lens({ window: 'hour', measure: 'accounts' }));
    const chipEl = report.querySelector<HTMLElement>('[data-r-index-change]')!;
    expect(chipEl.dataset.trend).toBe('up');
    expect(chipEl.textContent).toBe('↑ 10%up 10% on the same hour yesterday');
    expect(chipEl.title).toBe('up 10% on the same hour yesterday');
    const note = report.querySelector<HTMLElement>('[data-r-index-note]')!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe('the arrow compares with the same hour yesterday.');
    expect(indexChange({ ...acct, total: { ...acct.total, index: 6.2 }, prev }, 'x')).toEqual({ text: '→', words: 'about the same as x', trend: 'steady' });
    // no earlier window to compare with: no chip, no note
    renderSky(report, skyOfHistory(HISTORY), lens({ window: 'hour', measure: 'accounts' }));
    expect(chipEl.dataset.trend).toBeUndefined();
    expect(chipEl.hasAttribute('title')).toBe(false);
    expect(note.hidden).toBe(true);
  });

  it('gives the header the chip the "last hour" tile has for what it shows: records, or accounts', () => {
    const up = { text: '↑ 4%', words: 'up 4% on the hour before', trend: 'up' as const };
    const down = { text: '↓ 2%', words: 'down 2% on the hour before', trend: 'down' as const };
    const changes = { creates: up, active: down } as unknown as Parameters<typeof renderHeadlineChange>[1];
    renderSky(report, skyOfHistory(HISTORY), lens({ window: 'hour', measure: 'records' }));
    renderHeadlineChange(report, changes);
    const el = report.querySelector<HTMLElement>('[data-r-headline-change]')!;
    expect(el.dataset.trend).toBe('up');
    renderSky(report, skyOfHistory(HISTORY), lens({ window: 'hour', measure: 'accounts' }));
    expect(el.dataset.trend).toBe('down');
    expect(el.title).toBe('down 2% on the hour before');
    renderHeadlineChange(report, null);
    expect(el.dataset.trend).toBeUndefined();
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

  it('axis numbers stay short', () => {
    expect(compactCount(21_345)).toBe('21.3k');
    expect(compactCount(1_200_000)).toBe('1.2m');
    expect(compactCount(950)).toBe('950');
  });
});

describe("what's this? Poe explains", () => {
  it('puts a button by the diversity index\'s title, and leaves the long story to Poe', () => {
    const tile = report.querySelector('.weather-diversity')!;
    const button = tile.querySelector<HTMLButtonElement>('.weather-tile__titled > [data-poe-explain="diversity"]')!;
    expect(button.previousElementSibling!.textContent).toBe('diversity index');
    expect(button.getAttribute('aria-label')).toBe("what's the diversity index? ask poe");
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(tile.textContent).not.toMatch(/square root/);
  });

  it('opens Poe on the question and its answer, back to the button after', () => {
    const asked: PoeExplanation[] = [];
    const off = setExplainer((e) => {
      asked.push(e);
      return true;
    });
    try {
      bindExplainers(report);
      const button = report.querySelector<HTMLElement>('[data-poe-explain="diversity"]')!;
      expect(button.hidden).toBe(false);
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      button.click(); // from the keyboard (no pointer: detail 0)
      expect(asked.map((e) => [e.question, e.opener, e.via])).toEqual([
        ["what's the diversity index?", button, 'pointer'],
        ["what's the diversity index?", button, 'keyboard'],
      ]);
      expect(asked[0]!.answer).toBe(EXPLAINERS.diversity!.answer);
    } finally {
      off();
    }
  });

  it('hides a button it has no answer for', () => {
    report.insertAdjacentHTML('beforeend', '<button type="button" data-poe-explain="nonsense">?</button>');
    bindExplainers(report);
    expect(report.querySelector<HTMLElement>('[data-poe-explain="nonsense"]')!.hidden).toBe(true);
  });

  it("the answers are in Poe's voice, and the diversity index's says the page's own levels", () => {
    for (const { question, answer } of Object.values(EXPLAINERS)) {
      for (const words of [question, answer.replace(/`[^`]*`/g, '')]) {
        expect(words).toBe(words.toLowerCase());
        expect(words).not.toMatch(/[\u2014\u2013]/); // no em or en dashes
      }
      expect(answer.trim()).toMatch(/\(◕‿◕\)$|[.?!]$/);
    }
    const levels = EXPLAINERS.diversity!.answer;
    expect(levels).toContain('0 to 2 is low, 3 to 5 moderate, 6 and 7 high, 8 to 10 very high, and 11 and up extreme');
    expect(DIVERSITY_SCALE.map(([, from]) => from)).toEqual([0, 3, 6, 8, 11]);
  });
});

describe('the lists', () => {
  it('show the busiest five, and leave out any that would read 0', () => {
    const bar = (label: string, perSecond: number, value?: string) => ({ label, perSecond, count: perSecond * 60, value });
    const bars = [bar('a', 9), bar('b', 0.04), bar('c', 7), bar('d', 0.06), bar('e', 3), bar('f', 2), bar('g', 1), bar('h', 0, '0')];
    expect(topBars(bars).map((b) => b.label)).toEqual(['a', 'c', 'd', 'e', 'f']);
    expect(LIST_TOP).toBe(5);
  });

  it('elsewhere and bluesky: the top five, none at 0, and the count says so', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ domain: `app${i}.com`, perSecond: 10 - i, count: (10 - i) * 5, collections: [] }));
    renderReport(report, {
      ...READING,
      apps: many,
      bluesky: [
        { nsid: 'app.bsky.feed.like', perSecond: 308, count: 1540 },
        { nsid: 'app.bsky.graph.starterpack', perSecond: 0.01, count: 1 },
      ],
    }, lens());
    expect(report.querySelectorAll('[data-r-apps] li')).toHaveLength(5);
    expect(text('[data-r-apps-count]')).toBe('12 apps heard, top 5');
  });

  it("says when other apps only wrote a trickle, rather than that nobody did", () => {
    renderReport(report, { ...READING, apps: [{ domain: 'x.y', perSecond: 0.02, count: 1, collections: [] }] }, lens());
    const empty = report.querySelector<HTMLElement>('[data-r-apps-empty]')!;
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toBe(APPS_TRICKLE);
    renderReport(report, { ...READING, apps: [], diversity: { ...READING.diversity!, apps: 0 } }, lens());
    expect(empty.textContent).toBe(APPS_EMPTY);
  });
});

describe('the lens', () => {
  beforeEach(() => {
    localStorage.removeItem(LENS_KEY);
    history.replaceState(null, '', '/weather');
  });

  it('floats in the dock, which comes right after the header, before every tile that follows it', () => {
    const kids = [...report.children];
    const dock = report.querySelector('[data-weather-dock]')!;
    expect(kids.indexOf(dock)).toBe(kids.indexOf(report.querySelector('[data-weather-hero]')!) + 1);
    // no bar in the page as well: the dock's are the only controls
    expect(report.querySelectorAll('[data-lens-window="hour"]')).toHaveLength(1);
    const bar = dock.querySelector<HTMLElement>('.weather-dock__panel')!;
    expect([...bar.querySelectorAll<HTMLElement>('[data-lens-window]')].map((b) => [b.dataset.lensWindow, b.textContent])).toEqual([
      ['now', 'now'],
      ['hour', '1h'],
      ['day', '24h'],
      ['week', '7d'],
      ['month', '30d'],
    ]);
    expect([...bar.querySelectorAll<HTMLElement>('[data-lens-measure]')].map((b) => b.textContent)).toEqual(['accounts', 'records']);
    expect([...bar.querySelectorAll('option')].map((o) => o.value)).toEqual(['second', 'minute', 'hour', 'day', 'total']);
    // the old per-tile toggles are gone
    expect(report.querySelector('[data-measure-toggle], [data-range], [data-s-toggle]')).toBeNull();
    // the tiles that keep their own times come after their own heading
    const group = kids.indexOf(report.querySelector('.weather-group')!);
    for (const id of ['weather-today-title', 'weather-forecast-title', 'weather-heat-title']) expect(kids.indexOf(report.querySelector(`[aria-labelledby="${id}"]`)!)).toBeGreaterThan(group);
    for (const id of ['weather-trends-title', 'weather-apps-title', 'weather-minute-title']) expect(kids.indexOf(report.querySelector(`[aria-labelledby="${id}"]`)!)).toBeLessThan(group);
  });

  it("the dock's strip says it in the controls' words", () => {
    const bar = report.querySelector<HTMLElement>('.weather-dock__panel')!;
    expect(dockSummary(bar, LENS_DEFAULT)).toBe('1h · accounts');
    expect(dockSummary(bar, { window: 'day', measure: 'records', unit: 'hour' })).toBe('24h · records · per hour');
    expect(dockSummary(bar, { window: 'now', measure: 'records', unit: 'total' })).toBe('now · records · in all');
  });

  it('the dock shows once bound, opens to the controls with a tap on its strip, and a tap elsewhere puts it away', () => {
    const dock = report.querySelector<HTMLElement>('[data-weather-dock]')!;
    const panel = dock.querySelector<HTMLElement>('.weather-dock__panel')!;
    const strip = dock.querySelector<HTMLButtonElement>('.weather-dock__strip')!;
    expect(dock.hidden).toBe(true);
    const l = createLens('');
    initLensDock(report, l);
    bindLens(report, l);
    expect(dock.hidden).toBe(false);
    expect(panel.hidden).toBe(true);
    // jsdom lays every section at the top, so the strip is in the last one, where it lives: the measure doesn't reach it
    const visible = () => [...dock.querySelectorAll<HTMLElement>('[data-dock-now] [data-part]')].filter((s) => !s.hidden).map((s) => s.textContent).join('');
    expect(dock.dataset.section).toBe('hosts');
    expect(visible()).toBe('1h');
    const now = dock.querySelector<HTMLElement>('[data-dock-now]')!;
    punctuate(now, '');
    expect(visible()).toBe('1h · accounts');
    punctuate(now, 'window measure');
    expect(visible()).toBe('');
    // the header says what the number is over, and a tap on it opens the controls too
    const period = report.querySelector<HTMLButtonElement>('[data-r-period]')!;
    expect(period.textContent).toBe('the last hour');
    period.click();
    expect(panel.hidden).toBe(false);
    expect(report.ownerDocument.activeElement).toBe(panel.querySelector('[data-lens-window="hour"]'));
    l.set({ window: 'now' });
    expect(period.textContent).toBe('right now');
    l.set({ window: 'hour' });
    strip.click();
    expect(panel.hidden).toBe(true);
    strip.click();
    expect(panel.hidden).toBe(false);
    expect(strip.getAttribute('aria-expanded')).toBe('true');
    // a choice keeps it open, to make another
    panel.querySelector<HTMLButtonElement>('[data-lens-window="week"]')!.click();
    expect(l.get().window).toBe('week');
    expect(visible()).toBe('7d'); // still where it lives: the window shows, the measure doesn't
    panel.querySelector<HTMLButtonElement>('[data-lens-measure="records"]')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(panel.hidden).toBe(false);
    report.querySelector('[data-weather-hero]')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(panel.hidden).toBe(true);
    expect(strip.getAttribute('aria-expanded')).toBe('false');
  });

  it('starts from the address, else this browser, else the last hour, accounts, a second', () => {
    expect(LENS_DEFAULT).toEqual({ window: 'hour', measure: 'accounts', unit: 'second' });
    expect(createLens('?w=now').get().window).toBe('now');
    expect(createLens('').get()).toEqual(LENS_DEFAULT);
    expect(createLens('?m=records').get().measure).toBe('records');
    expect(createLens('?w=24h&m=records&u=hour').get()).toEqual({ window: 'day', measure: 'records', unit: 'hour' });
    expect(createLens('?w=lots&u=fortnight').get()).toEqual(LENS_DEFAULT);
    localStorage.setItem(LENS_KEY, JSON.stringify({ window: 'week', measure: 'records', unit: 'nope' }));
    expect(createLens('').get()).toEqual({ window: 'week', measure: 'records', unit: 'second' });
    expect(createLens('?w=1h').get().window).toBe('hour');
  });

  it('keeps each change in the address and this browser, and only says so when something changed', () => {
    const l = createLens('');
    const seen: string[] = [];
    l.onChange((now, was) => seen.push(`${was.window}→${now.window} ${now.unit}`));
    l.set({ window: 'day' });
    l.set({ window: 'day' });
    l.set({ unit: 'total' });
    expect(seen).toEqual(['hour→day second', 'day→day total']);
    expect(location.search).toBe('?w=24h&u=total');
    expect(JSON.parse(localStorage.getItem(LENS_KEY)!)).toEqual({ window: 'day', measure: 'accounts', unit: 'total' });
    l.set({ measure: 'records' });
    expect(new URLSearchParams(location.search).get('m')).toBe('records');
    l.set({ measure: 'accounts' });
    l.set({ window: 'hour', unit: 'second' });
    expect(location.search).toBe('');
    l.set({ window: 'now' });
    expect(location.search).toBe('?w=now');
  });

  it('the bar and the header\'s unit drive it, and the unit stands aside for accounts', () => {
    const l = createLens('');
    bindLens(report, l);
    // accounts first: the unit waits for records
    expect(report.querySelector('[data-lens-measure="accounts"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(report.querySelector<HTMLSelectElement>('[data-lens-unit]')!.disabled).toBe(true);
    report.querySelector<HTMLButtonElement>('[data-lens-measure="records"]')!.click();
    report.querySelector<HTMLButtonElement>('[data-lens-window="week"]')!.click();
    expect(l.get().window).toBe('week');
    expect(report.querySelector('[data-lens-window="week"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(report.querySelector('[data-lens-window="now"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(report.dataset.window).toBe('week');
    const select = report.querySelector<HTMLSelectElement>('[data-lens-unit]')!;
    select.value = 'day';
    select.dispatchEvent(new Event('change'));
    expect(l.get().unit).toBe('day');
    // a tap on "rec/sec" moves the unit on, round to totals and back
    report.querySelector<HTMLButtonElement>('[data-r-unit]')!.click();
    expect(l.get().unit).toBe('total');
    report.querySelector<HTMLButtonElement>('[data-r-unit]')!.click();
    expect(l.get().unit).toBe('second');
    report.querySelector<HTMLButtonElement>('[data-lens-measure="accounts"]')!.click();
    expect(select.disabled).toBe(true);
  });
});

describe('in the lens', () => {
  const LIVE: Reading = {
    ...READING,
    source: 'station',
    seconds: 60,
    accounts: { active: 21_345, bluesky: 21_100, elsewhere: 620, index: 2.9, apps: [{ domain: 'whtwnd.com', accounts: 140, collections: [] }] },
  };
  const point = (t: string, seconds: number, creates: number) => ({ t, seconds, creates, bluesky: creates - creates / 100, elsewhere: creates / 100, posts: creates / 10 });
  const DAY: History = {
    range: 'day',
    points: [point('2026-10-20T15:00:00.000Z', 3600, 1_440_000), point('2026-10-20T16:00:00.000Z', 3600, 1_800_000)],
    total: { ...point('2026-10-20T17:00:00.000Z', 86_400, 38_016_000), likes: 20_000_000, reposts: 3_000_000, follows: 2_000_000 },
    apps: [
      { domain: 'tangled.sh', creates: 86_400, prevCreates: 43_200, collections: ['sh.tangled.repo'] },
      { domain: 'whtwnd.com', creates: 8640, prevCreates: 0, collections: [] },
    ],
    compare: { seconds: 86_400, prevSeconds: 86_400, lagMs: 86_400_000 },
    accounts: {
      seconds: 86_400,
      prevSeconds: 86_400,
      total: { active: 2_000_000, bluesky: 1_990_000, elsewhere: 60_000, index: 4.2 },
      points: [
        { t: '2026-10-20T15:00:00.000Z', seconds: 3600, active: 300_000, bluesky: 299_000, elsewhere: 5000, index: 3.9 },
        { t: '2026-10-20T16:00:00.000Z', seconds: 3600, active: 320_000, bluesky: 318_000, elsewhere: 6000, index: 4.1 },
      ],
      apps: [{ domain: 'tangled.sh', active: 9000, prevActive: 6000, collections: [] }],
    },
  };
  const bars = (sel: string) => [...report.querySelectorAll(`${sel} li`)].map((li) => [li.querySelector('.weather-bars__label')!.textContent, li.querySelector('.weather-bars__value')!.textContent]);

  it("puts the header's number in the lens's unit, or totals, and says what it is", () => {
    renderReport(report, LIVE, lens({ unit: 'minute' }));
    expect(text('[data-r-records]')).toBe('26,640');
    expect(text('[data-r-unit]')).toBe('rec/min');
    expect(text('[data-r-unit-words]')).toBe('new records a minute');
    expect(report.querySelector('[data-r-unit]')!.getAttribute('aria-label')).toBe('a minute. change to an hour');
    expect(text('[data-r-cond]')).toBe(CONDITION_TEXT.stormy); // now is still the weather
    renderReport(report, LIVE, lens({ unit: 'day' }));
    expect(text('[data-r-records]')).toBe('38.4m');
    renderReport(report, LIVE, lens({ unit: 'total' }));
    expect(text('[data-r-records]')).toBe('26,640');
    expect(text('[data-r-unit]')).toBe('records');
    expect(text('[data-r-unit-words]')).toBe('new records in the last minute');
    renderReport(report, LIVE, lens({ measure: 'accounts', unit: 'hour' }));
    expect(text('[data-r-records]')).toBe('21,345');
    expect([bigAmount(99_999), bigAmount(222_380), bigAmount(1_234_567), bigAmount(38_400_000)]).toEqual(['99,999', '222k', '1.23m', '38.4m']);
    expect(text('[data-r-unit]')).toBe('accounts'); // live, the line under it is the weather, not what's counted
    expect(report.querySelector<HTMLButtonElement>('[data-r-unit]')!.disabled).toBe(true);
    expect(report.querySelector<HTMLElement>('[data-r-spark]')!.hidden).toBe(true); // its line is records
  });

  it('bluesky and everyone else in the unit, or by accounts', () => {
    renderReport(report, LIVE, lens({ unit: 'hour' }));
    expect(text('[data-r-bsky]')).toBe('1.6m');
    expect([...report.querySelectorAll('[data-r-mix-unit]')].map((u) => u.textContent)).toEqual(['an hour', 'an hour']);
    expect(text('[data-r-total-words]')).toBe('new records an hour in all');
    expect(report.querySelector<HTMLElement>('[data-r-collections-wrap]')!.hidden).toBe(false);
    renderReport(report, LIVE, lens({ measure: 'accounts' }));
    expect(text('[data-r-ratio]')).toBe('1 in 34 active accounts wrote outside bluesky');
    expect(text('[data-r-else]')).toBe('620');
    expect(text('[data-r-else-share]')).toBe('(2.9%)');
    expect([...report.querySelectorAll('[data-r-mix-unit]')].map((u) => u.textContent)).toEqual(['accounts', 'accounts']);
    expect(text('[data-r-total]')).toBe('21,345');
    expect(report.querySelector<HTMLElement>('[data-r-collections-wrap]')!.hidden).toBe(true);
  });

  it('the diversity index is always by accounts, and says so when the lens counts records', () => {
    renderReport(report, LIVE, lens());
    const tag = report.querySelector<HTMLElement>('.weather-diversity [data-tag]')!;
    expect([tag.hidden, tag.textContent]).toEqual([false, 'by accounts']);
    renderReport(report, LIVE, lens({ measure: 'accounts' }));
    expect(tag.hidden).toBe(true);
  });

  it('a window: the whole of it, from its history', () => {
    const sky = skyOfHistory(DAY);
    expect(sky.records!.perSecond).toBe(440);
    expect(sky.diversity).toEqual({ index: 4.2, level: 'moderate', share: 3 });
    expect(sky.coverage).toBe('');
    expect(sky.bluesky.map((b) => b.nsid)).toEqual(['app.bsky.feed.like', 'app.bsky.feed.post', 'app.bsky.feed.repost', 'app.bsky.graph.follow']);
    expect(levelOf(0)).toBe('low');
    expect(levelOf(11.5)).toBe('extreme');

    renderReport(report, LIVE, lens({ window: 'day' })); // the live reading leaves a window's tiles be
    expect(text('[data-r-records]')).toBe('–');
    renderWindow(report, DAY, lens({ window: 'day' }));
    expect(text('[data-r-records]')).toBe('440');
    expect(text('[data-r-cond]')).toBe('on average over the last 24 hours');
    expect(report.querySelector<HTMLElement>('[data-r-spark]')!.hidden).toBe(false);
    expect(text('[data-r-index]')).toBe('4.2');
    expect(text('[data-r-level]')).toBe('moderate');
    expect(text('[data-r-acct-index]')).toBe('3.0% of 2,000,000 active accounts over the last 24 hours wrote outside bluesky.');
    expect(report.querySelector<HTMLElement>('[data-r-collections-wrap]')!.hidden).toBe(true);
    expect(bars('[data-r-apps]')).toEqual([
      ['tangled.sh', '1'],
      ['whtwnd.com', '0.1'],
    ]);
    expect(report.querySelector('[data-r-apps] .weather-bars__change')!.getAttribute('data-trend')).toBe('up');
    expect(text('[data-r-apps-note]')).toBe('new records a second. arrows compare with the day before.');
    expect(text('[data-r-apps-count]')).toBe('top 2');

    renderWindow(report, DAY, lens({ window: 'day', unit: 'total' }));
    expect(text('[data-r-records]')).toBe('38m');
    expect(text('[data-r-cond]')).toBe('new records in the last 24 hours');
    expect(bars('[data-r-apps]')[0]).toEqual(['tangled.sh', '86,400']);

    renderWindow(report, DAY, lens({ window: 'day', measure: 'accounts' }));
    expect(text('[data-r-records]')).toBe('2m');
    expect(text('[data-r-cond]')).toBe('different accounts wrote something in the last 24 hours');
    expect(bars('[data-r-apps]')).toEqual([['tangled.sh', '9,000']]);
    expect(text('[data-r-apps-note]')).toBe('active accounts. arrows compare with the day before.');
  });

  it('says how much of a window the station has heard, and when there are no account counts for it', () => {
    const young: History = { ...DAY, total: { ...DAY.total, seconds: 7200, creates: 3_168_000 }, accounts: undefined };
    renderWindow(report, young, lens({ window: 'day' }));
    expect(text('[data-r-cond]')).toBe('on average over the last 24 hours (from 2 hours of readings so far)');
    expect(text('[data-r-index]')).toBe('–');
    expect(text('[data-r-level-text]')).toBe('no account counts for the last 24 hours yet.');
    // accounts asked for, none to give: records, and the tiles say so
    renderWindow(report, young, lens({ window: 'day', measure: 'accounts' }));
    expect(text('[data-r-cond]')).toMatch(/^on average over/);
    expect(report.querySelector('.weather-mix [data-tag]')!.textContent).toBe('by records');
  });

  it('one request for a range, however many tiles ask', async () => {
    let asked = 0;
    const feed = createHistoryFeed((async () => (asked++, Response.json(DAY))) as typeof fetch);
    const [a, b] = await Promise.all([feed.get('day'), feed.get('day')]);
    expect(a).toBe(b);
    await feed.get('day');
    expect(asked).toBe(1);
    await feed.get('day', 0);
    expect(asked).toBe(2);
  });
});

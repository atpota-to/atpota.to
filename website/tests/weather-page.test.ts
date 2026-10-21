// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { niceMax, segments } from '../src/scripts/weather-chart.js';
import {
  accountChange,
  accountSummary,
  bindExplainers,
  diversityParts,
  EXPLAINERS,
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
import { CONDITION_TEXT, DIVERSITY_SCALE, ERROR_TEXT, LEVEL_TEXT, type Reading } from '../src/scripts/weather.js';
import { setExplainer, type PoeExplanation } from '../src/poe/say.js';

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
    expect(text('[data-r-event="deletes"]')).toBe('810'); // 13.5 a second, counted over the minute
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

  it('keeps each bar from one reading to the next, so it can grow, roll and trade places', () => {
    renderReport(report, READING);
    const [tangled, whtwnd] = [...report.querySelectorAll('[data-r-apps] li')];
    renderReport(report, {
      ...READING,
      apps: [
        { domain: 'whtwnd.com', perSecond: 6, count: 30, collections: ['com.whtwnd.blog.entry'] },
        { domain: 'tangled.sh', perSecond: 3, count: 15, collections: [] },
      ],
    });
    const rows = [...report.querySelectorAll('[data-r-apps] li')];
    expect(rows).toEqual([whtwnd, tangled]);
    expect(rows.map((li) => li.querySelector('.weather-bars__value')!.textContent)).toEqual(['6', '3']);
    expect(rows.map((li) => li.querySelector<HTMLElement>('.weather-bars__fill')!.style.width)).toEqual(['100%', '50%']);
    expect(rows[1]!.querySelector('.weather-bars__sub')).toBeNull();
    renderReport(report, { ...READING, apps: [{ domain: 'x.y', perSecond: 1, count: 5, collections: [] }] });
    expect([...report.querySelectorAll('[data-r-apps] .weather-bars__label')].map((l) => l.textContent)).toEqual(['x.y']);
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

  it('draws a sparkline of the last 60 seconds', () => {
    renderReport(report, { ...READING, source: 'station', seconds: 60, series });
    const spark = report.querySelector<HTMLElement>('[data-r-spark]')!;
    expect(spark.hidden).toBe(false);
    // the missing second breaks the line in two
    expect(spark.querySelector('path')!.getAttribute('d')!.match(/M/g)).toHaveLength(2);
  });

  it('a sampled reading has no sparkline', () => {
    renderReport(report, { ...READING, source: 'sample' });
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

  it('offers the last hour, day, week and 30 days', () => {
    const buttons = [...report.querySelectorAll<HTMLButtonElement>('[data-range]')];
    expect(buttons.map((b) => [b.dataset.range, b.textContent])).toEqual([
      ['hour', '1h'],
      ['day', '1d'],
      ['week', '1w'],
      ['month', '30d'],
    ]);
    expect(buttons.every((b) => b.getAttribute('aria-label')?.startsWith('last '))).toBe(true);
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
    renderReport(report, LIVE);
    const minute = report.querySelector<HTMLElement>('[data-r-minute-accounts]')!;
    expect(minute.hidden).toBe(false);
    expect(text('[data-r-active]')).toBe('21,345');
    expect(text('[data-r-acct-index]')).toBe('0.52% of 21,345 active accounts wrote outside bluesky, across about 12 apps.');
    renderReport(report, READING);
    expect(minute.hidden).toBe(true);
    expect(text('[data-r-acct-index]')).toBe('0.52% of the accounts heard just now wrote outside bluesky, across about 12 apps.');
    // a reading from before the index went by accounts
    renderReport(report, { ...READING, diversity: { index: 1.8, level: 'low', apps: 12, collections: 40 } });
    expect(report.querySelector<HTMLElement>('[data-r-acct-index]')!.hidden).toBe(true);
  });

  it('words what an index is made of', () => {
    expect(diversityParts(0, 0, 100)).toBe('none of 100 active accounts wrote outside bluesky.');
    expect(diversityParts(0.4, 1.2, 100)).toBe('0.40% of 100 active accounts wrote outside bluesky, all in about one app.');
  });

  it('ranks the apps elsewhere by accounts, or by records when the reading has no accounts', () => {
    renderReport(report, LIVE, 'accounts');
    const labels = () => [...report.querySelectorAll('[data-r-apps] .weather-bars__label')].map((l) => l.textContent);
    expect(labels()).toEqual(['whtwnd.com', 'tangled.sh']);
    expect(report.querySelector('[data-r-apps] .weather-bars__value')!.textContent).toBe('140');
    renderReport(report, LIVE, 'records');
    expect(labels()).toEqual(['tangled.sh', 'whtwnd.com']);
    renderReport(report, READING, 'accounts');
    expect(labels()).toEqual(['tangled.sh', 'whtwnd.com']);
  });

  it('draws the trends by accounts: each bucket, the range as a union, and apps by accounts', () => {
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
    expect(newest('records')[1]).not.toMatch(/so far/); // 16:59 is over at 17:00
    renderTrends(section(), HISTORY, NOW - 30_000, 'accounts');
    expect(newest('records')[1]).toMatch(/\(so far\)$/);
    renderTrends(section(), HISTORY, NOW, 'accounts');
    expect(s.querySelector('[data-t-apps-title]')!.textContent).toBe('busiest apps elsewhere, the last hour: active accounts');
    const rows = [...s.querySelectorAll('[data-t-apps] li')];
    expect(rows.map((r) => [r.querySelector('.weather-bars__label')!.textContent, r.querySelector('.weather-bars__value')!.textContent, r.querySelector('.weather-bars__change')!.getAttribute('data-trend')])).toEqual([
      ['whtwnd.com', '300', 'up'],
      ['tangled.sh', '280', 'new'],
    ]);

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
    expect(section().querySelector<HTMLElement>('[data-t-apps-wrap]')!.hidden).toBe(true);
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

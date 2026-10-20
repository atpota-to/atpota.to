// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { BLUESKY_NAMES, formatRate, renderReport, renderReportError } from '../src/scripts/weather-page.js';
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
    expect(text('[data-r-posts]')).toBe('51');
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

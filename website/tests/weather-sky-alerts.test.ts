// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALERT_MS, ALERTS_KEY, alertsFor, createAlertDesk, GAP_MS, newAppAlert, type WeatherAlert } from '../src/scripts/weather-alerts.js';
import { smoothPath } from '../src/scripts/weather-chart.js';
import { watchNewApps } from '../src/scripts/weather-page.js';
import { cloudCount, MAX_CLOUDS, renderClouds } from '../src/scripts/weather-sky.js';
import { renderReading, type Reading } from '../src/scripts/weather.js';

// The cloudy sky, the weather alerts, and the smooth lines on /weather.

const READING: Reading = {
  perSecond: { posts: 40, likes: 300, reposts: 50, follows: 20 },
  condition: 'stormy',
  source: 'station',
  records: { perSecond: 450, bluesky: 449, elsewhere: 1 },
  diversity: { index: 0.22, level: 'low', apps: 3, collections: 20 },
  apps: [
    { domain: 'tangled.sh', perSecond: 0.5, count: 30, collections: ['sh.tangled.repo'] },
    { domain: 'delve.town', perSecond: 0.2, count: 12, collections: ['town.delve.feed.post'] },
  ],
};

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('the sky gets cloudier with the diversity index', () => {
  it('is clear with no diversity, and fills up as it climbs', () => {
    expect(cloudCount(0)).toBe(0);
    expect(cloudCount(0.05)).toBe(1);
    expect(cloudCount(1)).toBe(2);
    expect(cloudCount(3)).toBe(4);
    expect(cloudCount(11)).toBe(MAX_CLOUDS);
    expect(cloudCount(40)).toBe(MAX_CLOUDS);
    const counts = [0.1, 0.5, 1, 2, 4, 8, 11].map(cloudCount);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });

  it('adds and takes away clouds at the end, keeping the rest where they are', () => {
    vi.useFakeTimers();
    const layer = document.createElement('div');
    renderClouds(layer, 3);
    const first = layer.querySelector('.weather-sky__drift')!;
    expect(layer.querySelectorAll('.weather-sky__drift')).toHaveLength(3);
    renderClouds(layer, 5);
    expect(layer.querySelector('.weather-sky__drift')).toBe(first);
    expect(layer.querySelectorAll('.weather-sky__drift')).toHaveLength(5);
    renderClouds(layer, 2);
    expect(layer.querySelectorAll('.weather-sky__drift.is-going')).toHaveLength(3);
    vi.advanceTimersByTime(1300);
    expect(layer.querySelectorAll('.weather-sky__drift')).toHaveLength(2);
    expect(layer.dataset.clouds).toBe('2');
  });

  it('the home tile and the weather report both bring the clouds', () => {
    const INDEX = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const start = INDEX.indexOf('<a class="tile tile--link home-weather"');
    document.body.innerHTML = INDEX.slice(start, INDEX.indexOf('</a>\n', INDEX.indexOf('home-weather__go', start)) + 4);
    const tile = document.querySelector<HTMLElement>('[data-weather]')!;
    renderReading(tile, READING);
    expect(tile.querySelector('[data-weather-sky]')!.getAttribute('aria-hidden')).toBe('true');
    expect(tile.querySelectorAll('[data-weather-sky] .weather-sky__drift')).toHaveLength(cloudCount(0.22));
    expect(readFileSync(resolve(process.cwd(), 'weather/index.html'), 'utf8')).toContain('data-weather-sky');
  });
});

describe('what makes a weather alert', () => {
  it('the first reading only sets the scene', () => {
    const { alerts, watch } = alertsFor(null, READING);
    expect(alerts).toEqual([]);
    expect([...watch.seen]).toEqual(['tangled.sh', 'delve.town']);
  });

  it('an app this visit has not seen blows in, once', () => {
    const first = alertsFor(null, READING).watch;
    const next: Reading = { ...READING, apps: [...READING.apps!, { domain: 'teal.fm', perSecond: 0.1, count: 1, collections: ['fm.teal.feed.play'] }] };
    const { alerts, watch } = alertsFor(first, next);
    expect(alerts).toEqual([{ kind: 'arrival', eyebrow: 'weather alert', title: 'teal.fm just blew in', sub: '1 record in the last minute: fm.teal.feed.play' }]);
    expect(alertsFor(watch, next).alerts).toEqual([]);
  });

  it('a storm rolling in, and the sky getting more mixed', () => {
    const calm = alertsFor(null, { ...READING, condition: 'breezy' }).watch;
    const { alerts } = alertsFor(calm, { ...READING, diversity: { index: 3.4, level: 'moderate', apps: 9, collections: 30 } });
    expect(alerts.map((a) => a.kind)).toEqual(['storm', 'mixed']);
    expect(alerts[0]!.sub).toBe('450 new records a second. somebody said something.');
    expect(alerts[1]!.title).toBe("the sky's getting mixed: moderate");
  });

  it('a sampled reading never brings arrivals (it is only a few seconds long)', () => {
    const first = alertsFor(null, { ...READING, source: 'sample' }).watch;
    expect(alertsFor(first, { ...READING, source: 'sample', apps: [{ domain: 'x.y', perSecond: 1, count: 1, collections: [] }] }).alerts).toEqual([]);
  });

  it('apps the station has never heard before get their own alert, after the first look', () => {
    const pushed: WeatherAlert[] = [];
    const watch = watchNewApps({ push: (a) => pushed.push(a), hushed: false, hush() {}, unhush() {}, onHushChange() {} }, 'UTC');
    const app = (domain: string) => ({ domain, firstSeen: '2026-11-03T16:46:00.000Z', creates: 1, collections: [] });
    const almanac = (apps: ReturnType<typeof app>[]) => ({ tz: 'UTC', newApps: { historyStart: null, readyAt: null, warmingUp: false, heard: 9, apps } });
    watch(almanac([app('a.app')]));
    expect(pushed).toEqual([]);
    watch(almanac([app('b.app'), app('a.app')]));
    expect(pushed).toEqual([newAppAlert('b.app', '4:46 pm')]);
  });
});

describe('the alert cards', () => {
  const alert = (title: string, kind: WeatherAlert['kind'] = 'arrival'): WeatherAlert => ({ kind, eyebrow: 'weather alert', title, sub: 'sub' });
  let region: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    document.body.innerHTML = '<div data-weather-alerts aria-live="polite"></div>';
    region = document.querySelector('[data-weather-alerts]')!;
  });
  const advance = (ms: number) => vi.advanceTimersByTime(ms);

  it('shows one at a time, then goes after a while', () => {
    const desk = createAlertDesk(region, window);
    desk.push(alert('tangled.sh just blew in'));
    expect(region.querySelectorAll('.weather-alert')).toHaveLength(1);
    expect(region.querySelector('.weather-alert__title')!.textContent).toBe('tangled.sh just blew in');
    desk.push(alert('teal.fm just blew in'));
    expect(region.querySelectorAll('.weather-alert:not(.is-leaving)')).toHaveLength(1);
    advance(ALERT_MS + 400);
    // the next waits for the gap after the first one showed
    expect(region.querySelectorAll('.weather-alert')).toHaveLength(0);
    advance(GAP_MS - ALERT_MS - 400 + 50);
    expect(region.querySelector('.weather-alert__title')!.textContent).toBe('teal.fm just blew in');
  });

  it('keeps the most important ones when lots happen at once', () => {
    const desk = createAlertDesk(region, window);
    desk.push(alert('first'));
    desk.push(alert('a.app'));
    desk.push(alert('b.app'));
    desk.push(alert('storm', 'storm'));
    const titles: string[] = [];
    for (let i = 0; i < 3; i++) {
      advance(GAP_MS);
      const shown = region.querySelector('.weather-alert:not(.is-leaving) .weather-alert__title');
      if (shown) titles.push(shown.textContent!);
    }
    expect(titles).toEqual(['storm', 'b.app']);
  });

  it('can be dismissed, and puts names on the page as text', () => {
    const desk = createAlertDesk(region, window);
    desk.push(alert('<img src=x onerror=alert(1)>'));
    expect(region.querySelector('img')).toBeNull();
    region.querySelector<HTMLButtonElement>('.weather-alert__close')!.click();
    advance(300);
    expect(region.querySelectorAll('.weather-alert')).toHaveLength(0);
  });

  it('can be hushed, and stays hushed in this browser', () => {
    const desk = createAlertDesk(region, window);
    desk.push(alert('one'));
    region.querySelector<HTMLButtonElement>('.weather-alert__hush')!.click();
    expect(desk.hushed).toBe(true);
    expect(localStorage.getItem(ALERTS_KEY)).toBe('off');
    advance(300);
    expect(region.querySelectorAll('.weather-alert')).toHaveLength(0);
    const again = createAlertDesk(region, window);
    again.push(alert('two'));
    expect(region.querySelectorAll('.weather-alert')).toHaveLength(0);
    again.unhush();
    expect(localStorage.getItem(ALERTS_KEY)).toBeNull();
  });

  it('holds still while it is being read', () => {
    const desk = createAlertDesk(region, window);
    desk.push(alert('one'));
    const card = region.querySelector<HTMLElement>('.weather-alert')!;
    advance(2000);
    card.dispatchEvent(new Event('pointerenter'));
    advance(ALERT_MS * 2);
    expect(card.isConnected).toBe(true);
    card.dispatchEvent(new Event('pointerleave'));
    advance(ALERT_MS);
    expect(card.classList.contains('is-leaving')).toBe(true);
  });
});

describe('smooth lines', () => {
  const ys = (d: string) => [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0])).filter((_, i) => i % 2 === 1);

  it('curves through every point', () => {
    const d = smoothPath([
      [0, 10],
      [10, 30],
      [20, 20],
      [30, 25],
    ]);
    expect(d.startsWith('M0,10C')).toBe(true);
    expect(d.endsWith(',30,25')).toBe(true);
    expect(d.match(/C/g)).toHaveLength(3);
  });

  it('never overshoots: every control point stays inside its stretch', () => {
    const pts: Array<[number, number]> = [
      [0, 0],
      [10, 100],
      [20, 100],
      [30, 0],
      [40, 50],
    ];
    const d = smoothPath(pts);
    const all = ys(d);
    expect(Math.max(...all)).toBeLessThanOrEqual(100);
    expect(Math.min(...all)).toBeGreaterThanOrEqual(0);
  });

  it('keeps one or two points simple', () => {
    expect(smoothPath([])).toBe('');
    expect(smoothPath([[1, 2]])).toBe('M1,2');
    expect(smoothPath([
      [0, 0],
      [10, 5],
    ])).toBe('M0,0L10,5');
  });
});

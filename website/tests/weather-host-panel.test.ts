// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { axisRange, renderChart, segments } from '../src/scripts/weather-chart.js';
import { activeStory, estimatedWords, hostStory, initHostPanel, toOneHost, type OneHost } from '../src/scripts/weather-host-panel.js';
import { renderBars } from '../src/scripts/weather-page.js';

// Tap a host, see its own weather.

const PAGE = readFileSync(resolve(process.cwd(), 'weather/index.html'), 'utf8');
const MAIN = PAGE.slice(PAGE.indexOf('<main'), PAGE.indexOf('</main>') + '</main>'.length);

const EUROSKY: OneHost = {
  hostname: 'eurosky.social',
  bluesky: false,
  days: [
    { day: '2026-10-08', accounts: 36273, estimated: true },
    { day: '2026-10-21', accounts: 37979, estimated: true },
    { day: '2026-10-22', accounts: 38036, estimated: false },
  ],
};

describe('the chart axis', () => {
  it('starts at zero by default, and fits a share that moves by hundredths', () => {
    expect(axisRange([3, 7])).toEqual([0, 10]);
    expect(axisRange([1.46, 1.51], false)).toEqual([1.45, 1.55]);
    const [lo, hi] = axisRange([36273, 38036], false);
    expect(lo).toBeLessThanOrEqual(36273);
    expect(hi).toBeGreaterThanOrEqual(38036);
    expect(lo).toBeGreaterThan(0);
    expect(axisRange([5, 5], false)[0]).toBeLessThanOrEqual(5);
    expect(axisRange([], false)).toEqual([0, 1]);
  });
});

describe('estimated points on a chart', () => {
  const H = 3600_000;
  // the backfill's last day (one estimate at 23:59:59), then the station's hourly censuses from 15 hours later
  const points = [
    { t: 0, v: 1.49, estimated: true },
    { t: 24 * H, v: 1.5, estimated: true },
    { t: 39 * H, v: 1.51 },
    { t: 40 * H, v: 1.51 },
    { t: 41 * H, v: 1.52 },
  ];

  it('reaches across the gap between estimates and the first census, but not between two censuses', () => {
    expect(segments(points, H)).toHaveLength(1);
    expect(segments([{ t: 0, v: 1 }, { t: 15 * H, v: 2 }], H)).toHaveLength(2);
    // a day and a half is as far as it reaches
    expect(segments([{ t: 0, v: 1, estimated: true }, { t: 40 * H, v: 2 }], H)).toHaveLength(2);
  });

  it('dashes the estimated stretch and draws the measured one solid', () => {
    const host = document.createElement('div');
    document.body.append(host);
    renderChart(host, points, { label: 'share', color: 'red', format: String, formatTime: String, stepMs: H, fromZero: false });
    expect(host.querySelectorAll('.weather-chart__line--projected')).toHaveLength(1);
    expect(host.querySelectorAll('.weather-chart__line:not(.weather-chart__line--projected)')).toHaveLength(1);
    expect(host.querySelectorAll('.weather-chart__area')).toHaveLength(1);
  });
});

describe('a host in words', () => {
  it('checks the answer', () => {
    expect(toOneHost({ host: { ...EUROSKY, days: [...EUROSKY.days, { day: 'x', accounts: 1 }] } })).toEqual(EUROSKY);
    expect(toOneHost({ host: { hostname: '<script>', days: [] } })).toBeNull();
    expect(toOneHost(null)).toBeNull();
  });

  it('tells its story, and owns up to estimated days', () => {
    expect(hostStory(EUROSKY)).toBe('38,036 accounts hosted on oct 22, active or not. +1,763 (+4.9%) since oct 8, the first day i have for it.');
    expect(hostStory({ ...EUROSKY, days: EUROSKY.days.slice(-1) })).toBe("38,036 accounts hosted on oct 22, active or not. that's the only day i've seen it so far.");
    expect(hostStory({ ...EUROSKY, days: [] })).toMatch(/haven't seen/);
    expect(estimatedWords(EUROSKY)).toBe('days up to oct 21 are estimated from the plc directory, from before i kept count of each host.');
    expect(estimatedWords({ ...EUROSKY, days: EUROSKY.days.slice(-1) })).toBe('');
  });
});

describe('who is active on a host', () => {
  it('says how many wrote something on the latest day counted, and charts it from two days', () => {
    expect(activeStory(EUROSKY)).toBe('');
    const counted = { ...EUROSKY, days: EUROSKY.days.map((d, i) => (i ? { ...d, active: 1000 + i } : d)) };
    expect(activeStory(counted)).toBe('1,002 accounts wrote something on oct 22 (2.6% of them).');
  });
});

describe('the host panel', () => {
  beforeEach(() => {
    document.body.innerHTML = MAIN;
  });

  it('opens on a tap or Enter on a host in a list, reads its history once, and fills in', async () => {
    const report = document.querySelector<HTMLElement>('[data-weather-report]')!;
    const fetchImpl = vi.fn(async () => Response.json({ host: EUROSKY }));
    initHostPanel(report, fetchImpl as unknown as typeof fetch);
    const list = report.querySelector<HTMLElement>('[data-h-top]')!;
    renderBars(list, [{ label: 'eurosky.social', perSecond: 38036, count: 38036, value: '38k' }], undefined);
    await Promise.resolve(); // the observer marks the new row
    const row = list.querySelector<HTMLElement>('li')!;
    expect(row.tabIndex).toBe(0);
    expect(row.getAttribute('aria-label')).toBe('eurosky.social: see its history');
    row.querySelector<HTMLElement>('.weather-bars__label')!.click();
    const dialog = document.querySelector<HTMLDialogElement>('[data-host-dialog]')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.querySelector('[data-hp-name]')!.textContent).toBe('eurosky.social');
    await vi.waitFor(() => expect(dialog.querySelector('[data-hp-story]')!.textContent).toMatch(/^38,036 accounts/));
    expect(fetchImpl).toHaveBeenCalledWith('/api/weather-history?host=eurosky.social', expect.anything());
    expect(dialog.querySelector<HTMLAnchorElement>('[data-hp-visit]')!.href).toBe('https://eurosky.social/');
    expect(dialog.querySelector<HTMLElement>('.weather-chart-card')!.hidden).toBe(false);
    dialog.querySelector<HTMLElement>('[data-hp-close]')!.click();
    expect(dialog.hasAttribute('open')).toBe(false);
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(dialog.hasAttribute('open')).toBe(true);
    await vi.waitFor(() => expect(dialog.querySelector('[data-hp-story]')!.textContent).toMatch(/^38,036/));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('apologizes when the history does not come', async () => {
    const report = document.querySelector<HTMLElement>('[data-weather-report]')!;
    initHostPanel(report, (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch);
    const list = report.querySelector<HTMLElement>('[data-h-new]')!;
    renderBars(list, [{ label: 'fresh.example', perSecond: 3, count: 3, value: '3' }], undefined);
    await Promise.resolve();
    list.querySelector<HTMLElement>('li')!.click();
    const dialog = document.querySelector<HTMLDialogElement>('[data-host-dialog]')!;
    await vi.waitFor(() => expect(dialog.querySelector('[data-hp-story]')!.textContent).toMatch(/couldn't read/));
  });
});

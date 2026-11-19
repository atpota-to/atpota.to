// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { axisRange, renderChart, segments } from '../src/scripts/weather-chart.js';
import { activeStory, estimatedWords, hostStory, initHostPanel, moveStory, toOneHost, type OneHost } from '../src/scripts/weather-host-panel.js';
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
  moves: [],
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

describe('who moved to a host and away', () => {
  const NOW = Date.parse('2026-11-10T18:00:00.000Z');
  // tophhie's accounts live on pds.tophhie.cloud
  const TOPHHIE: OneHost = {
    hostname: 'pds.tophhie.cloud',
    bluesky: false,
    days: [{ day: '2026-11-10', accounts: 611, estimated: false }],
    movesSince: '2026-10-08',
    moves: [
      // before the last 30 days: not counted
      { day: '2026-10-09', arrived: [], left: [{ to: 'bluesky', accounts: 5 }] },
      { day: '2026-11-08', arrived: [{ from: 'bluesky', accounts: 1 }], left: [{ to: 'eurosky.social', accounts: 3 }] },
      { day: '2026-11-09', arrived: [], left: [{ to: 'blacksky.app', accounts: 1 }, { to: 'eurosky.social', accounts: 1 }] },
      { day: '2026-11-10', arrived: [], left: [{ to: 'bluesky', accounts: 1 }] },
    ],
  };

  it('adds up the last 30 days by the other host, the most first', () => {
    expect(moveStory(TOPHHIE, NOW)).toBe("over the last 30 days, 1 account moved here (1 from bluesky's hosts) and 6 moved away (4 to eurosky.social, 1 to blacksky.app and 1 to bluesky's hosts).");
    const busy: OneHost = { ...TOPHHIE, moves: [{ day: '2026-11-10', arrived: [{ from: 'bluesky', accounts: 38 }, { from: 'a.example', accounts: 2 }, { from: 'b.example', accounts: 2 }, { from: 'c.example', accounts: 1 }, { from: 'd.example', accounts: 1 }], left: [] }] };
    expect(moveStory(busy, NOW)).toBe("over the last 30 days, 44 accounts moved here (38 from bluesky's hosts, 2 from a.example, 2 from b.example and 2 from 2 other hosts) and nobody moved away.");
  });

  it('says from when, if the station has kept moves for less than that, and when nobody moved', () => {
    expect(moveStory({ ...TOPHHIE, movesSince: '2026-11-09', moves: TOPHHIE.moves.slice(2) }, NOW)).toBe("since nov 9, nobody moved here and 3 moved away (1 to blacksky.app, 1 to bluesky's hosts and 1 to eurosky.social).");
    expect(moveStory({ ...TOPHHIE, moves: [] }, NOW)).toBe('over the last 30 days, nobody moved here from another host, or away.');
  });

  it('says nothing when it does not know: no moves kept yet, or one of bluesky\'s own hosts', () => {
    expect(moveStory({ ...TOPHHIE, movesSince: undefined }, NOW)).toBe('');
    expect(moveStory({ ...TOPHHIE, bluesky: true }, NOW)).toBe('');
  });

  it('checks the moves in the answer', () => {
    const h = toOneHost({ host: { ...TOPHHIE, movesSince: 'soon', moves: [{ day: '2026-11-10', arrived: [{ from: '<b>x</b>', accounts: 1 }, { from: 'bluesky', accounts: 2 }, { from: 'eurosky.social', accounts: 0 }], left: 'nope' }, { day: 'x', arrived: [], left: [] }] } })!;
    expect(h.moves).toEqual([{ day: '2026-11-10', arrived: [{ from: 'bluesky', accounts: 2 }], left: [] }]);
    expect('movesSince' in h).toBe(false);
    // an answer from before moves were kept still makes a host
    expect(toOneHost({ host: { hostname: 'eurosky.social', bluesky: false, days: [] } })).toEqual({ hostname: 'eurosky.social', bluesky: false, days: [], moves: [] });
  });
});

describe('the host panel', () => {
  beforeEach(() => {
    document.body.innerHTML = MAIN;
  });

  it('says who moved in and away under the host\'s story, and hides the line when it has nothing', async () => {
    const report = document.querySelector<HTMLElement>('[data-weather-report]')!;
    const from = report.querySelector<HTMLElement>('[data-p-from]')!;
    // the list of hosts movers left is one to tap, like the others
    expect(from.hasAttribute('data-host-list')).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    const host = { hostname: 'pds.tophhie.cloud', bluesky: false, days: [{ day: today, accounts: 611, estimated: false }], movesSince: '2026-10-08', moves: [{ day: today, arrived: [], left: [{ to: 'eurosky.social', accounts: 2 }] }] };
    const answers: Record<string, unknown> = { 'pds.tophhie.cloud': host, 'eurosky.social': EUROSKY };
    initHostPanel(report, (async (url: string) => Response.json({ host: answers[new URL(url, 'https://atpota.to').searchParams.get('host')!] })) as unknown as typeof fetch);
    renderBars(from, [{ label: 'pds.tophhie.cloud', perSecond: 2, count: 2, value: '2 movers' }, { label: 'eurosky.social', perSecond: 1, count: 1, value: '1 mover' }], undefined);
    await Promise.resolve();
    const dialog = document.querySelector<HTMLDialogElement>('[data-host-dialog]')!;
    const line = dialog.querySelector<HTMLElement>('[data-hp-moves]')!;
    from.querySelectorAll<HTMLElement>('li')[0]!.click();
    await vi.waitFor(() => expect(line.textContent).toBe('over the last 30 days, nobody moved here and 2 moved away (2 to eurosky.social).'));
    expect(line.hidden).toBe(false);
    // a host with no moves kept: the line goes away again
    from.querySelectorAll<HTMLElement>('li')[1]!.click();
    expect(line.hidden).toBe(true);
    await vi.waitFor(() => expect(dialog.querySelector('[data-hp-story]')!.textContent).toMatch(/^38,036 accounts/));
    expect(line.hidden).toBe(true);
    expect(line.textContent).toBe('');
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
    expect(dialog.querySelector<HTMLAnchorElement>('[data-hp-visit]')!.href).toBe('https://aturi.to/explore/pds/eurosky.social');
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

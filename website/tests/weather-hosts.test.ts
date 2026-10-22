// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { hostBars, hostRange, newHostsWords, renderHostTrends, toHostHistory, type HostHistory } from '../src/scripts/weather-hosts.js';
import { fetchHistory, renderBars } from '../src/scripts/weather-page.js';

// Where accounts live, over time: the hosts tile's charts and lists.

const PAGE = readFileSync(resolve(process.cwd(), 'weather/index.html'), 'utf8');
const MAIN = PAGE.slice(PAGE.indexOf('<main'), PAGE.indexOf('</main>') + '</main>'.length);
const NOW = Date.parse('2026-10-29T12:00:00.000Z');

const point = (t: string, active: number, index = 7.48) => ({ t, active, bluesky: 90, independent: active - 90, writing: 700, accountsBluesky: 23767508, accountsIndependent: 363866, share: 1.51, spread: 24.54, index });

const HOSTS: HostHistory = {
  bucket: 'hour',
  since: '2026-10-24',
  points: [point('2026-10-22T13:00:00.000Z', 1887), point('2026-10-29T11:00:00.000Z', 1902, 7.6)],
  newHosts: 7,
  new: [
    { hostname: 'fresh.example', accounts: 40, first: '2026-10-25' },
    { hostname: 'tiny.example', accounts: 2, first: '2026-10-28' },
  ],
  growing: [{ hostname: 'blacksky.app', accounts: 42900, prevAccounts: 42366 }],
};

let part: HTMLElement;
const bars = (list: HTMLElement, b: Parameters<typeof renderBars>[1]) => renderBars(list, b, undefined);

beforeEach(() => {
  document.body.innerHTML = MAIN;
  part = document.querySelector<HTMLElement>('[data-h-trends]')!;
});

describe('where accounts live, over time', () => {
  it('shows a day for now and the last hour, and the lens window otherwise', () => {
    expect(hostRange('now')).toBe('day');
    expect(hostRange('hour')).toBe('day');
    expect(hostRange('week')).toBe('week');
    expect(hostRange('month')).toBe('month');
  });

  it('checks the history answer, dropping hostnames that do not check out', () => {
    const h = toHostHistory({ ...HOSTS, new: [...HOSTS.new, { hostname: '<b>x</b>.com', accounts: 1, first: '2026-10-28' }], points: [...HOSTS.points, { t: 'nope' }] })!;
    expect(h.new.map((x) => x.hostname)).toEqual(['fresh.example', 'tiny.example']);
    expect(h.points).toHaveLength(2);
    expect(toHostHistory({ bucket: 'fortnight', points: [], new: [], growing: [] })).toBeNull();
    expect(toHostHistory(null)).toBeNull();
  });

  it('reads them from the history feed alongside the rest', async () => {
    const body = { range: 'week', points: [], total: { t: '2026-10-29T12:00:00.000Z', seconds: 1, creates: 0, bluesky: 0, elsewhere: 0, posts: 0, likes: 0, reposts: 0, follows: 0, updates: 0, deletes: 0, identity: 0, account: 0 }, hosts: HOSTS };
    const h = await fetchHistory('week', (async () => Response.json(body)) as typeof fetch);
    expect(h?.hosts?.newHosts).toBe(7);
  });

  it('stays hidden with nothing kept yet', () => {
    renderHostTrends(part, undefined, 'day', bars, NOW);
    expect(part.hidden).toBe(true);
    renderHostTrends(part, { ...HOSTS, points: [] }, 'day', bars, NOW);
    expect(part.hidden).toBe(true);
  });

  it('draws the charts and lists the new and growing hosts', () => {
    renderHostTrends(part, HOSTS, 'week', bars, NOW);
    expect(part.hidden).toBe(false);
    expect(part.querySelector('[data-h-range]')!.textContent).toBe('the last 7 days');
    expect(part.querySelector('[data-h-chart="active"] svg')).not.toBeNull();
    expect(part.querySelector('[data-h-chart="index"] svg')).not.toBeNull();
    expect([...part.querySelectorAll('[data-h-new] .weather-bars__label')].map((el) => el.textContent)).toEqual(['fresh.example', 'tiny.example']);
    expect(part.querySelector('[data-h-new-note]')!.textContent).toBe('7 new independent hosts in the last 7 days, the 5 with the most accounts.');
    expect(part.querySelector('[data-h-growing] .weather-bars__value')!.textContent).toBe('+534');
    // the week reaches back before the station kept hosts
    const since = part.querySelector<HTMLElement>('[data-h-since]')!;
    expect(since.hidden).toBe(false);
    expect(since.textContent).toMatch(/^i started keeping track of hosts on october 24/);
  });

  it('says so when nothing is new', () => {
    expect(newHostsWords({ ...HOSTS, newHosts: 0 }, 'day')).toBe('no new independent hosts in the last 24 hours.');
    expect(newHostsWords({ ...HOSTS, newHosts: 1 }, 'day')).toBe('1 new independent host in the last 24 hours.');
    expect(hostBars(HOSTS.growing, true)).toEqual([{ label: 'blacksky.app', perSecond: 534, count: 534, value: '+534' }]);
  });
});

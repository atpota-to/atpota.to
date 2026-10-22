// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { compassOf, hostBars, hostRange, identityDayWords, newHostsWords, renderHostTrends, renderIdentities, signed, smogOf, toHostHistory, type HostHistory, type IdentityDay } from '../src/scripts/weather-hosts.js';
import { fetchHistory, renderBars, renderHostCensus } from '../src/scripts/weather-page.js';

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
  daily: [
    { day: '2026-10-24', active: 1887, change: null, joined: null, left: null, estimated: true },
    { day: '2026-10-25', active: 1890, change: 3, joined: 5, left: 2 },
    { day: '2026-10-26', active: 1884, change: -6, joined: 1, left: 7 },
    { day: '2026-10-29', active: 1886, change: 0, joined: 0, left: 0 },
  ],
  identities: [],
};

const idDay = (day: string, extra: Partial<IdentityDay> = {}): IdentityDay => ({ day, ops: 170066, createdBluesky: 9946, createdIndependent: 4383, createdUnlisted: 150845, createdCustomHandle: 122, movedOut: 19, movedIn: 0, movedBetween: 1, deleted: 1, ...extra });

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

  it('goes day by day: a chart of hosts joining, and a table newest first', () => {
    renderHostTrends(part, HOSTS, 'week', bars, NOW);
    const card = part.querySelector('[data-h-chart="joined"]')!.closest<HTMLElement>('.weather-chart-card')!;
    expect(card.hidden).toBe(false);
    expect(part.querySelector('[data-h-chart="joined"] svg')).not.toBeNull();
    expect(part.querySelector<HTMLElement>('[data-h-days-wrap]')!.hidden).toBe(false);
    const rows = [...part.querySelectorAll('[data-h-days] tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent));
    expect(rows).toHaveLength(4);
    expect(rows[0]![0]).toMatch(/\(so far\)$/); // the 29th is today
    expect(rows[0]!.slice(1)).toEqual(['1,886', '0', '0', '0']);
    expect(rows[1]!.slice(1)).toEqual(['1,884', '−6', '+1', '−7']);
    expect(rows[3]!.slice(1)).toEqual(['1,887', '–', '–', '–']);
    expect(rows[3]![0]).toMatch(/ ≈$/); // estimated
    expect(rows[1]![0]).not.toMatch(/≈/);
    expect(part.querySelector('[data-h-days] tbody tr:nth-child(2) td:nth-of-type(2)')!.getAttribute('data-trend')).toBe('down');
  });

  it('keeps the joining chart back until there are two days to draw', () => {
    renderHostTrends(part, { ...HOSTS, daily: HOSTS.daily.slice(0, 2) }, 'day', bars, NOW);
    expect(part.querySelector('[data-h-chart="joined"]')!.closest<HTMLElement>('.weather-chart-card')!.hidden).toBe(true);
    expect(part.querySelector<HTMLElement>('[data-h-days-wrap]')!.hidden).toBe(false);
    renderHostTrends(part, { ...HOSTS, daily: [] }, 'day', bars, NOW);
    expect(part.querySelector<HTMLElement>('[data-h-days-wrap]')!.hidden).toBe(true);
  });

  it('reads the daily rows, dropping ones that do not check out', () => {
    const h = toHostHistory({ ...HOSTS, daily: [...HOSTS.daily, { day: 'soon', active: 1 }, { day: '2026-10-30', active: -1, change: 0, joined: 0, left: 0 }] })!;
    expect(h.daily).toHaveLength(4);
    expect(toHostHistory({ ...HOSTS, daily: undefined })!.daily).toEqual([]);
    expect([signed(3), signed(-2), signed(0), signed(null)]).toEqual(['+3', '−2', '0', '–']);
  });

  it('says so when nothing is new', () => {
    expect(newHostsWords({ ...HOSTS, newHosts: 0 }, 'day')).toBe('no new independent hosts in the last 24 hours.');
    expect(newHostsWords({ ...HOSTS, newHosts: 1 }, 'day')).toBe('1 new independent host in the last 24 hours.');
    expect(hostBars(HOSTS.growing, true)).toEqual([{ label: 'blacksky.app', perSecond: 534, count: 534, value: '+534' }]);
  });
});

describe('where the atmosphere lives: the identity tiles', () => {
  let report: HTMLElement;
  beforeEach(() => {
    report = document.querySelector<HTMLElement>('[data-weather-report]')!;
  });
  const text = (sel: string) => report.querySelector(sel)!.textContent;

  it('stays hidden without a day, and fills all three from the last one', () => {
    renderIdentities(report, [], NOW);
    expect(report.querySelector<HTMLElement>('[data-p-arrivals]')!.hidden).toBe(true);
    renderIdentities(report, [idDay('2026-10-28', { movedOut: 30, movedIn: 2 }), idDay('2026-10-29')], NOW);
    for (const sel of ['[data-p-arrivals]', '[data-p-winds]', '[data-p-smog]']) expect(report.querySelector<HTMLElement>(sel)!.hidden).toBe(false);
    expect(text('[data-p-day]')).toBe('today so far (utc)');
    expect(text('[data-p-signups]')).toBe('14,329');
    expect(text('[data-p-indep]')).toBe('4,383');
    expect(text('[data-p-own]')).toBe('31% signed up somewhere other than bluesky, and 122 new accounts started out with a handle on their own domain.');
    expect(report.querySelector('[data-p-chart="arrivals"] svg')).not.toBeNull();
    expect(text('[data-p-compass]')).toBe('blowing out of bluesky, 19 to 0');
    expect(report.querySelector('[data-p-chart="winds"] svg')).not.toBeNull();
    expect(text('[data-p-week]')).toBe('over the last 2 days: 49 accounts moved out, 2 moved back.');
    expect(text('[data-p-smog-level]')).toBe('thick smog');
    expect(text('[data-p-smog-line]')).toMatch(/^for every account that signed up where the relay listens, 11 signed up somewhere it doesn't/);
    expect(text('[data-p-deleted]')).toBe('1 account deleted itself.');
  });

  it('keeps the chart back with only one day', () => {
    renderIdentities(report, [idDay('2026-10-29')], NOW);
    expect(report.querySelector<HTMLElement>('[data-p-arrivals-card]')!.hidden).toBe(true);
  });

  it('reads the wind and the air in words', () => {
    expect(compassOf(0, 0)).toMatch(/^still air/);
    expect(compassOf(3, 3)).toBe('calm: 3 each way');
    expect(compassOf(1, 4)).toBe('blowing back to bluesky, 4 to 1');
    expect(smogOf(idDay('d', { createdUnlisted: 0 })).level).toBe('clear');
    expect(smogOf(idDay('d', { createdUnlisted: 2000 })).level).toBe('hazy');
    expect(smogOf(idDay('d', { createdBluesky: 0, createdIndependent: 0, createdUnlisted: 0 })).share).toBe(0);
    expect(identityDayWords('2026-10-28', NOW)).toBe('yesterday (utc)');
  });

  it('reads identity days from the history, dropping ones that do not check out', () => {
    const h = toHostHistory({ ...HOSTS, identities: [idDay('2026-10-29'), { day: '2026-10-30', ops: 'lots' }] })!;
    expect(h.identities).toHaveLength(1);
    expect(toHostHistory({ ...HOSTS, identities: undefined })!.identities).toEqual([]);
  });
});

describe('where the atmosphere lives: the census tiles', () => {
  const census = {
    measuredAt: '2026-10-29T11:50:00.000Z',
    listed: 6442,
    active: 1888,
    bluesky: 90,
    independent: 1798,
    writing: null,
    accounts: { bluesky: 23767508, independent: 363866 },
    diversity: { index: 7.48, share: 1.51, spread: 24.54 },
    top: [],
  };

  it('stays hidden without the census extras, and draws sizes, domains and the roll call with them', () => {
    const report = document.querySelector<HTMLElement>('[data-weather-report]')!;
    renderHostCensus(report, census);
    expect(report.querySelector<HTMLElement>('[data-p-sizes]')!.hidden).toBe(true);
    renderHostCensus(report, {
      ...census,
      statuses: { active: 1888, idle: 310, offline: 4174, throttled: 0, banned: 70, other: 0 },
      sizes: [8, 764, 737, 204, 58, 18, 9],
      tlds: [{ tld: 'com', hosts: 257, accounts: 7455 }, { tld: 'social', hosts: 110, accounts: 53643 }],
    });
    const labels = (sel: string) => [...report.querySelectorAll(`${sel} .weather-bars__label`)].map((el) => el.textContent);
    expect(labels('[data-p-size-list]')).toEqual(['just one person', 'a household (2 to 10)', 'a village (11 to 100)', 'a town (101 to 1,000)', 'a city (1,001 to 10,000)', 'a metropolis (10,000+)']);
    expect(report.querySelector('[data-p-solo]')!.textContent).toBe('764 independent hosts hold just one account: someone running their own.');
    expect(labels('[data-p-tld-list]')).toEqual(['.com', '.social']);
    expect(report.querySelector('[data-p-tld-lede]')!.textContent).toBe('.com is the most popular ending, on 257 of 1,798 independent hosts.');
    // throttled (0) is left out
    expect(labels('[data-p-roll-list]')).toEqual(['active', 'idle', 'offline', 'banned']);
    expect(report.querySelector<HTMLElement>('[data-p-rollcall]')!.hidden).toBe(false);
  });
});
